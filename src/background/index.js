// Background service worker — orchestrates the multi-model conversation

import { buildCritiquePrompt, buildRevisionPrompt, buildSynthesisPrompt } from '../utils/prompts.js';
import { getSession, saveSession, saveToHistory, getSettings } from '../utils/storage.js';

const DEBUG = false;

const MODEL_URLS = {
  claude: 'https://claude.ai/new',
  chatgpt: 'https://chatgpt.com/',
  gemini: 'https://gemini.google.com/app',
};

const MODEL_NAMES = {
  claude: 'Claude',
  chatgpt: 'ChatGPT',
  gemini: 'Gemini',
};

// Track LLM tab IDs for show/hide
const llmTabIds = new Set();
let hideTabs = true;
// Track which models got a fresh chat this session
const freshChatOpened = new Set();

// Open dashboard when extension icon is clicked
chrome.action.onClicked.addListener(() => {
  const dashboardUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
  chrome.tabs.query({ url: dashboardUrl }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url: dashboardUrl });
    }
  });
});

// Listen for messages from dashboard and content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'START_SESSION') {
    handleStartSession(message.data).then(sendResponse);
    return true;
  }

  if (message.type === 'RESPONSE_CAPTURED') {
    handleResponseCaptured(message.data, sender.tab).then(sendResponse);
    return true;
  }

  if (message.type === 'SELECTOR_ERROR') {
    handleSelectorError(message);
    return false;
  }

  if (message.type === 'HEALTH_CHECK_REPORT') {
    DEBUG && console.log('[MindM3rge] Health check:', JSON.stringify(message.report, null, 2));
    // Store for debugging
    chrome.storage.local.get('errorLogs', (result) => {
      const logs = result.errorLogs || [];
      logs.unshift({ ...message, receivedAt: new Date().toISOString() });
      chrome.storage.local.set({ errorLogs: logs.slice(0, 50) }); // keep last 50
    });
    return false;
  }

  if (message.type === 'CHECK_CONNECTION') {
    checkModelConnection(message.model).then(sendResponse);
    return true;
  }

  if (message.type === 'TOGGLE_TABS') {
    handleToggleTabs(message.visible);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_STATUS') {
    getSession().then(session => {
      sendResponse({ session });
    });
    return true;
  }

  if (message.type === 'CANCEL_SESSION') {
    handleCancelSession().then(sendResponse);
    return true;
  }

  if (message.type === 'SKIP_MODEL') {
    handleSkipModel().then(sendResponse);
    return true;
  }

  if (message.type === 'RETRY_MODEL') {
    handleRetryModel().then(sendResponse);
    return true;
  }

  if (message.type === 'FORCE_CAPTURE') {
    handleForceCapture().then(sendResponse);
    return true;
  }

  if (message.type === 'MANUAL_RESPONSE') {
    handleManualResponse(message.response).then(sendResponse);
    return true;
  }

  if (message.type === 'CONFIRM_RESPONSE') {
    // v0.6.0 — user confirmed a short ChatGPT capture is correct; resume.
    handleConfirmResponse().then(sendResponse);
    return true;
  }

  if (message.type === 'REPLACE_AND_CONTINUE') {
    // v0.6.0 — user hand-pasted the real response for a short capture; replace
    // the recorded turn and resume.
    handleReplaceAndContinue(message.response).then(sendResponse);
    return true;
  }

  if (message.type === 'CAPTURE_VIA_FOCUS') {
    // v0.5.3 — User-suggested approach: briefly switch focus to the
    // chatgpt tab so the content script can click the Copy response
    // button AND read navigator.clipboard.readText() (which requires
    // the tab to be focused). Then restore focus to wherever the user
    // was. Avoids the entire 'inject a page-world monkey-patch and
    // hope ChatGPT uses navigator.clipboard' dance from v0.5.0-0.5.2.
    handleCaptureViaFocus(sender.tab?.id).then(sendResponse);
    return true;
  }

  if (message.type === 'EDIT_TURN') {
    // Dashboard sent a corrected response for an already-captured turn.
    // Update session.turns[turnIndex].content so future prompts in the
    // chain pick up the corrected text. Does NOT retroactively change
    // prompts already sent to downstream models — that ship has sailed.
    handleEditTurn(message.turnIndex, message.content).then(sendResponse);
    return true;
  }
});

