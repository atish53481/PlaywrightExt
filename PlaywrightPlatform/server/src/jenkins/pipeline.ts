// The Jenkins job the platform creates. Windows agents only: every command is a `bat` step.
// The build receives EXECUTION_ID, PLATFORM_URL, and RUN_TOKEN (a password parameter, so
// Jenkins masks it) and holds no secret in its definition.

const PACKAGE_JSON = `{
  "name": "playwright-platform-run",
  "private": true,
  "devDependencies": { "@playwright/test": "^1.49.0" }
}
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  reporter: [['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]],
  // What a failed test leaves behind for the person reading the report.
  use: { headless: true, screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

// Reads Playwright's JSON report and posts the counts to the platform. Exits quietly when
// there is no report (the build failed before the tests ran); the platform then reports that.
const REPORT_SCRIPT = `const fs = require('node:fs');
const nodePath = require('node:path');

function firstError(suites) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (result.error && result.error.message) return spec.title + ': ' + result.error.message;
        }
      }
    }
    const nested = firstError(suite.suites);
    if (nested) return nested;
  }
  return null;
}

function plain(text) {
  return String(text).replace(/\\u001b\\[[0-9;]*m/g, '').slice(0, 2000);
}

// One entry per test, named by its describe blocks and title.
function collectTests(suites, path, out) {
  for (const suite of suites || []) {
    // The top suite is the file; its name says nothing about the test.
    const here = suite.file === suite.title || !suite.title ? path : path.concat(suite.title);
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        if (out.length >= 500) return;
        const results = test.results || [];
        const last = results[results.length - 1] || {};
        const status = test.status === 'skipped' ? 'SKIPPED' : test.status === 'unexpected' ? 'FAILED' : 'PASSED';
        const entry = {
          name: here.concat(spec.title).join(' > ').slice(0, 500) || 'test',
          status,
          durationMs: Math.max(0, Math.round(results.reduce((sum, r) => sum + (r.duration || 0), 0))),
        };
        if (status === 'FAILED' && last.error && last.error.message) entry.errorMessage = plain(last.error.message);
        // The files Playwright kept for the test, as paths inside this workspace.
        for (const kind of ['screenshot', 'video', 'trace']) {
          const file = (last.attachments || []).find((a) => a.name === kind && a.path);
          if (!file) continue;
          const relative = nodePath.relative(process.cwd(), file.path).split(nodePath.sep).join('/');
          if (!relative.startsWith('..')) entry[kind] = relative;
        }
        out.push(entry);
      }
    }
    collectTests(suite.suites, here, out);
  }
  return out;
}

async function main() {
  if (!fs.existsSync('results.json')) return;
  const report = JSON.parse(fs.readFileSync('results.json', 'utf8'));
  const stats = report.stats || {};
  const passed = (stats.expected || 0) + (stats.flaky || 0);
  const failed = stats.unexpected || 0;
  const skipped = stats.skipped || 0;
  const body = { total: passed + failed + skipped, passed, failed, skipped, tests: collectTests(report.suites, [], []) };
  // A script that does not compile has no failed test: the reason is in the report's own errors.
  const loadError = (report.errors || [])[0];
  const message = firstError(report.suites) || (loadError && loadError.message);
  if (message) body.errorMessage = plain(message);
  const url = process.env.PLATFORM_URL + '/api/executions/' + process.env.EXECUTION_ID + '/result';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RUN_TOKEN },
    body: JSON.stringify(body),
  });
  console.log('Reported result to the platform: HTTP ' + res.status);
}

main().catch((err) => console.log('Could not report the result: ' + err.message));
`;

/** Groovy string literal with single quotes; backslashes and quotes are escaped. */
function groovy(text: string): string {
  return `'''${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'''`;
}

export function pipelineScript(): string {
  return `pipeline {
  agent any
  options { timeout(time: 30, unit: 'MINUTES') }
  stages {
    stage('Prepare') {
      steps {
        deleteDir()
        writeFile file: 'package.json', text: ${groovy(PACKAGE_JSON)}
        writeFile file: 'playwright.config.ts', text: ${groovy(PLAYWRIGHT_CONFIG)}
        writeFile file: 'report-result.cjs', text: ${groovy(REPORT_SCRIPT)}
        bat 'if not exist tests mkdir tests'
        bat '@curl -sS -f -H "Authorization: Bearer %RUN_TOKEN%" -H "X-Build-Number: %BUILD_NUMBER%" -o tests\\\\script.spec.ts "%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script"'
      }
    }
    stage('Install') {
      steps {
        bat 'npm install --no-audit --no-fund'
        bat 'npx playwright install chromium'
      }
    }
    stage('Test') {
      steps {
        script {
          def code = bat(returnStatus: true, script: 'npx playwright test')
          if (code != 0) { currentBuild.result = 'UNSTABLE' }
        }
      }
    }
  }
  post {
    always {
      script { bat(returnStatus: true, script: 'node report-result.cjs') }
      archiveArtifacts artifacts: 'playwright-report/**, test-results/**', allowEmptyArchive: true
    }
  }
}
`;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function jobConfigXml(): string {
  return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Runs one Playwright script stored in the Playwright Platform. Managed by the platform: changes made here are overwritten.</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>EXECUTION_ID</name>
          <defaultValue></defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.StringParameterDefinition>
          <name>PLATFORM_URL</name>
          <defaultValue></defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.PasswordParameterDefinition>
          <name>RUN_TOKEN</name>
        </hudson.model.PasswordParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${xml(pipelineScript())}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>
`;
}
