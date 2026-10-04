// The Jenkins job the platform creates. The tests run inside the official Playwright Docker
// image, started with `docker run` from the agent's own shell, so the agent needs only Docker
// and curl. One pipeline serves Windows and Linux agents: `isUnix()` chooses `sh` or `bat`.
//
// The build receives EXECUTION_ID, PLATFORM_URL, RUN_TOKEN (a password parameter), and
// PLAYWRIGHT_IMAGE, and holds no secret in its definition. Only the agent talks to the
// platform: the container is given the workspace and nothing else.

/**
 * The Playwright version an image tag names: `…/playwright:v1.63.0-noble` gives `1.63.0`.
 * The build installs exactly this version of @playwright/test, because any other version
 * looks for browsers the image does not have.
 */
export function playwrightVersionFromTag(image: string): string {
  const match = /:v?(\d+\.\d+\.\d+)(-[A-Za-z0-9._-]+)?$/.exec(image);
  if (!match) throw new Error(`The Playwright image "${image}" must name a version in its tag, such as v1.63.0-noble.`);
  return match[1];
}

function packageJson(playwrightVersion: string): string {
  return `{
  "name": "playwright-platform-run",
  "private": true,
  "devDependencies": { "@playwright/test": "${playwrightVersion}", "allure-playwright": "^3.0.0", "allure": "^3.0.0" }
}
`;
}