async function handleStartSession(data) {
  const { prompt, starterModel, passes, models, goal, fileContent, files, directives } = data;

  // Reset fresh chat tracking for new session
  freshChatOpened.clear();

  // Build prompts — files are uploaded natively, never injected as text
  const noArtifacts = '\n\nIMPORTANT: Do NOT create downloadable files, artifacts, or code blocks with download buttons. Put your ENTIRE response directly in the chat text. Everything must be readable in the conversation — nothing hidden in attachments.';
  let initialPrompt = prompt + noArtifacts;

  // Full prompt with goal context — used in critique/revision prompts
  let fullPrompt = prompt;
  if (goal) {
    fullPrompt = `${prompt}\n\n--- DISCUSSION GOAL ---\n${goal}\n--- END GOAL ---`;
  }

  // Determine model order from selected participants
  const allModels = models || ['claude', 'chatgpt', 'gemini'];
  const otherModels = allModels.filter(m => m !== starterModel);

  const session = {
    id: `session_${Date.now()}`,
    prompt: fullPrompt,
    originalPrompt: prompt,
    starterModel,
    passes,
    currentPass: 1,
    currentStep: 'initial',
    currentModel: starterModel,
    modelOrder: [starterModel, ...otherModels],
    turns: [],
    files: files || [],
    filesUploaded: {},
    goal: goal || '',
    directives: directives || [],
    status: 'running',
    createdAt: new Date().toISOString(),
  };

  // Track the prompt actually sent so the dashboard can show it later.
  session.lastPromptSent = initialPrompt;

  // Always resolve with a result — if anything throws (storage quota from large
  // file payloads, tab/messaging failure), return {ok:false} so the dashboard
  // resets instead of sitting on "Starting…" forever.
  try {
    await saveSession(session);
    // Send just the user's question to the starter model (no meta-instructions)
    await sendToModel(starterModel, initialPrompt, session.files);
    return { ok: true, sessionId: session.id };
  } catch (e) {
    console.error('[MindM3rge] handleStartSession failed:', e);
    return { ok: false, error: String((e && e.message) || e) };
  }
}

// v0.6.0 — Short-result guard thresholds. ChatGPT capture can still grab only
// the thinking PREAMBLE (1-2 sentences) instead of the full answer. When a
// captured ChatGPT response looks suspiciously short, we PAUSE the rotation and
// ask the user to confirm it copied correctly (or hand-paste the real answer)
// before continuing. See handleConfirmResponse / handleReplaceAndContinue.
const SHORT_GUARD_MIN_CHARS = 400;   // below this → always confirm
const SHORT_GUARD_SOFT_CHARS = 700;  // below this AND <=2 sentences → confirm

function isSuspiciouslyShort(text) {
  const t = (text || '').trim();
  if (t.length < SHORT_GUARD_MIN_CHARS) return true;
  const sentences = (t.match(/[.!?](\s|$)/g) || []).length;
  if (sentences <= 2 && t.length < SHORT_GUARD_SOFT_CHARS) return true;
  return false;
}

// v0.6.3 — diagnostics event log. Records what happened during a run (captures,
// stray rejections, guard pauses, edits with their X->Y delta, advances) onto
// session.diagnostics so the user can export a bug report for debugging the
// copy/paste issues. Mutates session; the caller is responsible for saving.
function logDiag(session, type, details = {}) {
  if (!session.diagnostics) session.diagnostics = [];
  session.diagnostics.push({ t: new Date().toISOString(), type, ...details });
  if (session.diagnostics.length > 300) session.diagnostics = session.diagnostics.slice(-300);
}

