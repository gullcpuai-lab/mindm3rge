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
});

async function handleStartSession(data) {
  const { prompt, starterModel, passes, models, goal, fileContent, files, directives } = data;

  let fullPrompt = prompt;
  if (goal) {
    fullPrompt = `${prompt}\n\n--- DISCUSSION GOAL ---\n${goal}\n--- END GOAL ---\nIMPORTANT: The models should work collaboratively toward the above goal. Don't just critique — actively improve and fix issues to achieve this goal.`;
  }
  if (fileContent) {
    fullPrompt += `\n\n--- ATTACHED DOCUMENTS ---\n${fileContent}\n--- END DOCUMENTS ---`;
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

  await saveSession(session);

  // Open the starter model tab and inject the prompt + files
  await sendToModel(starterModel, fullPrompt, session.files);

  return { ok: true, sessionId: session.id };
}

async function handleResponseCaptured(data, tab) {
  const { model, response } = data;
  const session = await getSession();

  if (!session || session.status !== 'running') return { ok: false };

  // Record this turn
  session.turns.push({
    model,
    modelName: MODEL_NAMES[model],
    role: session.currentStep,
    round: session.currentPass,
    content: response,
    timestamp: new Date().toISOString(),
  });

  // Determine next step
  const nextAction = getNextAction(session);

  if (nextAction.done) {
    // Discussion complete
    session.status = 'complete';
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
  await saveSession(session);

  // Send the next prompt to the next model (with files if first time)
  await sendToModel(nextAction.model, nextAction.prompt, session.files);

  return { ok: true, nextModel: nextAction.model, nextStep: nextAction.step };
}

function getNextAction(session) {
  const { turns, starterModel, modelOrder, passes, currentPass, currentStep } = session;
  const otherModels = modelOrder.filter(m => m !== starterModel);

  if (currentStep === 'initial') {
    const prompt = buildCritiquePrompt(
      session.prompt,
      MODEL_NAMES[starterModel],
      turns[turns.length - 1].content,
      currentPass,
      passes,
      session.directives
    );
    return { done: false, model: otherModels[0], step: 'critique', pass: currentPass, prompt };
  }

  if (currentStep === 'critique') {
    const critiquesThisPass = turns.filter(t => t.role === 'critique' && t.round === currentPass);
    const uncritiqued = otherModels.filter(m => !critiquesThisPass.some(t => t.model === m));

    if (uncritiqued.length > 0) {
      const prompt = buildCritiquePrompt(
        session.prompt,
        turns.find(t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'))?.modelName || MODEL_NAMES[starterModel],
        turns.find(t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'))?.content || '',
        currentPass,
        passes,
        session.directives
      );
      return { done: false, model: uncritiqued[0], step: 'critique', pass: currentPass, prompt };
    }

    // All models critiqued — check if more passes
    if (currentPass < passes) {
      // Starter model revises
      const critiques = critiquesThisPass.map(t => ({ modelName: t.modelName, content: t.content }));
      const originalResponse = turns.find(t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'))?.content || '';
      const prompt = buildRevisionPrompt(session.prompt, MODEL_NAMES[starterModel], originalResponse, critiques);
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
    const prompt = buildCritiquePrompt(
      session.prompt,
      MODEL_NAMES[session.currentModel],
      turns[turns.length - 1].content,
      currentPass,
      passes,
      session.directives
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

  if (tabs.length > 0) {
    tab = tabs[0];
    // Only bring to front if tabs are visible
    if (!hideTabs) {
      await chrome.tabs.update(tab.id, { active: true });
    }
  } else {
    // Create tab — hidden (not active) if hideTabs is on
    tab = await chrome.tabs.create({ url, active: !hideTabs });
    llmTabIds.add(tab.id);

    // Wait for page to load
    await new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function listener(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      });
    });
    // Extra wait for JS to initialize
    await new Promise(r => setTimeout(r, 2000));
  }

  // Inject the prompt (and files on first message to each model) via content script
  const session = await getSession();
  let filesToSend = null;
  if (files && files.length > 0 && session && !session.filesUploaded[model]) {
    filesToSend = files;
    // Mark files as uploaded for this model
    session.filesUploaded[model] = true;
    await saveSession(session);
  }

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

async function handleCancelSession() {
  const session = await getSession();
  if (session) {
    session.status = 'cancelled';
    await saveSession(session);
  }
  return { ok: true };
}
