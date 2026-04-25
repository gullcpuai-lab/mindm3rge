// Chrome extension storage utilities

export async function getSession() {
  const result = await chrome.storage.local.get('currentSession');
  return result.currentSession || null;
}

export async function saveSession(session) {
  await chrome.storage.local.set({ currentSession: session });
}

export async function clearSession() {
  await chrome.storage.local.remove('currentSession');
}

export async function getSessionHistory() {
  const result = await chrome.storage.local.get('sessionHistory');
  return result.sessionHistory || [];
}

export async function saveToHistory(session) {
  const history = await getSessionHistory();
  history.unshift({
    ...session,
    savedAt: new Date().toISOString(),
  });
  // Keep last 50 sessions
  await chrome.storage.local.set({ sessionHistory: history.slice(0, 50) });
}

export async function getSettings() {
  const result = await chrome.storage.local.get('settings');
  return result.settings || {
    passes: 1,
    starterModel: 'claude',
    autoAdvance: true,
    showNotifications: true,
  };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}