async function handleResponseCaptured(data, tab, opts = {}) {
  const { model, response } = data;
  const session = await getSession();

  if (!session || session.status !== 'running') return { ok: false };

  // v0.6.2 — reject stray / cross-tab / late captures: only accept a response
  // from the model whose turn is currently ACTIVE. Otherwise a leftover
  // response in another model's tab (e.g. from a previous run, a stale content
  // script after an extension reload, or a previous turn's observer firing
  // late) gets recorded under the wrong model with the current step's role —
  // which corrupts the whole rotation. Observed: a ChatGPT preamble left in a
  // background tab was recorded as the "initial" turn while Claude was the
  // active starter, so getNextAction then mis-routed back to ChatGPT and the
  // turn order/labels broke. FORCE_CAPTURE and MANUAL_RESPONSE pass the current
  // model, so they always match this guard.
  if (model !== session.currentModel) {
    DEBUG && console.warn(`[MindM3rge] ignoring stray ${model} capture — active model is ${session.currentModel}`);
    logDiag(session, 'capture_ignored', {
      got: model, expected: session.currentModel,
      len: (response || '').trim().length, sourceUrl: tab?.url || null,
    });
    await saveSession(session);
    return { ok: false, ignored: true, reason: 'model-mismatch', expected: session.currentModel, got: model };
  }

  // Record this turn — including the prompt that was actually sent to this
  // model, so the dashboard can render Prompts+Responses exports and prove
  // the chain of context is being passed between models round-to-round.
  // v0.6.3 — also stash diagnostics: the originally-captured text (so we can
  // show the X->Y delta if the user later edits it), the conversation URL of
  // the model tab, and how it was captured.
  const nowTs = new Date().toISOString();
  session.turns.push({
    model,
    modelName: MODEL_NAMES[model],
    role: session.currentStep,
    round: session.currentPass,
    content: response,
    originalContent: response,           // auto-captured text (X), preserved across edits
    sourceUrl: tab?.url || null,         // the model conversation link
    capturePath: data.capturePath || null,
    promptSent: session.lastPromptSent || session.prompt,
    timestamp: nowTs,
    capturedAt: nowTs,
  });
  logDiag(session, 'capture', {
    model, role: session.currentStep, round: session.currentPass,
    len: (response || '').trim().length,
    capturePath: data.capturePath || null, sourceUrl: tab?.url || null,
  });

  // Pause for confirmation when either:
  //  (a) v0.6.1 MANUAL REVIEW MODE is on — pause after EVERY captured response
  //      (any model) so the user can review / edit / replace it before it
  //      carries forward; or
  //  (b) v0.6.0 SHORT-RESULT GUARD trips — a suspiciously short ChatGPT capture
  //      (e.g. only the thinking preamble) that would otherwise propagate.
  // User-supplied pastes (opts.skipGuard) bypass both.
  const settings = await getSettings();
  const manualMode = !!(settings && settings.manualMode);
  const shortGuard = model === 'chatgpt' && isSuspiciouslyShort(response);
  if (!opts.skipGuard && (manualMode || shortGuard)) {
    const reason = shortGuard ? 'short_response' : 'manual_mode';
    session.status = 'awaiting_confirmation';
    session.pendingConfirmation = {
      turnIndex: session.turns.length - 1,
      model,
      modelName: MODEL_NAMES[model],
      reason,
      length: (response || '').trim().length,
      preview: (response || '').trim().slice(0, 600),
      capturedAt: new Date().toISOString(),
    };
    logDiag(session, 'paused', { reason, model, len: (response || '').trim().length });
    await saveSession(session);
    chrome.runtime.sendMessage({ type: 'CONFIRMATION_REQUIRED', session });
    chrome.notifications?.create({
      type: 'basic',
      iconUrl: '/public/icons/icon128.png',
      title: reason === 'short_response' ? 'MindM3rge — Check ChatGPT response' : 'MindM3rge — Review response',
      message: reason === 'short_response'
        ? `Captured only ${(response || '').trim().length} chars from ChatGPT. Paused for your confirmation.`
        : `Manual review: verify ${MODEL_NAMES[model] || model}'s response before continuing.`,
    });
    return { ok: true, awaitingConfirmation: true };
  }

  return await advanceSession(session);
}

// Advance the rotation from the current session state (turns already recorded).
// Shared by handleResponseCaptured and the post-confirmation resume handlers.
async function advanceSession(session) {
  const nextAction = getNextAction(session);

  if (nextAction.done) {
    // Discussion complete
    session.status = 'complete';
    logDiag(session, 'complete', { turns: session.turns.length });
    await saveSession(session);
    await saveToHistory(session);

    // Notify popup
    chrome.runtime.sendMessage({ type: 'SESSION_COMPLETE', session });

    if (session.turns.length > 0) {
      chrome.notifications?.create({
        type: 'basic',
        iconUrl: '/public/icons/icon128.png',
        title: 'MindM3rge — Discussion Complete',
        message: `${session.turns.length} turns across ${session.currentPass} passes. View results in the extension.`,
      });
    }

    return { ok: true, complete: true };
  }

  // Update session state
  session.currentStep = nextAction.step;
  session.currentModel = nextAction.model;
  session.currentPass = nextAction.pass;
  session.lastPromptSent = nextAction.prompt;
  logDiag(session, 'advance', { toModel: nextAction.model, step: nextAction.step, pass: nextAction.pass });
  await saveSession(session);

  // Send the next prompt to the next model (with files if first time)
  await sendToModel(nextAction.model, nextAction.prompt, session.files);

  return { ok: true, nextModel: nextAction.model, nextStep: nextAction.step };
}

