// Content script for gemini.google.com — self-healing with selector engine

const DEBUG = false;
let isWaitingForResponse = false;
let lastResponseText = '';

const SELECTORS = {
  input: [
    'div.ql-editor', 'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt"]',
  ],
  sendButton: [
    'button[aria-label="Send message"]', 'button.send-button',
  ],
  response: [
    'model-response .markdown', '.response-container .markdown',
    'message-content.model-response-text',
  ],
  stopButton: [
    'button[aria-label="Stop"]',
  ],
  uploadButton: [
    // Gemini renamed this to "Upload & tools" (capital U) — the old
    // [aria-label*="upload"] selector is CASE-SENSITIVE and silently missed it,
    // which is why Gemini uploaded nothing. Use the exact label + a case-
    // insensitive ("i") fallback.
    'button[aria-label="Upload & tools"]', 'button[aria-label*="upload" i]',
    'button[aria-label="Open upload file menu"]',
  ],
  uploadFilesButton: [
    // The "Upload files" entry is a role=menuitem (not a <button>).
    '[role="menuitem"][aria-label*="Upload files" i]',
    '[role="menuitem"][aria-label*="upload files" i]',
    'button[aria-label*="Upload files" i]',
  ],
  fileInput: ['input[type="file"]'],
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
  DEBUG && console.warn(`[MindM3rge] Gemini selector broken: ${elementType}`, details);
  try {
    chrome.runtime.sendMessage({
      type: 'SELECTOR_ERROR',
      model: 'gemini',
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
    if (!result.el && type !== 'stopButton' && type !== 'fileInput' && type !== 'uploadFilesButton') {
      reportBroken(type, { status: 'not found on page load' });
    }
  }
  DEBUG && console.log('[MindM3rge] Gemini health check:', report);
  try {
    chrome.runtime.sendMessage({ type: 'HEALTH_CHECK_REPORT', model: 'gemini', report });
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
    // Gemini redirects to accounts.google.com if not logged in
    const isLoggedIn = !window.location.href.includes('accounts.google.com');
    sendResponse({ loggedIn: isLoggedIn });
  }
  if (message.type === 'FORCE_CAPTURE') {
    const responses = findAll('response');
    if (responses.length > 0) {
      const text = responses[responses.length - 1].innerText || responses[responses.length - 1].textContent;
      lastResponseText = text;
      isWaitingForResponse = false;
      sendResponse({ response: text });
    } else {
      sendResponse({ response: null });
    }
  }
  return true;
});

// Wait until `expected` uploaded-file previews render (or timeout). Counts known
// chip elements AND visible filename occurrences. Returns the highest count seen.
async function waitForUploads(expected, fileNames, chipSelectors, timeoutMs) {
  timeoutMs = timeoutMs || 12000;
  const prefixes = (fileNames || [])
    .map(n => { const b = (n.split('.')[0] || n); return b.length >= 4 ? b.slice(0, 14) : null; })
    .filter(Boolean);
  const start = Date.now();
  let best = 0;
  while (Date.now() - start < timeoutMs) {
    let chips = 0;
    for (const sel of (chipSelectors || [])) {
      try { chips = Math.max(chips, document.querySelectorAll(sel).length); } catch (e) {}
    }
    let names = 0;
    if (prefixes.length) {
      const t = document.body ? (document.body.innerText || '') : '';
      names = prefixes.filter(p => t.includes(p)).length;
    }
    best = Math.max(best, chips, names);
    if (best >= expected) return best;
    await new Promise(r => setTimeout(r, 400));
  }
  return best;
}

function buildDataTransfer(files) {
  const dt = new DataTransfer();
  for (const f of files) {
    const binary = atob(f.base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: f.mimeType || 'application/octet-stream' });
    dt.items.add(new File([blob], f.name, { type: f.mimeType || 'application/octet-stream' }));
  }
  return dt;
}

