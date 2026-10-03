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
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

// Reads Playwright's JSON report and posts the counts to the platform. Exits quietly when
// there is no report (the build failed before the tests ran); the platform then reports that.
const REPORT_SCRIPT = `const fs = require('node:fs');

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

async function main() {
  if (!fs.existsSync('results.json')) return;
  const report = JSON.parse(fs.readFileSync('results.json', 'utf8'));
  const stats = report.stats || {};
  const passed = (stats.expected || 0) + (stats.flaky || 0);
  const failed = stats.unexpected || 0;
  const skipped = stats.skipped || 0;
  const body = { total: passed + failed + skipped, passed, failed, skipped };
  const message = firstError(report.suites);
  if (message) body.errorMessage = message.replace(/\\u001b\\[[0-9;]*m/g, '').slice(0, 2000);
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
      archiveArtifacts artifacts: 'playwright-report/**', allowEmptyArchive: true
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
