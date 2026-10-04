import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JenkinsClient, JenkinsError } from '../src/jenkins/jenkins-client';
import { jobConfigXml, pipelineScript, playwrightVersionFromTag } from '../src/jenkins/pipeline';
import { jenkinsBuildUrl, jenkinsJobUrl, jenkinsReportUrl } from '../src/jenkins/urls';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';

describe('jenkins client', () => {
  let stub: JenkinsStub;
  let client: JenkinsClient;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.reset();
    client = new JenkinsClient({ baseUrl: stub.url, username: stub.username, token: stub.token });
  });

  const kindOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (err) {
      return err instanceof JenkinsError ? err.kind : `not a JenkinsError: ${String(err)}`;
    }
    return 'no error';
  };

  it('reads the version and sends basic authentication', async () => {
    expect(await client.version()).toBe('2.555.2');
    expect(stub.requests[0].authorization).toBe(`Basic ${Buffer.from('ci-user:ci-token').toString('base64')}`);
  });

  it('reports which plugins are missing', async () => {
    stub.plugins = ['workflow-job'];
    expect(await client.missingPlugins(['workflow-job', 'workflow-cps'])).toEqual(['workflow-cps']);
    stub.plugins = [];
    expect(await client.missingPlugins(['workflow-job'])).toEqual(['workflow-job']);
  });

  it('creates a job that does not exist and updates one that does', async () => {
    expect(await client.jobExists('runner')).toBe(false);
    expect(await client.createOrUpdateJob('runner', '<a/>')).toEqual({ created: true });
    expect(await client.jobExists('runner')).toBe(true);
    expect(await client.createOrUpdateJob('runner', '<b/>')).toEqual({ created: false });
    expect(stub.configs.get('runner')).toBe('<b/>');
  });

  it('triggers a build with parameters and returns the queue id', async () => {
    stub.jobs.add('runner');
    const queueId = await client.trigger('runner', { EXECUTION_ID: '7', RUN_TOKEN: 'a b&c' });
    expect(stub.queue.has(queueId)).toBe(true);
    expect(stub.lastParams).toEqual({ EXECUTION_ID: '7', RUN_TOKEN: 'a b&c' });
  });

  it('reads a queue item before and after the build starts, and when cancelled', async () => {
    stub.jobs.add('runner');
    const id = await client.trigger('runner', {});
    expect(await client.queueItem(id)).toEqual({ cancelled: false, buildNumber: null });
    stub.queue.get(id)!.buildNumber = 41;
    expect(await client.queueItem(id)).toEqual({ cancelled: false, buildNumber: 41 });
    await client.cancelQueue(id);
    expect((await client.queueItem(id)).cancelled).toBe(true);
  });

  it('reads and stops a build', async () => {
    stub.jobs.add('runner');
    stub.builds.set('runner/41', { building: true, result: null, timestamp: 1_700_000_000_000, duration: 0 });
    expect(await client.build('runner', 41)).toEqual({ building: true, result: null, timestamp: 1_700_000_000_000, duration: 0 });
    await client.stopBuild('runner', 41);
    expect((await client.build('runner', 41)).result).toBe('ABORTED');
  });

  it('cancelling a queue item Jenkins no longer knows is not an error', async () => {
    await expect(client.cancelQueue(999)).resolves.toBeUndefined();
  });

  it('builds job, build, and report addresses', () => {
    expect(client.jobUrl('runner')).toBe(`${stub.url}/job/runner/`);
    expect(jenkinsJobUrl('http://ci', 'my job')).toBe('http://ci/job/my%20job/');
    expect(jenkinsBuildUrl('http://ci', 'runner', 41)).toBe('http://ci/job/runner/41/');
    expect(jenkinsReportUrl('http://ci', 'runner', 41)).toBe(
      'http://ci/job/runner/41/artifact/playwright-report/index.html',
    );
  });

  it('classifies failures', async () => {
    expect(await kindOf(client.build('missing', 1))).toBe('NOT_FOUND');
    stub.failWith = 403;
    expect(await kindOf(client.version())).toBe('REJECTED');
    stub.failWith = 503;
    expect(await kindOf(client.version())).toBe('UNREACHABLE');
    stub.failWith = null;
    const wrongToken = new JenkinsClient({ baseUrl: stub.url, username: 'ci-user', token: 'nope' });
    expect(await kindOf(wrongToken.version())).toBe('REJECTED');
    const nobodyHome = new JenkinsClient({ baseUrl: 'http://127.0.0.1:1', username: 'u', token: 't' });
    expect(await kindOf(nobodyHome.version())).toBe('UNREACHABLE');
  });
});

const IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble';

describe('playwrightVersionFromTag', () => {
  it.each([
    ['mcr.microsoft.com/playwright:v1.63.0-noble', '1.63.0'],
    ['mcr.microsoft.com/playwright:v1.62.1-jammy', '1.62.1'],
    ['registry.example.com/team/playwright:v1.60.0', '1.60.0'],
    ['localhost:5000/playwright:v1.58.2-noble', '1.58.2'],
    ['mcr.microsoft.com/playwright:1.57.0-jammy', '1.57.0'],
  ])('reads the version of %s', (tag, version) => {
    expect(playwrightVersionFromTag(tag)).toBe(version);
    // The build installs exactly that version: any other looks for browsers the image does not have.
    expect(pipelineScript(tag)).toContain(`"@playwright/test": "${version}"`);
  });

  it('refuses a tag that names no version', () => {
    expect(() => playwrightVersionFromTag('mcr.microsoft.com/playwright:latest')).toThrow(/version/);
    expect(() => playwrightVersionFromTag('mcr.microsoft.com/playwright:noble')).toThrow(/version/);
  });
});

