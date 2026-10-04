import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  batchSummary,
  countsText,
  durationText,
  isFinal,
  manageControls,
  reportLinks,
  runControls,
  runLinks,
  runSummary,
  safeJenkinsLink,
  statusView,
} from '../utils/execution-view.js';

describe('execution view', () => {
  it('names every status and gives it one of the fixed classes', () => {
    assert.deepEqual(statusView('QUEUED'), { label: 'Queued', className: 'run-status run-wait' });
    assert.deepEqual(statusView('RUNNING'), { label: 'Running', className: 'run-status run-run' });
    assert.deepEqual(statusView('PASSED'), { label: 'Passed', className: 'run-status run-ok' });
    assert.deepEqual(statusView('FAILED'), { label: 'Failed', className: 'run-status run-bad' });
    assert.deepEqual(statusView('ABORTED'), { label: 'Aborted', className: 'run-status run-off' });
    assert.deepEqual(statusView('ERROR'), { label: 'Error', className: 'run-status run-bad' });
  });

  it('never builds a label or a class from a status it does not know', () => {
    for (const odd of ['"><img src=x onerror=alert(1)>', 'constructor', '__proto__', undefined, null, 7]) {
      assert.deepEqual(statusView(odd), { label: 'Unknown', className: 'run-status run-off' });
    }
  });

  it('knows which statuses are final, and treats an unknown one as final so polling ends', () => {
    assert.equal(isFinal('QUEUED'), false);
    assert.equal(isFinal('RUNNING'), false);
    for (const status of ['PASSED', 'FAILED', 'ABORTED', 'ERROR', 'SOMETHING_NEW', undefined]) {
      assert.equal(isFinal(status), true);
    }
  });

  it('formats durations', () => {
    assert.equal(durationText(0), '0s');
    assert.equal(durationText(42_400), '42s');
    assert.equal(durationText(65_000), '1m 05s');
    assert.equal(durationText(3_725_000), '1h 02m');
    for (const none of [null, undefined, -1, NaN, '65000']) assert.equal(durationText(none), '');
  });

  it('formats counts, and says nothing when no test was reported', () => {
    assert.equal(countsText({ total: 3, passed: 2, failed: 1, skipped: 0 }), '3 tests: 2 passed, 1 failed');
    assert.equal(countsText({ total: 1, passed: 1, failed: 0, skipped: 0 }), '1 test: 1 passed, 0 failed');
    assert.equal(
      countsText({ total: 4, passed: 2, failed: 1, skipped: 1 }),
      '4 tests: 2 passed, 1 failed, 1 skipped',
    );
    assert.equal(countsText({ total: 0, passed: 0, failed: 0, skipped: 0 }), '');
    assert.equal(countsText(null), '');
  });

  it('summarises a run for the recent runs list', () => {
    assert.equal(
      runSummary({ id: 12, status: 'PASSED', scriptVersion: 2, durationMs: 65_000 }),
      '#12 · Passed · v2 · 1m 05s',
    );
    assert.equal(runSummary({ id: 13, status: 'RUNNING', scriptVersion: 3, durationMs: null }), '#13 · Running · v3');
  });

  it('offers a link only for an http or https address', () => {
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/'), 'http://localhost:7070/job/run/41/');
    assert.equal(safeJenkinsLink('https://ci.example.com/job/run/41/'), 'https://ci.example.com/job/run/41/');
    const bad = [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///c:/secret.txt',
      'chrome://settings',
      '//evil.example/x',
      'job/run/41/',
      '',
      null,
      undefined,
      41,
    ];
    for (const url of bad) assert.equal(safeJenkinsLink(url), null);
  });

  it('when the Jenkins address is known, offers a link only under it', () => {
    const base = 'http://localhost:7070';
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/', base), 'http://localhost:7070/job/run/41/');
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/', `${base}/`), 'http://localhost:7070/job/run/41/');
    const bad = [
      'http://localhost:7070@evil.example/job/run/41/',
      'http://localhost:70700/job/run/41/',
      'http://evil.example/http://localhost:7070/',
      'https://localhost:7070/job/run/41/',
    ];
    for (const url of bad) assert.equal(safeJenkinsLink(url, base), null);
  });

  it('offers the Jenkins link once there is a build, and never the report as Jenkins serves it', () => {
    const urls = {
      buildUrl: 'http://localhost:7070/job/run/41/',
      reportUrl: 'http://localhost:7070/job/run/41/artifact/playwright-report/index.html',
    };
    const jenkins = { label: 'Open in Jenkins', href: urls.buildUrl };

    assert.deepEqual(runLinks({ status: 'QUEUED', buildUrl: null, reportUrl: null }), []);
    assert.deepEqual(runLinks({ status: 'RUNNING', ...urls }), [jenkins]);
    // Jenkins shows an archived report with its scripts switched off: a blank page.
    assert.deepEqual(runLinks({ status: 'PASSED', ...urls }), [jenkins]);
    assert.deepEqual(runLinks({ status: 'FAILED', ...urls }), [jenkins]);
    assert.deepEqual(runLinks({ status: 'PASSED', buildUrl: 'javascript:alert(1)', reportUrl: 'javascript:alert(2)' }), []);
    assert.deepEqual(runLinks({ status: 'PASSED', ...urls }, 'http://other:8080'), []);
    assert.deepEqual(runLinks(null), []);
  });

  it('links each report the platform offers, under the platform address only', () => {
    const platform = 'http://localhost:3000';
    const playwright = '/api/reports/29.1790000000.abc-DEF_123/playwright/index.html';
    const allure = '/api/reports/29.1790000000.abc-DEF_123/allure/index.html';

    assert.deepEqual(reportLinks({ playwright, allure }, platform), [
      { label: 'Playwright report', href: platform + playwright },
      { label: 'Allure report', href: platform + allure },
    ]);
    // A build from before the Allure report was added.
    assert.deepEqual(reportLinks({ playwright, allure: null }, `${platform}/`), [
      { label: 'Playwright report', href: platform + playwright },
    ]);

    const bad = [
      'javascript:alert(1)',
      'http://evil.example/api/reports/x/playwright/index.html',
      '//evil.example/api/reports/x/playwright/index.html',
      '/api/reports/x/playwright/../../auth/logout',
      '/api/reports/x/allure/index.html', // the other report's path
      '',
      7,
    ];
    for (const path of bad) assert.deepEqual(reportLinks({ playwright: path, allure: null }, platform), []);
    assert.deepEqual(reportLinks({ playwright, allure }, ''), []);
    assert.deepEqual(reportLinks({ playwright, allure }, 'javascript:alert(1)'), []);
    assert.deepEqual(reportLinks(null, platform), []);

    // The run's own page comes first: it names the script and holds both reports.
    const overview = '/api/reports/29.1790000000.abc-DEF_123/';
    assert.deepEqual(reportLinks({ overview, playwright, allure: null }, platform), [
      { label: 'Run report', href: platform + overview },
      { label: 'Playwright report', href: platform + playwright },
    ]);
    for (const path of ['/api/reports/x', '/api/reports/x/../', '/api/reports/x/y/', '//evil.example/api/reports/x/']) {
      assert.deepEqual(reportLinks({ overview: path }, platform), []);
    }
  });

  it('sums up scripts that were run together', () => {
    assert.equal(batchSummary([]), '');
    assert.equal(batchSummary(null), '');
    assert.equal(batchSummary([{ execution: { status: 'PASSED' } }]), '1 script: 1 passed');
    assert.equal(
      batchSummary([
        { execution: { status: 'PASSED' } },
        { execution: { status: 'RUNNING' } },
        { execution: { status: 'PASSED' } },
        { execution: null, error: 'This script is already running.' },
        { execution: null, error: '' },
        { execution: { status: 'FAILED' } },
        { execution: { status: 'SOMETHING_NEW' } },
      ]),
      '7 scripts: 1 starting, 1 running, 2 passed, 1 failed, 1 unknown, 1 not started',
    );
  });

  it('offers project changes to an ADMIN, and script editing to ADMIN and USER in an active project', () => {
    assert.deepEqual(manageControls({ role: 'ADMIN', projectStatus: 'ACTIVE' }), { manageProjects: true, editScript: true });
    assert.deepEqual(manageControls({ role: 'USER', projectStatus: 'ACTIVE' }), { manageProjects: false, editScript: true });
    assert.deepEqual(manageControls({ role: 'VIEWER', projectStatus: 'ACTIVE' }), { manageProjects: false, editScript: false });
    assert.deepEqual(manageControls({ role: 'USER', projectStatus: 'ARCHIVED' }), { manageProjects: false, editScript: false });
    assert.deepEqual(manageControls({ role: undefined, projectStatus: undefined }), { manageProjects: false, editScript: false });
  });

  it('offers Run to ADMIN and USER in an active project once Jenkins is set up', () => {
    const base = { projectStatus: 'ACTIVE', jenkinsConfigured: true, execution: null };
    const offered = { showRun: true, runDisabled: false, showStop: false, note: '' };
    assert.deepEqual(runControls({ ...base, role: 'ADMIN' }), offered);
    assert.deepEqual(runControls({ ...base, role: 'USER' }), offered);
    assert.deepEqual(runControls({ ...base, role: 'VIEWER' }), { ...offered, showRun: false });
    assert.deepEqual(runControls({ ...base, role: undefined }), { ...offered, showRun: false });
  });

  it('replaces Run with a line when Jenkins is not set up or the project is archived', () => {
    const writer = { role: 'USER', execution: null };
    assert.deepEqual(runControls({ ...writer, projectStatus: 'ACTIVE', jenkinsConfigured: false }), {
      showRun: false,
      runDisabled: false,
      showStop: false,
      note: 'Jenkins is not set up yet. An administrator must set it up under Settings → Jenkins.',
    });
    assert.deepEqual(runControls({ ...writer, projectStatus: 'ARCHIVED', jenkinsConfigured: true }), {
      showRun: false,
      runDisabled: false,
      showStop: false,
      note: 'This project is archived, so its scripts cannot be run.',
    });
    // A VIEWER cannot run anything, so there is nothing to explain.
    assert.equal(runControls({ role: 'VIEWER', projectStatus: 'ACTIVE', jenkinsConfigured: false, execution: null }).note, '');
  });

  it('while a run is unfinished, disables Run and offers Stop to writers only', () => {
    const base = { projectStatus: 'ACTIVE', jenkinsConfigured: true };
    for (const status of ['QUEUED', 'RUNNING']) {
      assert.deepEqual(runControls({ ...base, role: 'USER', execution: { status } }), {
        showRun: true,
        runDisabled: true,
        showStop: true,
        note: '',
      });
      assert.equal(runControls({ ...base, role: 'VIEWER', execution: { status } }).showStop, false);
    }
    assert.deepEqual(runControls({ ...base, role: 'USER', execution: { status: 'PASSED' } }), {
      showRun: true,
      runDisabled: false,
      showStop: false,
      note: '',
    });
  });
});
