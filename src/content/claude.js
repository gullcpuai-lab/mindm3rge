// Content script for claude.ai — self-healing with selector engine

const DEBUG = false;
let isWaitingForResponse = false;
let lastResponseText = '';

// Import selector engine (injected as global since content scripts can't use ES modules)
// The functions are defined inline here for content script compatibility

const SELECTORS = {
  input: [
    'div[contenteditable="true"]', 'div.ProseMirror',
    'fieldset div[contenteditable="true"]', '[data-placeholder*="How can"]',
  ],
  sendButton: [
    'button[aria-label="Send message"]', 'button[type="submit"]',
    'fieldset button:has(svg)', 'button[aria-label="Send"]',
  ],
  response: [
    '.standard-markdown', '[class*="response"]',
    '.prose', '[class*="message-content"]',
  ],
  stopButton: [
    'button[aria-label*="Stop"]', 'button:has(svg.animate-spin)',
  ],
  fileInput: ['input[type="file"]'],
  uploadButton: ['button[aria-label="Add files, connectors, and more"]', 'button[aria-label*="Add files" i]', 'button[aria-label*="attach" i]', 'button[aria-label*="upload" i]', 'button[aria-label="Add content"]'],
};

function find(type) {
  for (const sel of SELECTORS[type] || []) {
    const el = document.querySelector(sel);
    if (el) return { el, method: 'selector', selector: sel };
  }
  // Auto-discovery fallback
  if (type === 'input') {
    const candidates = [...document.querySelectorAll('[contenteditable="true"], textarea')];
    const found = candidates.filter(el => {
      const r = el.getBoundingClientRect();
      return r.bottom > window.innerHeight * 0.5 && r.width > 200;
    }).sort((a, b) => b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom)[0];
    if (found) return { el: found, method: 'discovery' };
  }
  if (type === 'sendButton') {
    const found = [...document.querySelectorAll('button')].filter(b => {
      const label = (b.getAttribute('aria-label') || '').toLowerCase();
      return label.includes('send') && !b.disabled;
    })[0];
    if (found) return { el: found, method: 'discovery' };
  }
  return { el: null, method: 'failed' };
}

function findAll(type) {
  for (const sel of SELECTORS[type] || []) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return [...els];
  }
  return [];
}

function reportBroken(elementType, details) {
  DEBUG && console.warn(`[MindM3rge] Claude selector broken: ${elementType}`, details);
  try {
    chrome.runtime.sendMessage({
      type: 'SELECTOR_ERROR',
      model: 'claude',
      elementType,
      url: window.location.href,
      timestamp: new Date().toISOString(),
      details,
      triedSelectors: SELECTORS[elementType],
    });
  } catch {}
}

// Run health check on load
setTimeout(() => {
  const report = {};
  for (const type of Object.keys(SELECTORS)) {
    const result = find(type);
    report[type] = { found: !!result.el, method: result.method };
    if (!result.el && type !== 'stopButton' && type !== 'fileInput') {
      reportBroken(type, { status: 'not found on page load' });
    }
  }
  DEBUG && console.log('[MindM3rge] Claude health check:', report);
  try {
    chrome.runtime.sendMessage({ type: 'HEALTH_CHECK_REPORT', model: 'claude', report });
  } catch {}
}, 3000);

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PROMPT') {
    if (message.files && message.files.length > 0) {
      uploadFilesThenPrompt(message.files, message.prompt).then(() => sendResponse({ ok: true }));
    } else {
      injectPrompt(message.prompt);
      sendResponse({ ok: true });
    }
  }
  if (message.type === 'CHECK_LOGIN') {
    const isLoggedIn = !window.location.href.includes('/login');
    sendResponse({ loggedIn: isLoggedIn });
  }
  if (message.type === 'FORCE_CAPTURE') {
    const responses = findAll('response');
    if (responses.length > 0) {
      const text = responses[responses.length - 1].innerText || responses[responses.length - 1].textContent;
      const fullResponse = text + captureArtifacts();
      lastResponseText = text;
      isWaitingForResponse = false;
      sendResponse({ response: fullResponse });
    } else {
      sendResponse({ response: null });
    }
  }
  return true;
});

// Wait until `expected` uploaded-file previews have actually rendered (or
// timeout). This is the fix for the race where the prompt was sent before all
// files finished uploading, dropping some of a multi-file batch. Robust across
// DOM churn: counts BOTH known chip elements AND visible occurrences of the
// uploaded filenames. Returns the highest count observed.
// Prevents a duplicated uploadFilesThenPrompt / INJECT_PROMPT delivery from
// attaching the same files twice. Reset in the finally block once the prompt
// has been injected, so the next legitimate session works normally.
let uploadInFlight = false;

