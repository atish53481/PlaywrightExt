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

// The links the status card offers: [{ label, href }]. The report exists only after the tests ran.
export function runLinks(execution, jenkinsBaseUrl = '') {
  const links = [];
  const build = safeJenkinsLink(execution?.buildUrl, jenkinsBaseUrl);
  if (build) links.push({ label: 'Open in Jenkins', href: build });
  const testsRan = execution?.status === 'PASSED' || execution?.status === 'FAILED';
  const report = testsRan ? safeJenkinsLink(execution.reportUrl, jenkinsBaseUrl) : null;
  if (report) links.push({ label: 'Open report', href: report });
  return links;
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
export function resultRows(items, jenkinsBaseUrl = '') {
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
      name: String(result?.name ?? ''),
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