const GEMINI_CHIP_SELECTORS = [
  'uploader-file-preview', '[data-test-id*="file-preview"]',
  '[data-test-id*="attachment"]', 'xap-uploaded-file', '[file-name]',
];

async function uploadFilesThenPrompt(files, prompt) {
  let fileInput = find('fileInput').el;

  // Step 1: open the "Upload & tools" menu (selector was stale + case-sensitive).
  if (!fileInput) {
    const openMenuBtn = find('uploadButton').el;
    if (openMenuBtn) {
      openMenuBtn.click();
      await new Promise(r => setTimeout(r, 1000));
    } else {
      reportBroken('uploadButton', { context: 'upload - "Upload & tools" menu button not found' });
    }
  }

  // Step 2: click the "Upload files" menuitem to reveal the file input.
  if (!fileInput) {
    const uploadFilesBtn = find('uploadFilesButton').el;
    if (uploadFilesBtn) {
      uploadFilesBtn.click();
      await new Promise(r => setTimeout(r, 1000));
      fileInput = find('fileInput').el;
    } else {
      reportBroken('uploadFilesButton', { context: 'upload - "Upload files" menu item not found' });
    }
  }

  let got = 0;

  // Mechanism A: assign to the input + dispatch change (works on Claude/ChatGPT).
  if (fileInput) {
    fileInput.multiple = true;
    fileInput.files = buildDataTransfer(files).files;
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    got = await waitForUploads(files.length, files.map(f => f.name), GEMINI_CHIP_SELECTORS, 12000);
    DEBUG && console.log('[MindM3rge] Gemini change-upload rendered', got, 'of', files.length);
  }

  // Mechanism B (fallback): Gemini often ignores the synthetic change event, so
  // also try a drag-drop of the same files onto the composer.
  if (got < files.length) {
    const zone = find('input').el || document.querySelector('rich-textarea') || document.body;
    if (zone) {
      const dt = buildDataTransfer(files);
      for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt }));
      }
      got = await waitForUploads(files.length, files.map(f => f.name), GEMINI_CHIP_SELECTORS, 10000);
      DEBUG && console.log('[MindM3rge] Gemini drop-upload rendered', got, 'of', files.length);
    }
  }

  // If Gemini still rejected the files (its uploader requires a trusted native
  // event), tell the model in-prompt which files it is NOT seeing so the run
  // still proceeds with that knowledge rather than silently missing context.
  if (got < files.length) {
    reportBroken('fileInput', { context: 'gemini upload not accepted', got, expected: files.length });
    const fileNames = files.map(f => f.name).join(', ');
    prompt = prompt + `\n\n[Note: ${files.length - got} of ${files.length} file(s) could not be attached to this model: ${fileNames}]`;
  }

  injectPrompt(prompt);
}

function injectPrompt(prompt) {
  const result = find('input');
  const input = result.el;

  if (!input) {
    console.error('[MindM3rge] Could not find Gemini input field');
    reportBroken('input', { context: 'inject prompt', method: result.method });
    setTimeout(() => injectPrompt(prompt), 2000);
    return;
  }

  if (result.method === 'discovery') {
    DEBUG && console.log('[MindM3rge] Gemini input found via auto-discovery');
  }

  input.focus();

  // Clear any existing content first
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  // Gemini uses a Quill editor with Trusted Types — innerHTML is blocked.
  // Insert text line-by-line using execCommand with Shift+Enter for newlines.
  const lines = prompt.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].length > 0) {
      document.execCommand('insertText', false, lines[i]);
    }
    if (i < lines.length - 1) {
      // Simulate Shift+Enter for a newline in Quill
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
      // Also try insertLineBreak as a fallback for Quill
      document.execCommand('insertLineBreak', false, null);
    }
  }
  input.dispatchEvent(new Event('input', { bubbles: true }));

  // Wait for send button to become enabled (file uploads may delay it)
  let sendAttempts = 0;
  const trySend = setInterval(() => {
    sendAttempts++;
    const sendResult = find('sendButton');
    const sendButton = sendResult.el;

    if (sendButton && !sendButton.disabled) {
      clearInterval(trySend);
      sendButton.click();
      isWaitingForResponse = true;
      watchForResponse();
    } else if (sendAttempts >= 30) {
      clearInterval(trySend);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      isWaitingForResponse = true;
      watchForResponse();
      if (!sendButton) reportBroken('sendButton', { context: 'after typing prompt, send button not found after 30s' });
    }
  }, 1000);
}