// v0.6.0 — user confirmed the (short) ChatGPT capture is correct; resume.
async function handleConfirmResponse() {
  const session = await getSession();
  if (!session || session.status !== 'awaiting_confirmation') return { ok: false };
  session.status = 'running';
  delete session.pendingConfirmation;
  await saveSession(session);
  return await advanceSession(session);
}

// v0.6.0 — user hand-pasted the correct response; replace the captured turn's
// content (so downstream prompts pick it up) and resume.
async function handleReplaceAndContinue(responseText) {
  const session = await getSession();
  if (!session || session.status !== 'awaiting_confirmation') return { ok: false };
  const pc = session.pendingConfirmation;
  if (pc && typeof pc.turnIndex === 'number' && session.turns[pc.turnIndex]) {
    const turn = session.turns[pc.turnIndex];
    const fromLen = (turn.content || '').trim().length;
    turn.content = responseText;
    turn.userEdited = true;
    turn.editedAt = new Date().toISOString();
    turn.editReason = pc.reason || 'manual_replace';   // 'short_response' | 'manual_mode'
    logDiag(session, 'edited', {
      turnIndex: pc.turnIndex, model: turn.model, reason: turn.editReason,
      fromLen, toLen: (responseText || '').trim().length,
    });
  }
  session.status = 'running';
  delete session.pendingConfirmation;
  await saveSession(session);
  return await advanceSession(session);
}

