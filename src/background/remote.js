// Remote-trigger poller — lets a phone-submitted job (queued on the AgentBox
// job API, port 4011) auto-start a validation session on this machine.
//
// MV3-correct: uses chrome.alarms (survives service-worker sleep — each alarm
// firing wakes the SW, re-runs the module top level, and re-registers the
// listeners before the onAlarm event is dispatched). No long-lived timers.
//
// Config lives in chrome.storage.local under 'remoteConfig':
//   { enabled: bool, token: string, base: string, extVersion: string }

const ALARM_NAME = 'mmRemotePoll';
const POLL_MINUTES = 0.5;            // 30s — Chrome 120+ minimum alarm period
const FETCH_TIMEOUT_MS = 15000;
const DEFAULT_BASE = 'http://localhost:4011';

let deps = null;          // { handleStartSession, getSession } injected by initRemote
let pollInFlight = false; // overlapping-poll guard (per SW lifetime — enough,
                          // since a sleeping SW has no poll in flight)

async function getRemoteConfig() {
  const result = await chrome.storage.local.get('remoteConfig');
  const cfg = result.remoteConfig || {};
  return {
    enabled: !!cfg.enabled,
    token: cfg.token || '',
    base: (cfg.base || DEFAULT_BASE).replace(/\/+$/, ''),
    extVersion: cfg.extVersion || chrome.runtime.getManifest().version,
  };
}

// fetch with bearer auth + hard timeout. Never hangs the poller on a dead
// backend; callers catch the abort/network error.
function authFetch(cfg, url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  return fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${cfg.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    signal: controller.signal,
  }).finally(() => clearTimeout(timer));
}

// Session status → job API status.
export function mapStatus(s) {
  if (s === 'complete') return 'done';
  if (s === 'awaiting_confirmation') return 'paused_waiting_review';
  if (s === 'cancelled') return 'cancelled';
  return 'running';
}

