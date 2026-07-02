// Chrome storage wrapper with promise API

export const Storage = {
  async get(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
  },

  async set(items) {
    return new Promise((resolve) => chrome.storage.local.set(items, resolve));
  },

  async remove(keys) {
    return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
  },

  async getSettings() {
    const data = await this.get('pas_settings');
    return data.pas_settings || { provider: 'mock', apiKey: '', model: '' };
  },

  async saveSettings(settings) {
    await this.set({ pas_settings: settings });
  },

  async getRecordings() {
    const data = await this.get('pas_recordings');
    return data.pas_recordings || [];
  },

  async saveRecording(recording) {
    const recordings = await this.getRecordings();
    recordings.push({ ...recording, id: Date.now(), timestamp: new Date().toISOString() });
    await this.set({ pas_recordings: recordings });
    return recordings;
  },

  async getSessions() {
    const data = await this.get('pas_sessions');
    return data.pas_sessions || [];
  },

  async saveSession(session) {
    const sessions = await this.getSessions();
    sessions.push({ ...session, id: Date.now(), timestamp: new Date().toISOString() });
    if (sessions.length > 50) sessions.shift();
    await this.set({ pas_sessions: sessions });
    return sessions;
  },

  async getHistory() {
    const data = await this.get('pas_history');
    return data.pas_history || [];
  },

  async saveHistoryEntry(entry) {
    const history = await this.getHistory();
    history.unshift({ ...entry, id: Date.now(), timestamp: new Date().toISOString() });
    if (history.length > 100) history.pop();
    await this.set({ pas_history: history });
  }
};