describe('pipeline text', () => {
  const script = pipelineScript(IMAGE);
  const dockerRuns = script.split('\n').filter((line) => line.includes('docker run'));

  it('runs npm and the tests inside the image, with the workspace mounted at /work', () => {
    expect(dockerRuns.length).toBeGreaterThan(0);
    expect(script).toContain('--ipc=host');
    expect(script).toContain('--init');
    expect(script).toContain('-w /work');
    expect(script).toContain('playwright-npm-cache:/tmp/.npm');
    expect(script).toContain('npm_config_cache=/tmp/.npm');
    expect(script).toContain('npm install --no-audit --no-fund');
    expect(script).toContain('npx playwright test');
    expect(script).toContain('node report-result.cjs');
    // The image holds the browsers, and the agent needs no Node.js.
    expect(script).not.toContain('playwright install');
    expect(script).not.toMatch(/^\s*(bat|sh) '(npm|npx|node) /m);
    // Never through the Docker Pipeline plugin.
    expect(script).not.toMatch(/agent\s*\{\s*docker/);
    expect(script).toContain('agent any');
  });

  it('works on a Windows and on a Linux agent', () => {
    expect(script).toContain('isUnix()');
    expect(script).toMatch(/\bsh\(/);
    expect(script).toMatch(/\bbat\(/);
    expect(script).toContain('"%WORKSPACE%:/work"');
    expect(script).toContain('"$WORKSPACE:/work"');
    // On Linux the container writes as the agent's user, or the next build cannot clear the workspace.
    expect(script).toContain('-u "$(id -u):$(id -g)"');
    expect(script).toContain('-e HOME=/tmp');
  });

  it('takes the image from the PLAYWRIGHT_IMAGE parameter', () => {
    expect(script).toContain('"%PLAYWRIGHT_IMAGE%"');
    expect(script).toContain('"$PLAYWRIGHT_IMAGE"');
    // The image name is never written into the pipeline text.
    expect(script).not.toContain(IMAGE);
  });

  it('checks Docker and the image first, and gives a plain reason when either is missing', () => {
    const stages = [...script.matchAll(/stage\('(\w+)'\)/g)].map((match) => match[1]);
    expect(stages).toEqual(['Preflight', 'Prepare', 'Install', 'Test']);
    expect(script).toContain('docker version');
    expect(script).toContain('docker image inspect');
    expect(script).toContain('docker pull');
    expect(script).toContain('Docker is not available on the Jenkins agent');
    expect(script).toContain('Could not pull ');
  });

  it('downloads the script on the agent with the run token, without echoing it', () => {
    expect(script).toContain('"%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script"');
    expect(script).toContain('"$PLATFORM_URL/api/executions/$EXECUTION_ID/script"');
    expect(script).toContain('Authorization: Bearer %RUN_TOKEN%');
    expect(script).toContain('X-Build-Number: %BUILD_NUMBER%');
    // Every line that carries the token: @ keeps cmd from echoing it, set +x keeps sh from echoing it.
    const tokenLines = script.split('\n').filter((line) => line.includes('RUN_TOKEN'));
    expect(tokenLines.length).toBe(4);
    for (const line of tokenLines) expect(line).toMatch(/'@curl |'set \+x; curl /);
  });

  it('keeps the run token and the platform address out of the container', () => {
    for (const line of dockerRuns) {
      expect(line).not.toContain('RUN_TOKEN');
      expect(line).not.toContain('PLATFORM_URL');
    }
    // The script that runs in the container writes the result; it posts nothing.
    expect(script).toContain("fs.writeFileSync(\\'result-body.json\\'");
    expect(script).not.toContain('fetch(');
    expect(script).not.toContain('process.env');
  });

  it('posts the result from the agent, and archives the report', () => {
    const post = script.slice(script.indexOf('post {'));
    expect(post).toContain("fileExists('result-body.json')");
    expect(post).toContain('curl -sS -f -X POST -H "Content-Type: application/json" -H "Authorization: Bearer %RUN_TOKEN%" --data-binary @result-body.json "%PLATFORM_URL%/api/executions/%EXECUTION_ID%/result"');
    expect(post).toContain('--data-binary @result-body.json "$PLATFORM_URL/api/executions/$EXECUTION_ID/result"');
    // The report, and the screenshot, video, and trace of each failed test.
    expect(post).toContain("archiveArtifacts artifacts: 'playwright-report/**, test-results/**'");
    expect(script).toContain("screenshot: \\'only-on-failure\\'");
    // Each test's own result travels with the counts.
    expect(script).toContain('tests: collectTests(report.suites, [], [])');
  });

  it('marks failing tests UNSTABLE and fails the build for anything else', () => {
    expect(script).toContain("currentBuild.result = 'UNSTABLE'");
    expect(script).toContain("error('npm install failed");
  });

  it('wraps the pipeline in a job definition with four parameters declared and markup escaped', () => {
    const xml = jobConfigXml(IMAGE);
    expect(xml.match(/<name>/g)).toHaveLength(4);
    expect(xml).toContain('<name>EXECUTION_ID</name>');
    expect(xml).toContain('<name>PLATFORM_URL</name>');
    expect(xml).toContain('<hudson.model.PasswordParameterDefinition>');
    expect(xml).toContain('<name>RUN_TOKEN</name>');
    expect(xml).toContain('<name>PLAYWRIGHT_IMAGE</name>');
    expect(xml).toContain(`<defaultValue>${IMAGE}</defaultValue>`);
    expect(xml).toContain('<sandbox>true</sandbox>');
    const scriptPart = xml.slice(xml.indexOf('<script>') + 8, xml.indexOf('</script>'));
    expect(scriptPart).not.toMatch(/<|>/);
    expect(scriptPart).toContain('=&gt;');
  });
});