// POST /api/job/<id>/status — returns parsed JSON or null, never throws.
async function postJobStatus(cfg, jobId, payload) {
  try {
    const resp = await authFetch(cfg, `${cfg.base}/api/job/${jobId}/status`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    return await resp.json().catch(() => null);
  } catch (e) {
    console.log('[MindM3rge remote] status post failed:', String((e && e.message) || e));
    return null;
  }
}

// Chunked base64 — String.fromCharCode(...hugeArray) blows the arg-count limit
// on multi-MB files, so convert 32KB at a time.
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Download every job file (url is absolute + token-gated) → {name, base64, mimeType}
// in the shape handleStartSession expects. Throws on any failed download so the
// caller fails the whole job rather than starting it with missing files.
async function downloadJobFiles(cfg, job) {
  const files = [];
  for (const f of (job.files || [])) {
    const resp = await authFetch(cfg, f.url);
    if (!resp.ok) throw new Error(`file ${f.name}: HTTP ${resp.status}`);
    const buf = await resp.arrayBuffer();
    files.push({ name: f.name, base64: arrayBufferToBase64(buf), mimeType: f.mime });
    console.log(`[MindM3rge remote] downloaded file ${f.name} (${buf.byteLength} bytes)`);
  }
  return files;
}

async function pollOnce() {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    // a. config gate
    const cfg = await getRemoteConfig();
    if (!cfg.enabled || !cfg.token) return;

    // a2. sync manual-mode from the phone (mobile pause/unpause). The backend
    //     control value is authoritative for the remote toggle; mirror it into
    //     settings.manualMode so the dashboard + the guard below both reflect it.
    try {
      const resp = await authFetch(cfg, `${cfg.base}/api/control`);
      const ctrl = await resp.json();
      if (ctrl && ctrl.ok) {
        const cur = (await chrome.storage.local.get('settings')).settings || {};
        if (!!cur.manualMode !== !!ctrl.manual_mode) {
          cur.manualMode = !!ctrl.manual_mode;
          await chrome.storage.local.set({ settings: cur });
          console.log('[MindM3rge remote] manual mode synced from mobile ->', cur.manualMode);
        }
      }
    } catch (e) { /* control endpoint unreachable — keep local setting */ }

    // b. active-session guard — never claim while ANY session is running,
    //    remote or manual. If the active session is remote, heartbeat it so
    //    the backend sees liveness and can hand back a cancel signal.
    const s = await deps.getSession();
    if (s && s.status !== 'complete' && s.status !== 'cancelled') {
      if (s.remoteJobId) {
        const resp = await postJobStatus(cfg, s.remoteJobId, {
          status: mapStatus(s.status),
          session_id: s.id,
          ext_version: cfg.extVersion,
          // Report which model/step is running so the phone can name what's
          // stuck ("skip ChatGPT" / "move ChatGPT to end").
          current_model: s.currentModel,
          current_step: s.currentStep,
        });
        if (resp && resp.cancelled) {
          // Turn-boundary cancel: advanceSession checks this flag before
          // sending to the next model. Never yank a mid-turn capture.
          await chrome.storage.local.set({ remoteCancel: s.remoteJobId });
          console.log(`[MindM3rge remote] cancel requested for job ${s.remoteJobId} — will stop at next turn boundary`);
        } else if (resp && resp.command) {
          // One-shot turn command from mobile — UNLIKE cancel, these act NOW to
          // rescue a stuck mid-turn model (that's the whole point).
          const cmd = resp.command;
          console.log(`[MindM3rge remote] turn command from mobile: ${cmd}`);
          try {
            if (cmd === 'skip' && deps.handleSkipModel) await deps.handleSkipModel();
            else if (cmd === 'defer' && deps.handleDeferModel) await deps.handleDeferModel();
            else if (cmd === 'retry' && deps.handleRetryModel) await deps.handleRetryModel();
            else console.warn(`[MindM3rge remote] unknown/unwired command: ${cmd}`);
          } catch (e) {
            console.error('[MindM3rge remote] command dispatch failed:', e);
          }
        }
      }
      console.log('[MindM3rge remote] session active — not claiming');
      return;
    }

    // c. manual-mode guard — a human is driving the Mac; leave the queue alone.
    const settingsResult = await chrome.storage.local.get('settings');
    if (settingsResult.settings?.manualMode) {
      console.log('[MindM3rge remote] manual mode on — queue paused');
      return;
    }

    // d. claim the next job
    let job = null;
    try {
      const resp = await authFetch(cfg, `${cfg.base}/api/job/next?ext_version=${encodeURIComponent(cfg.extVersion)}`);
      const data = await resp.json();
      job = data && data.ok ? data.job : null;
    } catch (e) {
      console.log('[MindM3rge remote] job/next unreachable:', String((e && e.message) || e));
      return;
    }
    if (!job) return;
    console.log(`[MindM3rge remote] claimed job ${job.id} (${(job.models || []).join('+')}, ${job.passes} pass(es), ${(job.files || []).length} file(s))`);

    // e. download files
    let files = [];
    try {
      files = await downloadJobFiles(cfg, job);
    } catch (e) {
      console.error('[MindM3rge remote] file download failed:', e);
      await postJobStatus(cfg, job.id, { status: 'failed', error_class: 'file_download_failed', ext_version: cfg.extVersion });
      return;
    }

    // f. start the session through the exact same path as the dashboard
    const result = await deps.handleStartSession({
      prompt: job.prompt,
      starterModel: job.models[0],
      passes: job.passes,
      models: job.models,
      goal: job.goal,
      files,
      directives: [],
      evidenceMode: false,
      remoteJobId: job.id,
    });

    // g. report the outcome
    if (result && result.ok) {
      console.log(`[MindM3rge remote] job ${job.id} started as ${result.sessionId}`);
      await postJobStatus(cfg, job.id, { status: 'running', session_id: result.sessionId, ext_version: cfg.extVersion });
    } else {
      console.error(`[MindM3rge remote] job ${job.id} failed to start:`, result && result.error);
      await postJobStatus(cfg, job.id, { status: 'failed', error_class: 'start_failed', ext_version: cfg.extVersion });
    }
  } catch (e) {
    // Belt-and-braces: pollOnce must never throw into the alarm handler.
    console.error('[MindM3rge remote] pollOnce error:', e);
  } finally {
    pollInFlight = false;
  }
}

export function initRemote(injected) {
  deps = injected;  // { handleStartSession, getSession }

  // Registered synchronously at SW top level (index.js calls initRemote at
  // module scope), so the listener exists before Chrome dispatches the alarm
  // that woke the worker.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) pollOnce();
  });
  chrome.runtime.onStartup.addListener(() => pollOnce());

  // create() with an existing name replaces it — safe on every SW wake.
  chrome.alarms.create(ALARM_NAME, { periodInMinutes: POLL_MINUTES });

  // Immediate poll on init (SW wake / install / reload) so a queued job
  // doesn't wait for the first alarm tick.
  pollOnce();
}