function getNextAction(session) {
  const { turns, starterModel, modelOrder, passes, currentPass, currentStep } = session;
  const otherModels = modelOrder.filter(m => m !== starterModel);

  if (currentStep === 'initial') {
    // First critique — send full discussion so far to first other model
    const prompt = buildCritiquePrompt(
      session.prompt,
      MODEL_NAMES[starterModel],
      turns[turns.length - 1].content,
      currentPass,
      passes,
      session.directives,
      turns  // all turns so far
    );
    return { done: false, model: otherModels[0], step: 'critique', pass: currentPass, prompt };
  }

  if (currentStep === 'critique') {
    const critiquesThisPass = turns.filter(t => t.role === 'critique' && t.round === currentPass);
    const uncritiqued = otherModels.filter(m => !critiquesThisPass.some(t => t.model === m));

    if (uncritiqued.length > 0) {
      // Chain: include ALL turns so each model sees the full discussion history
      const prompt = buildCritiquePrompt(
        session.prompt,
        '',
        '',
        currentPass,
        passes,
        session.directives,
        turns  // all turns so far
      );
      return { done: false, model: uncritiqued[0], step: 'critique', pass: currentPass, prompt };
    }

    // All models critiqued — check if more passes
    if (currentPass < passes) {
      // Starter model revises — pass ALL prior turns so it sees full
      // cross-model history across all prior passes (fixes pass-3+ context reset)
      const critiques = critiquesThisPass.map(t => ({ modelName: t.modelName, content: t.content }));
      const originalResponse = turns.find(t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'))?.content || '';
      const prompt = buildRevisionPrompt(session.prompt, MODEL_NAMES[starterModel], originalResponse, critiques, turns);
      return { done: false, model: starterModel, step: 'revision', pass: currentPass + 1, prompt };
    }

    // Final pass done — synthesize
    const prompt = buildSynthesisPrompt(session.prompt, turns);
    // Use the model that hasn't gone last as synthesizer
    const lastModel = turns[turns.length - 1].model;
    const synthesizer = modelOrder.find(m => m !== lastModel) || modelOrder[0];
    return { done: false, model: synthesizer, step: 'synthesis', pass: currentPass, prompt };
  }

  if (currentStep === 'revision') {
    // After revision, send full discussion history to first critic
    const prompt = buildCritiquePrompt(
      session.prompt,
      MODEL_NAMES[session.currentModel],
      turns[turns.length - 1].content,
      currentPass,
      passes,
      session.directives,
      turns  // all turns so far
    );
    return { done: false, model: otherModels[0], step: 'critique', pass: currentPass, prompt };
  }

  if (currentStep === 'synthesis') {
    return { done: true };
  }

  return { done: true };
}

function handleSelectorError(report) {
  // Log to storage
  chrome.storage.local.get('errorLogs', (result) => {
    const logs = result.errorLogs || [];
    logs.unshift(report);
    chrome.storage.local.set({ errorLogs: logs.slice(0, 50) });
  });

  // Format error for notification
  const broken = [];
  if (report.healthCheck?.elements) {
    for (const [el, info] of Object.entries(report.healthCheck.elements)) {
      if (info.status === 'broken') broken.push(el);
    }
  }

  // Show notification
  chrome.notifications?.create({
    type: 'basic',
    iconUrl: '/public/icons/icon128.png',
    title: `MindM3rge — Selector Issue (${report.model})`,
    message: `Broken: ${broken.join(', ')}. Check error logs in extension storage.`,
  });

  DEBUG && console.error('[MindM3rge] Selector error report:', JSON.stringify(report, null, 2));
}

async function checkModelConnection(model) {
  const domains = {
    claude: 'claude.ai',
    chatgpt: 'chatgpt.com',
    gemini: 'gemini.google.com',
  };
  const domain = domains[model];
  if (!domain) return { connected: false };

  // Check if there's an existing tab for this model
  const tabs = await chrome.tabs.query({ url: `https://${domain}/*` });
  if (tabs.length > 0) {
    // Tab exists — try to check if logged in via content script
    try {
      const response = await chrome.tabs.sendMessage(tabs[0].id, { type: 'CHECK_LOGIN' });
      return { connected: response?.loggedIn ?? true }; // assume connected if tab exists
    } catch {
      return { connected: true }; // tab exists but content script not loaded yet — likely fine
    }
  }

  return { connected: false };
}

function handleToggleTabs(visible) {
  hideTabs = !visible;
  for (const tabId of llmTabIds) {
    // Chrome doesn't have a true "hide" API, but we can minimize the tab's visibility
    // by switching to the dashboard tab when hiding
    if (!visible) {
      // Find dashboard tab and activate it
      const dashUrl = chrome.runtime.getURL('src/dashboard/dashboard.html');
      chrome.tabs.query({ url: dashUrl }, (tabs) => {
        if (tabs.length > 0) chrome.tabs.update(tabs[0].id, { active: true });
      });
    }
  }
}

async function sendToModel(model, prompt, files) {
  const url = MODEL_URLS[model];

  // Find or create tab for this model
  const domain = `${url.split('/')[0]}//${url.split('/')[2]}/*`;
  const tabs = await chrome.tabs.query({ url: domain });
  let tab;
  let needsLoad = false;

  const needsFreshChat = !freshChatOpened.has(model);

  if (tabs.length > 0) {
    tab = tabs[0];
    if (needsFreshChat) {
      if (model === 'gemini') {
        // Gemini is a SPA — navigating tabs.update() to /app while the tab
        // is already at /app is effectively a no-op (Gemini hides the
        // conversation ID via History API and restores the last chat from
        // local state). The reliable way to force a fresh chat is to close
        // the existing tab and create a new one.
        await chrome.tabs.remove(tab.id);
        llmTabIds.delete(tab.id);
        tab = await chrome.tabs.create({ url, active: !hideTabs });
        llmTabIds.add(tab.id);
      } else {
        // First visit this session — navigate to fresh chat
        await chrome.tabs.update(tab.id, { url, active: !hideTabs });
      }
      needsLoad = true;
    } else {
      // Same session, reuse existing chat thread
      if (!hideTabs) {
        await chrome.tabs.update(tab.id, { active: true });
      }
    }
  } else {
    // Create tab — hidden (not active) if hideTabs is on
    tab = await chrome.tabs.create({ url, active: !hideTabs });
    llmTabIds.add(tab.id);
    needsLoad = true;
  }

  if (needsLoad) {
    // Wait for the page to finish loading. Three ways out, so this can NEVER
    // hang "Starting…" forever: (1) the onUpdated 'complete' event, (2) an
    // immediate check in case the page already completed before the listener
    // attached (the race that wedged it), (3) a hard 30s timeout.
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timeoutId);
        resolve();
      };
      function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') finish();
      }
      chrome.tabs.onUpdated.addListener(listener);
      // Race guard: the tab may already be 'complete' before we listened.
      chrome.tabs.get(tab.id, (t) => {
        if (!chrome.runtime.lastError && t && t.status === 'complete') finish();
      });
      const timeoutId = setTimeout(finish, 30000);
    });
    // Extra wait for JS to initialize
    await new Promise(r => setTimeout(r, 3000));
  }

  // Gemini's chat UI sometimes wedges in a "generating" state on reused
  // threads — typing manually after a prior round shows a Stop button
  // instead of Send. Always force a fresh chat for Gemini per round.
  // The full discussion history is injected into every prompt, so
  // cross-round context isn't lost.
  //
  // ChatGPT is added to the always-fresh list in v0.5.2 — reusing the
  // chat across rounds means multiple assistant turns accumulate in
  // the DOM, each with its own Copy response button. The v0.5.1 copy-
  // button locator picks the LAST one in document order, which is
  // correct ONCE the new round's toolbar has rendered — but during the
  // brief window between "new round's prose visible" and "new round's
  // toolbar exists," the locator would return the PRIOR round's button
  // and capture the prior round's text again. Always-fresh chat
  // eliminates that race entirely: round N's chat has exactly one
  // assistant turn and exactly one copy button.
  if (model !== 'gemini' && model !== 'chatgpt') {
    freshChatOpened.add(model);
  }

  // Upload files only on first visit (fresh chat) — subsequent turns reuse the chat
  const filesToSend = (needsFreshChat && files && files.length > 0) ? files : null;

  // Retry sending message — content script may not be ready yet
  const message = { type: 'INJECT_PROMPT', prompt, files: filesToSend };
  let sent = false;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      sent = true;
      break;
    } catch (e) {
      DEBUG && console.warn(`[MindM3rge] sendToModel(${model}) attempt ${attempt + 1} failed:`, e.message);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  if (!sent) {
    DEBUG && console.error(`[MindM3rge] Failed to send prompt to ${model} after 5 attempts`);
  }
}

