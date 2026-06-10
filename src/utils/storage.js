// Chrome extension storage utilities

// MindM3rge Mobile: mirror every session update to the phone-accessible web view
// (Flask service on the AgentBox box, port 4011). Fire-and-forget — if the service
// is offline this silently no-ops and never blocks the extension. Requires the
// http://localhost:4011/* host permission in manifest.json.
const MIRROR_URL = 'http://localhost:4011/api/push';
function mirrorToWeb(session) {
  try {
    if (!session) return;
    fetch(MIRROR_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
      keepalive: true,
    }).catch(() => {});
  } catch (e) { /* web mirror offline — ignore */ }
}

export async function getSession() {
  const result = await chrome.storage.local.get('currentSession');
  return result.currentSession || null;
}

export async function saveSession(session) {
  await chrome.storage.local.set({ currentSession: session });
  mirrorToWeb(session);
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
  mirrorToWeb({ ...session, savedAt: new Date().toISOString() });
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