const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'results.json' }],
    ['allure-playwright', { resultsDir: 'allure-results' }],
  ],
  // What a failed test leaves behind for the person reading the report.
  use: { headless: true, screenshot: 'only-on-failure', video: 'retain-on-failure', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

// Runs in the container after the tests. Reads Playwright's JSON report and writes the counts
// to result-body.json, which the agent then posts to the platform. Writes nothing when there
// is no report (the tests never started); the platform then reports that.
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

function main() {
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
  fs.writeFileSync('result-body.json', JSON.stringify(body));
  console.log('Wrote the result for the platform: ' + body.total + ' tests');
}

try {
  main();
} catch (err) {
  console.log('Could not write the result: ' + err.message);
}
`;

/** Groovy string literal with single quotes; backslashes and quotes are escaped. */
function groovy(text: string): string {
  return `'''${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'''`;
}

/**
 * The pipeline for builds that use `image`. Only the image's Playwright version is written
 * into the text; the image itself arrives with each build as the PLAYWRIGHT_IMAGE parameter.
 */
export function pipelineScript(image: string): string {
  return `// One command line for the agent's own shell: sh on Linux, cmd on Windows. Returns the exit code.
def onAgent(String unix, String windows) {
  return isUnix() ? sh(returnStatus: true, script: unix) : bat(returnStatus: true, script: windows)
}

// One command inside the Playwright image, in the workspace. Returns the exit code.
// The container gets the workspace and the npm cache, and no parameter of the build.
// On Linux it writes as the agent's user: files owned by root could not be cleared by the next build.
def inImage(String command) {
  def flags = '--rm --init --ipc=host -e npm_config_cache=/tmp/.npm -v playwright-npm-cache:/tmp/.npm -w /work'
  return onAgent(
    'docker run ' + flags + ' -u "$(id -u):$(id -g)" -e HOME=/tmp -v "$WORKSPACE:/work" "$PLAYWRIGHT_IMAGE" sh -c \\'' + command + '\\'',
    'docker run ' + flags + ' -v "%WORKSPACE%:/work" "%PLAYWRIGHT_IMAGE%" sh -c "' + command + '"'
  )
}

pipeline {
  agent any
  options { timeout(time: 30, unit: 'MINUTES') }
  stages {
    stage('Preflight') {
      steps {
        // First, so a result left by an earlier build can never be posted for this one.
        deleteDir()
        script {
          def reason = ''
          if (onAgent('docker version', 'docker version') != 0) {
            reason = 'Docker is not available on the Jenkins agent. Start Docker, and check that the account Jenkins runs as may use it.'
          } else if (onAgent('docker image inspect --format "{{.Id}}" "$PLAYWRIGHT_IMAGE"', 'docker image inspect --format "{{.Id}}" "%PLAYWRIGHT_IMAGE%"') != 0
              && onAgent('docker pull "$PLAYWRIGHT_IMAGE"', 'docker pull "%PLAYWRIGHT_IMAGE%"') != 0) {
            reason = 'Could not pull ' + params.PLAYWRIGHT_IMAGE + '. Check the image name, and that the Jenkins agent can reach the registry.'
          }
          if (reason) {
            // Posted by the agent in the post section, so the platform can say why the run ended.
            writeFile file: 'result-body.json', text: '{"total":0,"passed":0,"failed":0,"skipped":0,"errorMessage":"' + reason + '"}'
            error(reason)
          }
          // A new volume belongs to root; the container on Linux does not run as root.
          if (isUnix()) {
            sh 'docker run --rm -v playwright-npm-cache:/tmp/.npm "$PLAYWRIGHT_IMAGE" chmod 0777 /tmp/.npm'
          }
        }
      }
    }
    stage('Prepare') {
      steps {
        writeFile file: 'package.json', text: ${groovy(packageJson(playwrightVersionFromTag(image)))}
        writeFile file: 'playwright.config.ts', text: ${groovy(PLAYWRIGHT_CONFIG)}
        writeFile file: 'report-result.cjs', text: ${groovy(REPORT_SCRIPT)}
        script {
          // The agent downloads the script. "set +x" and "@" keep the shell from printing the line, and the token with it.
          if (isUnix()) {
            sh 'mkdir -p tests'
            sh 'set +x; curl -sS -f -H "Authorization: Bearer $RUN_TOKEN" -H "X-Build-Number: $BUILD_NUMBER" -o tests/script.spec.ts "$PLATFORM_URL/api/executions/$EXECUTION_ID/script"'
          } else {
            bat 'if not exist tests mkdir tests'
            bat '@curl -sS -f -H "Authorization: Bearer %RUN_TOKEN%" -H "X-Build-Number: %BUILD_NUMBER%" -o tests\\\\script.spec.ts "%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script"'
          }
        }
      }
    }
    stage('Install') {
      steps {
        script {
          if (inImage('npm install --no-audit --no-fund') != 0) { error('npm install failed inside the Playwright image.') }
        }
      }
    }
    stage('Test') {
      steps {
        script {
          // The result is written whatever the tests did; the container ends with the tests' own exit code.
          // The Allure report is one HTML file, made here because the agent has no Node.js.
          def code = inImage('npx playwright test; rc=$?; node report-result.cjs; [ -d allure-results ] && npx allure awesome allure-results --single-file --output allure-report; exit $rc')
          if (code != 0) { currentBuild.result = 'UNSTABLE' }
        }
      }
    }
  }
  post {
    always {
      script {
        if (fileExists('result-body.json')) {
          if (isUnix()) {
            sh(returnStatus: true, script: 'set +x; curl -sS -f -X POST -H "Content-Type: application/json" -H "Authorization: Bearer $RUN_TOKEN" --data-binary @result-body.json "$PLATFORM_URL/api/executions/$EXECUTION_ID/result"')
          } else {
            bat(returnStatus: true, script: '@curl -sS -f -X POST -H "Content-Type: application/json" -H "Authorization: Bearer %RUN_TOKEN%" --data-binary @result-body.json "%PLATFORM_URL%/api/executions/%EXECUTION_ID%/result"')
          }
        }
      }
      archiveArtifacts artifacts: 'playwright-report/**, allure-report/**, test-results/**', allowEmptyArchive: true
    }
  }
}
`;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The job definition. `image` is the default of PLAYWRIGHT_IMAGE; each run also sends its own. */
export function jobConfigXml(image: string): string {
  return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Runs one Playwright script stored in the Playwright Platform, inside the Playwright Docker image. Managed by the platform: changes made here are overwritten.</description>
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
        <hudson.model.StringParameterDefinition>
          <name>PLAYWRIGHT_IMAGE</name>
          <defaultValue>${xml(image)}</defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${xml(pipelineScript(image))}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>
`;
}