async function handleCaptureViaFocus(chatgptTabId) {
  if (!chatgptTabId) return { ok: false, error: 'no tab id from sender' };
  let previouslyActiveTabId = null;
  let previousWindowId = null;
  try {
    // Find what's currently focused so we can restore.
    const target = await chrome.tabs.get(chatgptTabId);
    if (!target) return { ok: false, error: 'tab gone' };
    previousWindowId = target.windowId;
    const activeTabs = await chrome.tabs.query({ active: true, windowId: target.windowId });
    if (activeTabs.length > 0 && activeTabs[0].id !== chatgptTabId) {
      previouslyActiveTabId = activeTabs[0].id;
    }
    // Make sure the chatgpt tab's window is focused too — focus is
    // window-scoped on macOS/Linux.
    try { await chrome.windows.update(target.windowId, { focused: true }); } catch {}
    // Focus the chatgpt tab so the page can read clipboard.
    await chrome.tabs.update(chatgptTabId, { active: true });
    // Tiny settle wait for focus to register at the OS level.
    await new Promise((r) => setTimeout(r, 250));
    // Ask the content script to run the click+read sequence now that
    // it's the foreground tab.
    const result = await chrome.tabs.sendMessage(chatgptTabId, {
      type: 'DO_CAPTURE_WITH_CLIPBOARD',
    }).catch((e) => ({ ok: false, error: e.message }));
    return result || { ok: false, error: 'content script returned nothing' };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Restore focus to whichever tab was active before — even on
    // failure paths. Best-effort; ignore restoration errors.
    if (previouslyActiveTabId) {
      try { await chrome.tabs.update(previouslyActiveTabId, { active: true }); } catch {}
    }
  }
}