// Attachment counting. NOTE: [data-testid="file-upload"] is NOT a card — it is
// the hidden <input type=file> itself (always exactly one, regardless of file
// count). Counting it made multi-file uploads time out (count stuck at 1). The
// real cards are [data-testid="file-thumbnail"], which Claude renders ~3x per
// file for responsive layouts — so we key everything on DISTINCT filenames
// (each thumbnail's <h3> text), never on raw element count.
const FILE_THUMBNAIL_SELECTOR = '[data-testid="file-thumbnail"]';

function getThumbnailEls() {
  try {
    return Array.from(document.querySelectorAll(FILE_THUMBNAIL_SELECTOR));
  } catch (e) { return []; }
}

function thumbnailFileName(el) {
  try {
    // Preferred: each thumbnail contains an <h3> whose text is exactly the filename.
    const h3 = el.querySelector('h3');
    if (h3 && h3.textContent && h3.textContent.trim()) return h3.textContent.trim();
    // Fallback: textContent is "name.ext<metadata>" — take the leading filename token.
    const text = (el.textContent || '').trim();
    const m = text.match(/^\S+?\.[A-Za-z0-9]{1,8}/);
    return m ? m[0] : text.slice(0, 80);
  } catch (e) { return ''; }
}

function getUploadedFileNames() {
  const names = new Set();
  for (const el of getThumbnailEls()) {
    const name = thumbnailFileName(el);
    if (name) names.add(name);
  }
  return names;
}

// One representative thumbnail per distinct filename (dedupes the ~3x render).
function getFileCards() {
  const byName = new Map();
  for (const el of getThumbnailEls()) {
    const name = thumbnailFileName(el);
    if (name && !byName.has(name)) byName.set(name, el);
  }
  return Array.from(byName.values());
}

function cardIsBusy(card) {
  try {
    if (card.getAttribute('aria-busy') === 'true') return true;
    return !!card.querySelector(
      '[role="progressbar"], [class*="progress"], svg.animate-spin, [aria-busy="true"]'
    );
  } catch (e) {
    return false;
  }
}

