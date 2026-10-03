import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JenkinsClient, JenkinsError } from '../src/jenkins/jenkins-client';
import { jobConfigXml, pipelineScript } from '../src/jenkins/pipeline';
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

  it('reports whether a plugin is installed', async () => {
    expect(await client.hasPlugin('workflow-aggregator')).toBe(true);
    stub.plugins = [];
    expect(await client.hasPlugin('workflow-aggregator')).toBe(false);
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

describe('pipeline text', () => {
  it('uses the three parameters and holds no secret', () => {
    const script = pipelineScript();
    expect(script).toContain('%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script');
    expect(script).toContain('Authorization: Bearer %RUN_TOKEN%');
    expect(script).toContain('X-Build-Number: %BUILD_NUMBER%');
    expect(script).toContain("archiveArtifacts artifacts: 'playwright-report/**'");
    // The @ keeps cmd from echoing the line, which would print the run token in the build log.
    expect(script).toContain("bat '@curl ");
  });

  it('wraps the pipeline in a job definition with the parameters declared and markup escaped', () => {
    const xml = jobConfigXml();
    expect(xml).toContain('<name>EXECUTION_ID</name>');
    expect(xml).toContain('<name>PLATFORM_URL</name>');
    expect(xml).toContain('<hudson.model.PasswordParameterDefinition>');
    expect(xml).toContain('<name>RUN_TOKEN</name>');
    expect(xml).toContain('<sandbox>true</sandbox>');
    const scriptPart = xml.slice(xml.indexOf('<script>') + 8, xml.indexOf('</script>'));
    expect(scriptPart).not.toMatch(/<|>/);
    expect(scriptPart).toContain('=&gt;');
  });
});