async function handleEditTurn(turnIndex, newContent) {
  // Validates and applies a user edit to a captured turn. Saves to
  // storage so subsequent prompt-builder calls (buildCritiquePrompt /
  // buildRevisionPrompt / buildSynthesisPrompt) read the corrected
  // text. The session does NOT need to be 'running' — the user can
  // also edit turns of a 'complete' session for export purposes.
  if (typeof turnIndex !== 'number' || !Number.isInteger(turnIndex)) {
    return { ok: false, error: 'Invalid turnIndex' };
  }
  if (typeof newContent !== 'string') {
    return { ok: false, error: 'Invalid content' };
  }
  const session = await getSession();
  if (!session) return { ok: false, error: 'No active session' };
  if (turnIndex < 0 || turnIndex >= session.turns.length) {
    return { ok: false, error: 'turnIndex out of range' };
  }
  const turn = session.turns[turnIndex];
  const fromLen = (turn.content || '').trim().length;
  // Preserve the auto-captured text the first time a turn is edited so the
  // diagnostics report can show the X->Y delta even for inline card edits.
  if (turn.originalContent == null) turn.originalContent = turn.content;
  turn.content = newContent;
  turn.userEdited = true;
  turn.editedAt = new Date().toISOString();
  turn.editReason = turn.editReason || 'inline_edit';
  logDiag(session, 'edited', {
    turnIndex, model: turn.model, reason: 'inline_edit',
    fromLen, toLen: (newContent || '').trim().length,
  });
  await saveSession(session);
  return { ok: true, turnIndex, length: newContent.length };
}

async function handleManualResponse(responseText) {
  const session = await getSession();
  if (!session || session.status !== 'running') return { ok: false };

  // Feed the pasted response directly into the session as if the model
  // responded. skipGuard: this is the user's own paste — never second-guess it
  // with the short-result confirmation.
  await handleResponseCaptured(
    { model: session.currentModel, response: responseText },
    null,
    { skipGuard: true }
  );
  return { ok: true };
}

async function handleForceCapture() {
  const session = await getSession();
  if (!session || session.status !== 'running') return { ok: false };

  const model = session.currentModel;
  const url = MODEL_URLS[model];
  const domain = `${url.split('/')[0]}//${url.split('/')[2]}/*`;
  const tabs = await chrome.tabs.query({ url: domain });

  if (tabs.length === 0) return { ok: false, error: 'No tab found' };

  try {
    const result = await chrome.tabs.sendMessage(tabs[0].id, { type: 'FORCE_CAPTURE' });
    if (result?.response) {
      // Manually feed the response into the session
      await handleResponseCaptured({ model, response: result.response }, tabs[0]);
      return { ok: true };
    }
  } catch (e) {
    DEBUG && console.error('[MindM3rge] Force capture failed:', e.message);
  }
  return { ok: false, error: 'No response found' };
}

async function handleRetryModel() {
  const session = await getSession();
  if (!session || session.status !== 'running') return { ok: false };

  const model = session.currentModel;

  // Force a fresh chat for this model by removing it from freshChatOpened
  freshChatOpened.delete(model);

  // Rebuild the prompt for the current step
  const nextAction = getNextAction(session);
  const prompt = nextAction.done ? session.prompt : nextAction.prompt;

  // Track the retried prompt so the dashboard can show it.
  session.lastPromptSent = prompt;
  await saveSession(session);

  // Send to the same model in a fresh chat
  await sendToModel(model, prompt, session.files);
  return { ok: true, model };
}

async function handleSkipModel() {
  const session = await getSession();
  if (!session || session.status !== 'running') return { ok: false };

  // Add a placeholder turn for the skipped model
  session.turns.push({
    model: session.currentModel,
    modelName: MODEL_NAMES[session.currentModel] || session.currentModel,
    role: session.currentStep,
    round: session.currentPass,
    content: '[This model was skipped]',
    timestamp: new Date().toISOString(),
    skipped: true,
  });

  // Determine next action as if the model had responded
  const nextAction = getNextAction(session);

  if (nextAction.done) {
    session.status = 'complete';
    await saveSession(session);
    await saveToHistory(session);
    chrome.runtime.sendMessage({ type: 'SESSION_COMPLETE', session });
    return { ok: true, complete: true };
  }

  session.currentStep = nextAction.step;
  session.currentModel = nextAction.model;
  session.currentPass = nextAction.pass;
  session.lastPromptSent = nextAction.prompt;
  await saveSession(session);

  await sendToModel(nextAction.model, nextAction.prompt, session.files);
  return { ok: true, nextModel: nextAction.model };
}

async function handleCancelSession() {
  const session = await getSession();
  if (session) {
    session.status = 'cancelled';
    await saveSession(session);
  }
  return { ok: true };
}
