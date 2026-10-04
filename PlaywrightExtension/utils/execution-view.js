// Pure helpers that turn a run (an "execution" from the platform API) into what the side
// panel shows. No DOM and no chrome.* calls, so they are tested with node --test.

const STATUS = {
  QUEUED: { label: 'Queued', tone: 'wait' },
  RUNNING: { label: 'Running', tone: 'run' },
  PASSED: { label: 'Passed', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
  ABORTED: { label: 'Aborted', tone: 'off' },
  ERROR: { label: 'Error', tone: 'bad' },
};

const UNFINISHED = new Set(['QUEUED', 'RUNNING']);

// True once a run can no longer change. A status this code does not know counts as final,
// so polling always ends.
export function isFinal(status) {
  return !UNFINISHED.has(status);
}

// { label, className } for a status. Both come from the fixed table above, never from the
// server's text.
export function statusView(status) {
  const known = typeof status === 'string' && Object.hasOwn(STATUS, status) ? STATUS[status] : null;
  return known
    ? { label: known.label, className: `run-status run-${known.tone}` }
    : { label: 'Unknown', className: 'run-status run-off' };
}

// "42s", "1m 05s", "1h 02m", or "" when the run has no duration yet.
export function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// "3 tests: 2 passed, 1 failed", or "" when the build reported no test.
export function countsText(execution) {
  const total = Number(execution?.total) || 0;
  if (total <= 0) return '';
  const parts = [`${Number(execution.passed) || 0} passed`, `${Number(execution.failed) || 0} failed`];
  const skipped = Number(execution.skipped) || 0;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${total} ${total === 1 ? 'test' : 'tests'}: ${parts.join(', ')}`;
}

// One line for the recent runs list: "#12 · Passed · v2 · 1m 05s".
export function runSummary(execution) {
  const parts = [`#${execution.id}`, statusView(execution.status).label, `v${execution.scriptVersion}`];
  const duration = durationText(execution.durationMs);
  if (duration) parts.push(duration);
  return parts.join(' · ');
}

// The address to link to, or null when no link may be offered. Only http and https are ever
// linked. When the panel knows the Jenkins address (an ADMIN's panel does), the link must
// also be under it.
export function safeJenkinsLink(url, jenkinsBaseUrl = '') {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const base = String(jenkinsBaseUrl || '').replace(/\/+$/, '');
  // The slash matters: "http://ci:8080@evil.example/" starts with "http://ci:8080" but not with "http://ci:8080/".
  if (base && !url.startsWith(`${base}/`)) return null;
  return parsed.href;
}

// The links the status card offers: [{ label, href }]. The reports are not among them: Jenkins
// shows an archived report with its scripts switched off, so they open from the platform
// (see reportLinks).
export function runLinks(execution, jenkinsBaseUrl = '') {
  const links = [];
  const build = safeJenkinsLink(execution?.buildUrl, jenkinsBaseUrl);
  if (build) links.push({ label: 'Open in Jenkins', href: build });
  return links;
}

// `overview` is the run's own page: the script, the result of each test, and both reports.
const REPORTS = [
  ['overview', 'Run report', ''],
  ['playwright', 'Playwright report', 'playwright/index\\.html'],
  ['allure', 'Allure report', 'allure/index\\.html'],
];

// The report links of a run: [{ label, href }]. `reports` is the platform's answer,
// { playwright, allure }, each a path on the platform or null. Only a path of the shape the
// platform makes is linked, and only under the platform's own address.
export function reportLinks(reports, platformUrl) {
  const base = String(platformUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(base)) return [];
  const links = [];
  for (const [kind, label, file] of REPORTS) {
    const path = reports?.[kind];
    if (typeof path !== 'string') continue;
    if (!new RegExp(`^/api/reports/[A-Za-z0-9._-]+/${file}$`).test(path)) continue;
    links.push({ label, href: base + path });
  }
  return links;
}

// The address of a page the platform serves for a run or for several runs, or null. `path`
// must have the shape the platform makes for that kind of page, and the link stays under
// the platform's own address.
function platformPage(path, platformUrl, shape) {
  const base = String(platformUrl || '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/]+/i.test(base)) return null;
  if (typeof path !== 'string' || !shape.test(path)) return null;
  return base + path;
}

// Where a finished run's own report page opens (the run's `runReportUrl`), or null.
export function runReportLink(execution, platformUrl) {
  return platformPage(execution?.runReportUrl, platformUrl, /^\/api\/reports\/[A-Za-z0-9._-]+\/$/);
}

// Where the page for scripts run together opens, or null.
export function batchReportLink(path, platformUrl) {
  return platformPage(path, platformUrl, /^\/api\/batch-reports\/b[A-Za-z0-9._-]+\/$/);
}

// One run as a row of a list: { label, className, detail, links: [{ label, href }] }.
// `entry` is { execution, error }: the run, or why it could not be started. Used for the
// run history of a script and for scripts run together.
export function runRow(entry, { platformUrl = '', jenkinsBaseUrl = '', withVersion = false, withId = true, when = '' } = {}) {
  const run = entry?.execution;
  if (!run) {
    return entry?.error
      ? { label: 'Not started', className: 'run-status run-off', detail: String(entry.error), links: [] }
      : { label: 'Starting', className: 'run-status run-wait', detail: 'Asking Jenkins to start the run…', links: [] };
  }
  const status = statusView(run.status);
  const parts = withId ? [`#${run.id}`] : [];
  // Scripts run together are one run: the row says how many, not one version.
  const together = Array.isArray(run.scripts) ? run.scripts.length : 1;
  if (together > 1) parts.push(`${together} scripts together`);
  else if (withVersion) parts.push(`v${run.scriptVersion}`);
  if (run.buildNumber) parts.push(`build ${run.buildNumber}`);
  parts.push(countsText(run) || (isFinal(run.status) ? 'no test ran' : ''), durationText(run.durationMs), when);
  const links = [];
  const report = runReportLink(run, platformUrl);
  if (report) links.push({ label: 'Run report', href: report });
  const build = safeJenkinsLink(run.buildUrl, jenkinsBaseUrl);
  if (build) links.push({ label: 'Jenkins', href: build });
  return { label: status.label, className: status.className, detail: parts.filter(Boolean).join(' · '), links };
}

// One line for scripts run together: "4 scripts: 1 running, 2 passed, 1 not started".
// `entries` is [{ execution, error }]: the run of each script, or why it could not start.
export function batchSummary(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return '';
  const counts = new Map();
  for (const entry of entries) {
    const label = entry?.execution ? statusView(entry.execution.status).label.toLowerCase() : entry?.error ? 'not started' : 'starting';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  const order = ['starting', 'queued', 'running', 'passed', 'failed', 'error', 'aborted', 'unknown', 'not started'];
  const parts = order.filter((label) => counts.has(label)).map((label) => `${counts.get(label)} ${label}`);
  return `${entries.length} ${entries.length === 1 ? 'script' : 'scripts'}: ${parts.join(', ')}`;
}

// What the Projects tab offers for changing things: { manageProjects, editScript }.
// Projects are added, renamed, and deleted by an ADMIN only. A script is edited by ADMIN
// and USER, in an active project.
export function manageControls({ role, projectStatus }) {
  const canWrite = role === 'ADMIN' || role === 'USER';
  return {
    manageProjects: role === 'ADMIN',
    editScript: canWrite && projectStatus === 'ACTIVE',
  };
}

const RESULT = {
  PASSED: { label: 'Passed', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
  SKIPPED: { label: 'Skipped', tone: 'off' },
};

// "850ms", "3.4s", "1m 05s", or "" for a test that took no time (a skipped one).
function testDurationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return durationText(ms);
}

const ARTIFACTS = [
  ['screenshotUrl', 'Screenshot'],
  ['videoUrl', 'Video'],
  ['traceUrl', 'Trace'],
];

// The tests of a run as rows for the status card:
// [{ label, className, name, duration, error, links: [{ label, href }] }].
// Labels and classes come from the fixed tables above, never from the server's text, and a
// link to a file of the build is offered only when it is a safe Jenkins link.
// With `withScript`, a test's name starts with the script it belongs to: for scripts run together.
export function resultRows(items, jenkinsBaseUrl = '', withScript = false) {
  if (!Array.isArray(items)) return [];
  return items.map((result) => {
    const known = typeof result?.status === 'string' && Object.hasOwn(RESULT, result.status) ? RESULT[result.status] : null;
    const links = [];
    for (const [field, label] of ARTIFACTS) {
      const href = safeJenkinsLink(result?.[field], jenkinsBaseUrl);
      if (href) links.push({ label, href });
    }
    return {
      label: known ? known.label : 'Unknown',
      className: `run-status run-${known ? known.tone : 'off'}`,
      name: (withScript && typeof result?.scriptName === 'string' ? `${result.scriptName} › ` : '') + String(result?.name ?? ''),
      duration: testDurationText(result?.durationMs),
      error: typeof result?.errorMessage === 'string' ? result.errorMessage : '',
      links,
    };
  });
}

// Whether the script view offers Delete: { showDelete, deleteDisabled }. Delete is for ADMIN
// and USER, in an active project, and waits for an unfinished run to end.
export function deleteControls({ role, projectStatus, execution }) {
  const canWrite = role === 'ADMIN' || role === 'USER';
  return {
    showDelete: canWrite && projectStatus === 'ACTIVE',
    deleteDisabled: Boolean(execution) && !isFinal(execution.status),
  };
}

// What the script view offers: { showRun, runDisabled, showStop, note }. Run is for ADMIN and
// USER, in an active project, once Jenkins is set up. `note` says why Run is missing.
export function runControls({ role, projectStatus, jenkinsConfigured, execution }) {
  const canWrite = role === 'ADMIN' || role === 'USER';
  const active = projectStatus === 'ACTIVE';
  const busy = Boolean(execution) && !isFinal(execution.status);
  let note = '';
  if (canWrite && !active) note = 'This project is archived, so its scripts cannot be run.';
  else if (canWrite && !jenkinsConfigured) {
    note = 'Jenkins is not set up yet. An administrator must set it up under Settings → Jenkins.';
  }
  return {
    showRun: canWrite && active && Boolean(jenkinsConfigured),
    runDisabled: busy,
    showStop: canWrite && busy,
    note,
  };
}