// Gate: resolves true ONLY when every expected filename is rendered as a
// thumbnail, none of its copies is busy, and the present-name set is stable for
// ~1s. Keys on DISTINCT filenames (never raw element count), so the 3x-per-file
// render and the ever-present hidden <input> can't skew it. Over-attach of an
// UNEXPECTED name (not in the pre-attach baseline) is logged, never fatal.
async function waitForUploads(expectedNames, timeoutMs, baselineNames) {
  timeoutMs = timeoutMs || 45000;
  const POLL_MS = 250;
  const STABLE_POLLS = 4;
  const start = Date.now();
  const expected = (expectedNames || []).map(n => String(n).trim()).filter(Boolean);
  const baseline = baselineNames instanceof Set
    ? baselineNames
    : new Set(baselineNames || []);
  let stable = 0;
  let lastKey = null;
  let lastBusy = true;
  let lastPresent = [];

  while (Date.now() - start < timeoutMs) {
    let present = new Set();
    let busy = true;
    try {
      present = getUploadedFileNames();
      // Busy if ANY rendered copy of any thumbnail is still uploading.
      busy = getThumbnailEls().some(cardIsBusy);
    } catch (e) { /* transient DOM error — counts as an unstable poll */ }
    const presentArr = Array.from(present).sort();
    const key = presentArr.join(' ');
    const allPresent = expected.every(n => present.has(n));

    if (allPresent && !busy && key === lastKey) stable++;
    else stable = 0;
    lastKey = key;
    lastBusy = busy;
    lastPresent = presentArr;

    if (stable >= STABLE_POLLS) {
      const extras = presentArr.filter(n => !expected.includes(n) && !baseline.has(n));
      if (extras.length) {
        DEBUG && console.log('[MindM3rge] waitForUploads: unexpected extra file cards (not failing gate)', extras);
      }
      return true;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  reportBroken('fileInput', {
    context: 'upload gate timeout (expected filenames not all rendered/settled)',
    got: lastPresent, expected, stillUploading: lastBusy,
  });
  return false;
}

async function uploadFilesThenPrompt(files, prompt) {
  if (uploadInFlight) {
    DEBUG && console.log('[MindM3rge] uploadFilesThenPrompt suppressed: already in flight');
    reportBroken('fileInput', { context: 'duplicate uploadFilesThenPrompt call suppressed' });
    return;
  }
  uploadInFlight = true;
  try {
    let fileInput = find('fileInput').el;
    if (!fileInput) {
      const uploadBtn = find('uploadButton').el;
      if (uploadBtn) {
        uploadBtn.click();
        await new Promise(r => setTimeout(r, 500));
        fileInput = find('fileInput').el;
      }
    }
    if (fileInput) {
      // Pre-existing files from a prior turn — excluded from the over-attach guard.
      const baselineNames = getUploadedFileNames();
      if (baselineNames.size > 0) DEBUG && console.log('[MindM3rge] pre-existing file cards:', [...baselineNames]);

      const dt = new DataTransfer();
      for (const f of files) {
        const binary = atob(f.base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: f.mimeType || 'application/octet-stream' });
        const file = new File([blob], f.name, { type: f.mimeType || 'application/octet-stream' });
        dt.items.add(file);
      }
      fileInput.files = dt.files;
      // File inputs canonically fire only 'change'. Dispatching 'input' too made
      // Claude's handler process the files twice (the double-attach bug).
      fileInput.dispatchEvent(new Event('change', { bubbles: true }));

      const clean = await waitForUploads(files.map(f => f.name), 45000, baselineNames);
      DEBUG && console.log('[MindM3rge] Claude upload gate:', clean ? 'clean' : 'FAILED',
        '(expected', files.length, 'file(s):', files.map(f => f.name).join(', ') + ')');
    } else {
      DEBUG && console.log('[MindM3rge] No file input found on Claude');
      reportBroken('fileInput', { context: 'upload attempt' });
    }
    injectPrompt(prompt);
  } finally {
    uploadInFlight = false;
  }
}

function injectPrompt(prompt) {
  const result = find('input');
  const input = result.el;

  if (!input) {
    console.error('[MindM3rge] Could not find Claude input field');
    reportBroken('input', { context: 'inject prompt', method: result.method });
    setTimeout(() => injectPrompt(prompt), 2000);
    return;
  }

  if (result.method === 'discovery') {
    DEBUG && console.log('[MindM3rge] Claude input found via auto-discovery');
  }

  // ProseMirror ignores execCommand from this isolated world — text lands in the
  // DOM but the editor model stays empty, so the send button never renders. The
  // insert + send-click run in the page's MAIN world via the background
  // (chrome.scripting.executeScript, world:'MAIN'). We only verify the composer
  // exists here, then hand off.
  chrome.runtime.sendMessage({ type: 'CLAUDE_MAIN_INSERT', prompt }, (res) => {
    if (chrome.runtime.lastError) {
      reportBroken('input', {
        context: 'CLAUDE_MAIN_INSERT sendMessage failed',
        error: chrome.runtime.lastError.message,
      });
      return;
    }
    DEBUG && console.log('[MindM3rge] Claude main-world insert result:', res);
    if (!res || !res.ok) {
      reportBroken('input', { context: 'main-world insert failed', result: res });
    } else if (res.sent === false) {
      reportBroken('sendButton', {
        context: 'main-world: send button never enabled within 30s, used Enter fallback',
        result: res,
      });
    }
  });

  // Watch from this (isolated) world regardless of main-world send timing.
  isWaitingForResponse = true;
  watchForResponse();
}

// Activity-based waiting: wait INDEFINITELY as long as the model shows any sign
// of life (stop/generating button present OR the response text still changing) —
// no cap at all while it's working. Only after it has gone COMPLETELY silent do
// we start giving up: 3 min of zero movement to confirm it's genuinely idle,
// then 15 more minutes of grace = ~18 min of total silence before we bail.
const IDLE_TIMEOUT_MS = (3 + 15) * 60 * 1000;

function watchForResponse() {
  const responseCountAtStart = findAll('response').length;
  let stableText = '';
  let stableCount = 0;
  let lastActivityTs = Date.now();
  let lastTickText = '';

  const timeoutCapture = (reason) => {
    clearInterval(checkInterval);
    isWaitingForResponse = false;
    const responses = findAll('response');
    if (responses.length > 0) {
      const text = responses[responses.length - 1].innerText || '';
      if (text.length > 10 && text !== lastResponseText) {
        const fullResponse = text + captureArtifacts();
        lastResponseText = text;
        chrome.runtime.sendMessage({ type: 'RESPONSE_CAPTURED', data: { model: 'claude', response: fullResponse } });
        return;
      }
    }
    reportBroken('response', { context: reason });
  };

  const checkInterval = setInterval(() => {
    if (!isWaitingForResponse) { clearInterval(checkInterval); return; }
    const now = Date.now();

    const stopBtn = find('stopButton').el;
    const responses = findAll('response');
    const curText = responses.length ? (responses[responses.length - 1].innerText || responses[responses.length - 1].textContent || '') : '';
    // Sign of life → reset the idle clock (streaming, generating, or thinking).
    if (stopBtn || curText !== lastTickText) lastActivityTs = now;
    lastTickText = curText;

    // Only bites after ~18 min of TOTAL silence; while it's active this never fires.
    if (now - lastActivityTs > IDLE_TIMEOUT_MS) return timeoutCapture('idle: no activity for 18 min');

    if (stopBtn) { stableCount = 0; return; }

    const errorEl = document.querySelector('[class*="error"], [class*="retry"]');
    if (errorEl && errorEl.offsetParent !== null) { stableCount = 0; return; }

    if (responses.length === 0) return;
    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.innerText || lastResponse.textContent;
    const isNew = responses.length > responseCountAtStart;
    const isChanged = text && text !== lastResponseText && text.length > 10;

    if ((isNew || isChanged) && text && text.length > 10) {
      if (text === stableText) stableCount++;
      else { stableText = text; stableCount = 1; }

      if (stableCount >= 5) {
        clearInterval(checkInterval);
        const fullResponse = text + captureArtifacts();
        lastResponseText = text;
        isWaitingForResponse = false;
        chrome.runtime.sendMessage({ type: 'RESPONSE_CAPTURED', data: { model: 'claude', response: fullResponse } });
      }
    }
  }, 1000);

  // Frozen-render recovery: if the streaming indicator is present but the
  // response text length is flat for 30s, the tab's live paint has stalled
  // (hidden-tab rAF/timer throttling) even though the answer completed
  // server-side — OR the Stop button lingered so the normal capture never
  // fired. Hand off to the background for a reload + recapture. Self-clears
  // once the normal capture finishes (isWaitingForResponse=false).
  let _frozenLen = -1, _frozenTs = Date.now(), _frozenFired = false;
  const _frozenIv = setInterval(() => {
    if (_frozenFired || !isWaitingForResponse) { clearInterval(_frozenIv); return; }
    const streaming = !!find('stopButton').el;
    const rs = findAll('response');
    const len = rs.length ? (rs[rs.length - 1].innerText || '').length : 0;
    const now = Date.now();
    if (len !== _frozenLen) { _frozenLen = len; _frozenTs = now; return; }
    if (streaming && len >= 3 && now - _frozenTs > 30000) {
      _frozenFired = true;
      clearInterval(_frozenIv);
      DEBUG && console.log('[MindM3rge] frozen render (claude) — requesting RELOAD_RECAPTURE');
      try { chrome.runtime.sendMessage({ type: 'RELOAD_RECAPTURE', model: 'claude' }, () => void chrome.runtime.lastError); } catch (e) {}
    }
  }, 2000);
}

function captureArtifacts() {
  // Claude creates "artifacts" — downloadable files shown inline in the response.
  // These contain detailed analysis that isn't in the visible response text.
  // Try multiple selectors for artifact content.
  const artifactSelectors = [
    // Artifact preview/content areas
    '[data-testid="artifact-content"]',
    '.artifact-content',
    '.code-block__content',
    'pre code',
    // Artifact containers with titles
    '[class*="artifact"]',
  ];

  let artifactText = '';

  for (const sel of artifactSelectors) {
    const els = document.querySelectorAll(sel);
    if (els.length === 0) continue;

    for (const el of els) {
      const text = el.innerText || el.textContent || '';
      // Only capture substantial content that's not already in the response
      if (text.length > 100) {
        // Try to get the artifact title
        const titleEl = el.closest('[class*="artifact"]')?.querySelector('[class*="title"], [class*="name"], h1, h2, h3');
        const title = titleEl ? titleEl.innerText : 'Generated Document';
        artifactText += `\n\n--- ARTIFACT: ${title} ---\n${text}\n--- END ARTIFACT ---`;
      }
    }
    if (artifactText) break;  // Found artifacts, stop searching
  }

  return artifactText;
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'claude' });