// Activity-based waiting: wait INDEFINITELY while Gemini shows a sign of life
// (stop button OR changing text) — no cap while it's working. Only after it goes
// COMPLETELY silent do we start giving up: 3 min to confirm idle + 15 min grace
// = ~18 min of total silence before we bail.
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
        lastResponseText = text;
        chrome.runtime.sendMessage({ type: 'RESPONSE_CAPTURED', data: { model: 'gemini', response: text } });
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
    if (stopBtn || curText !== lastTickText) lastActivityTs = now;
    lastTickText = curText;

    // Only bites after ~18 min of TOTAL silence; while it's active this never fires.
    if (now - lastActivityTs > IDLE_TIMEOUT_MS) return timeoutCapture('idle: no activity for 18 min');

    if (stopBtn) { stableCount = 0; return; }
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
        lastResponseText = text;
        isWaitingForResponse = false;
        chrome.runtime.sendMessage({ type: 'RESPONSE_CAPTURED', data: { model: 'gemini', response: text } });
      }
    }
  }, 1000);

  // Frozen-render recovery — two triggers:
  //  (a) flat-length: text length unchanged for 30s (45s at 0 chars) while streaming.
  //  (b) stream-stuck watchdog: streaming indicator continuously present for
  //      >STREAM_STUCK_MS while the main answer set no NEW length max for
  //      GROWTH_STALL_MS. Catches citation-chip trickle (length keeps changing,
  //      so (a) never fires) and is immune to hidden-tab setInterval throttling
  //      (compares wall-clock timestamps, not tick counts).
  const STREAM_STUCK_MS = 150000;
  const GROWTH_STALL_MS = 40000;
  let _frozenLen = -1, _frozenTs = Date.now(), _frozenFired = false;
  let _streamStartTs = null, _maxLen = 0, _lastGrowthTs = Date.now();
  const _fireRecapture = (msg) => {
    _frozenFired = true;
    clearInterval(_frozenIv);
    DEBUG && console.log('[MindM3rge] ' + msg);
    try { chrome.runtime.sendMessage({ type: 'RELOAD_RECAPTURE', model: 'gemini' }, () => void chrome.runtime.lastError); } catch (e) {}
  };
  const _frozenIv = setInterval(() => {
    if (_frozenFired || !isWaitingForResponse) { clearInterval(_frozenIv); return; }
    const streaming = !!find('stopButton').el;
    const rs = findAll('response');
    const len = rs.length ? (rs[rs.length - 1].innerText || '').length : 0;
    const now = Date.now();

    if (!streaming) _streamStartTs = null;
    else if (_streamStartTs === null) _streamStartTs = now;

    if (streaming && _streamStartTs !== null &&
        now - _streamStartTs > STREAM_STUCK_MS &&
        now - _lastGrowthTs > GROWTH_STALL_MS) {
      _fireRecapture('stream stuck >2.5min (gemini) — requesting RELOAD_RECAPTURE');
      return;
    }

    if (len > _maxLen) { _maxLen = len; _lastGrowthTs = now; }

    if (len !== _frozenLen) { _frozenLen = len; _frozenTs = now; return; }
    const _frozenThreshold = len >= 3 ? 30000 : 45000;
    if (streaming && now - _frozenTs > _frozenThreshold) {
      _fireRecapture('frozen render (gemini) — requesting RELOAD_RECAPTURE');
    }
  }, 2000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'gemini' });
