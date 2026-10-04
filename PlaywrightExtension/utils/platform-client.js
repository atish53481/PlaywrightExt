// HTTP client for the Playwright Platform backend (PlaywrightPlatform/server).
// The only extension file that knows the platform API. The password is sent
// once at sign-in and never stored; only the bearer token is kept.

import { Storage } from './storage.js';

function normalizeUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Platform URL must start with http:// or https://');
  }
  // The password and the session token travel to this address: plain http is for this machine only.
  const { protocol, hostname } = new URL(trimmed);
  if (protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(hostname)) {
    throw new Error('Use https:// for a platform that is not on this computer.');
  }
  return trimmed;
}

// Ids go into URL paths, so anything but a positive whole number is refused before a request is made.
function positiveId(value, message) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(message);
}

export function createPlatformClient({ fetchFn, storage }) {
  async function request(baseUrl, path, { method = 'GET', token = '', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetchFn(`${baseUrl}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Cannot reach the platform at ${baseUrl}. Is the server running?`);
    }

    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      // A validation error lists its specific problems in `details`; the first one is more
      // useful than the generic message.
      const detail = Array.isArray(data?.error?.details) ? data.error.details[0]?.message : null;
      const err = new Error(detail || data?.error?.message || `Platform request failed (${res.status})`);
      err.status = res.status;
      // Lets a caller react to one particular refusal, such as RUN_IN_PROGRESS.
      err.code = data?.error?.code ?? null;
      err.details = data?.error?.details ?? null;
      throw err;
    }
    return { status: res.status, data };
  }

  async function signedIn() {
    const platform = await storage.getPlatform();
    if (!platform.url || !platform.token) throw new Error('Sign in to the platform first (Settings → Platform).');
    return platform;
  }

  return {
    async login(url, email, password) {
      const baseUrl = normalizeUrl(url);
      const { data } = await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { email, password, client: 'extension' },
      });
      // Any server can answer 200. Nothing is stored unless the answer is the platform's.
      if (typeof data?.token !== 'string' || !data.token || typeof data?.user?.email !== 'string') {
        throw new Error('That address did not answer like the Playwright Platform. Check the URL.');
      }
      await storage.savePlatform({ url: baseUrl, token: data.token, user: data.user });
      return data.user;
    },

    async logout() {
      const platform = await storage.getPlatform();
      if (platform.url && platform.token) {
        try {
          await request(platform.url, '/auth/logout', { method: 'POST', token: platform.token });
        } catch {
          // The local token is dropped regardless; a dead server must not trap the user signed in.
        }
      }
      await storage.savePlatform({ url: platform.url, token: '', user: null });
    },

    // Returns the current user, or null when not signed in or the session has ended.
    async me() {
      const platform = await storage.getPlatform();
      if (!platform.url || !platform.token) return null;
      try {
        const { data } = await request(platform.url, '/auth/me', { token: platform.token });
        return data.user;
      } catch (err) {
        if (err.status === 401) {
          await storage.savePlatform({ url: platform.url, token: '', user: null });
          return null;
        }
        throw err;
      }
    },

    async listProjects() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/projects?pageSize=100', { token: platform.token });
      return data.items;
    },

    // Creates a project and returns it. ADMIN only; a name already in use is refused with
    // the code PROJECT_NAME_TAKEN.
    async createProject(name, description = '') {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/projects', {
        method: 'POST',
        token: platform.token,
        body: { name, description },
      });
      return data.project;
    },

    // Gives a project a new name and returns it. ADMIN only.
    async renameProject(projectId, name) {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/projects/${projectId}`, {
        method: 'PUT',
        token: platform.token,
        body: { name },
      });
      return data.project;
    },

    // Deletes a project with everything in it. ADMIN only.
    async deleteProject(projectId) {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      await request(platform.url, `/projects/${projectId}`, { method: 'DELETE', token: platform.token });
    },

    // Creates a script, with its first version, in a project. `source` is GENERATED or RECORDED;
    // `language` is TypeScript or JavaScript.
    async saveScript(projectId, { name, description = '', content, source, language, skills = [] }) {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const body = { name, description, content, source, language };
      // The skill versions the script was generated with: [{ id, version }].
      if (skills.length > 0) body.skills = skills;
      const { data } = await request(platform.url, `/projects/${projectId}/scripts`, {
        method: 'POST',
        token: platform.token,
        body,
      });
      return data.script;
    },

    // Changes a stored script. New content needs `baseVersion` (the version it was made from)
    // and becomes the next version; `healed: true` marks it as an accepted Healer fix. A
    // script that has moved on meanwhile is refused with the code VERSION_CONFLICT.
    async updateScript(scriptId, patch) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/scripts/${scriptId}`, { method: 'PUT', token: platform.token, body: patch });
      return data.script;
    },

    // The screenshot the build kept for one test of a run, as a Blob. `index` is the test's
    // place in the run's results, from 0. The platform fetches it from Jenkins itself.
    async getScreenshot(executionId, index) {
      positiveId(executionId, 'Choose a run.');
      if (!Number.isInteger(index) || index < 0) throw new Error('Choose a test.');
      const platform = await signedIn();
      let res;
      try {
        res = await fetchFn(`${platform.url}/api/executions/${executionId}/results/${index}/screenshot`, {
          method: 'GET',
          headers: { Authorization: `Bearer ${platform.token}` },
        });
      } catch {
        throw new Error(`Cannot reach the platform at ${platform.url}. Is the server running?`);
      }
      if (!res.ok) {
        const err = new Error('The screenshot is not available.');
        err.status = res.status;
        throw err;
      }
      return res.blob();
    },

    // A project's skills: its own and every global one, each with attached, enabled, priority.
    // `search` matches the name, the description, and the tags.
    async listProjectSkills(projectId, search = '') {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const text = String(search || '').trim();
      const query = text ? `?${new URLSearchParams({ search: text })}` : '';
      const { data } = await request(platform.url, `/projects/${projectId}/skills${query}`, { token: platform.token });
      return data.items;
    },

    // What the agents are given: { project, skills: [{ id, name, version, content }] }, enabled skills in order.
    async getSkillContext(projectId) {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/projects/${projectId}/skills/context`, { token: platform.token });
      return data;
    },

    // One skill with its text.
    async getSkill(skillId) {
      positiveId(skillId, 'Choose a skill.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/skills/${skillId}`, { token: platform.token });
      return data.skill;
    },

    // Creates a skill in a project; with `projectId` null, a global one (ADMIN only).
    async createSkill(projectId, { name, description = '', content, fileName = '', tags = [] }) {
      if (projectId !== null) positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const body = { name, description, content };
      if (fileName) body.fileName = fileName;
      if (tags.length > 0) body.tags = tags;
      const path = projectId === null ? '/skills' : `/projects/${projectId}/skills`;
      const { data } = await request(platform.url, path, { method: 'POST', token: platform.token, body });
      return data.skill;
    },

    // Changes a skill: { name, description, content, changeSummary }. New content becomes a new version.
    async updateSkill(skillId, patch) {
      positiveId(skillId, 'Choose a skill.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/skills/${skillId}`, { method: 'PUT', token: platform.token, body: patch });
      return data.skill;
    },

    async archiveSkill(skillId) {
      positiveId(skillId, 'Choose a skill.');
      const platform = await signedIn();
      await request(platform.url, `/skills/${skillId}`, { method: 'DELETE', token: platform.token });
    },

    async listSkillVersions(skillId) {
      positiveId(skillId, 'Choose a skill.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/skills/${skillId}/versions`, { token: platform.token });
      return data.items;
    },

    // Writes an old version's text as a new version and returns the skill.
    async restoreSkillVersion(skillId, version) {
      positiveId(skillId, 'Choose a skill.');
      positiveId(version, 'Choose a version.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/skills/${skillId}/versions/${version}/restore`, {
        method: 'POST',
        token: platform.token,
      });
      return data.skill;
    },

    // How one project uses a skill: { attached, enabled, priority }. Attaching is for global skills.
    async setProjectSkill(projectId, skillId, patch) {
      positiveId(projectId, 'Choose a project.');
      positiveId(skillId, 'Choose a skill.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/projects/${projectId}/skills/${skillId}`, {
        method: 'PUT',
        token: platform.token,
        body: patch,
      });
      return data.skill;
    },

    // A project's scripts, most recently updated first. `search` matches the name,
    // description, test scenario, and tags.
    async listScripts(projectId, search = '') {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const query = new URLSearchParams({ pageSize: '100' });
      const text = String(search || '').trim();
      if (text) query.set('search', text);
      const { data } = await request(platform.url, `/projects/${projectId}/scripts?${query}`, { token: platform.token });
      return data.items;
    },

    // One script with its content.
    async getScript(scriptId) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/scripts/${scriptId}`, { token: platform.token });
      return data.script;
    },

    // { configured, baseUrl, username, jobName, hasToken }. The address and username are empty
    // unless the signed-in user is an ADMIN. The token is never returned.
    async getJenkinsSettings() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/jenkins/settings', { token: platform.token });
      return data.settings;
    },

    // An empty token keeps the one the server already has; an empty job name means the default.
    async saveJenkinsSettings({ baseUrl, username, jobName = '', token = '' }) {
      const platform = await signedIn();
      const body = { baseUrl, username };
      if (jobName) body.jobName = jobName;
      if (token) body.token = token;
      const { data } = await request(platform.url, '/jenkins/settings', { method: 'PUT', token: platform.token, body });
      return data.settings;
    },

    // Tries a connection: { ok, version, pipelinePlugin, message }. Only the fields that were
    // filled in are sent; the server uses the saved value for the rest.
    async testJenkins({ baseUrl = '', username = '', token = '' } = {}) {
      const platform = await signedIn();
      const body = {};
      if (baseUrl) body.baseUrl = baseUrl;
      if (username) body.username = username;
      if (token) body.token = token;
      const { data } = await request(platform.url, '/jenkins/test', { method: 'POST', token: platform.token, body });
      return data;
    },

    // Creates the pipeline job in Jenkins, or updates its definition: { created, jobUrl }.
    async createJenkinsJob() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/jenkins/job', { method: 'POST', token: platform.token });
      return data;
    },

    // Starts a run of the script's current version on Jenkins and returns the run.
    // `record` says what every test of the run gets: { screenshots, video }, both true or false.
    // Without it the server's own choice applies. A failed test keeps both either way.
    async runScript(scriptId, record = null) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const options = { method: 'POST', token: platform.token };
      if (record) options.body = { screenshots: Boolean(record.screenshots), video: Boolean(record.video) };
      const { data } = await request(platform.url, `/scripts/${scriptId}/run`, options);
      return data.execution;
    },

    // Reads a run. The server brings an unfinished run up to date with Jenkins first.
    async getExecution(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}`, { token: platform.token });
      return data.execution;
    },

    async stopExecution(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}/stop`, {
        method: 'POST',
        token: platform.token,
      });
      return data.execution;
    },

    // The tests of a run, in the order the build reported them: [{ name, status, durationMs, errorMessage }].
    async listExecutionResults(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}/results`, { token: platform.token });
      return data.items;
    },

    // Where the reports of a finished run open: { reports: { playwright, allure }, platformUrl }.
    // Each report is a path on the platform, or null when the build archived no such report.
    // A link works for an hour and needs no sign-in, so it can open in a tab of its own.
    async getReportLinks(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}/reports`, { token: platform.token });
      return { reports: data.reports, platformUrl: platform.url };
    },

    // Deletes a script from the platform, and its builds from Jenkins. Refused with the code
    // RUN_IN_PROGRESS while the script is running.
    async deleteScript(scriptId) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      await request(platform.url, `/scripts/${scriptId}`, { method: 'DELETE', token: platform.token });
    },

    // A script's runs, newest first, as stored (Jenkins is not asked). `limit` is 1 to 50.
    async listExecutions(scriptId, limit = 10) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const size = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 10;
      const { data } = await request(platform.url, `/scripts/${scriptId}/executions?limit=${size}`, {
        token: platform.token,
      });
      return data.items;
    },
  };
}

export const PlatformClient = createPlatformClient({
  fetchFn: (url, init) => fetch(url, init),
  storage: Storage,
});
