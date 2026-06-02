// Content script for chatgpt.com / chat.openai.com — self-healing with selector engine

const DEBUG = false;
let isWaitingForResponse = false;
let lastResponseText = '';

const SELECTORS = {
  input: [
    '#prompt-textarea', 'div[contenteditable="true"][id="prompt-textarea"]',
    'textarea[data-id="root"]',
  ],
  sendButton: [
    'button[data-testid="send-button"]', 'button[aria-label="Send prompt"]',
    'form button[type="submit"]',
  ],
  response: [
    // ChatGPT renders the assistant turn as a container with web-search
    // citation chips, file-reference badges, "thinking" summaries,
    // action buttons, AND the actual prose. Selecting the whole
    // container and calling .innerText concatenates all of those —
    // yielding garbage like "Farley_COA7_8_FINAL_v3 / Justia Law /
    // Supreme Court of California" when the file chips have rendered
    // but .markdown has not yet appeared.
    //
    // NO bare-container fallback here, on purpose. If .markdown does
    // not exist yet, capture should WAIT — not fall back to the
    // surrounding container and capture the loading-state chrome.
    // findAll() returning [] from these selectors makes tryCapture()
    // re-arm the stability timer, exactly the right behavior.
    '[data-message-author-role="assistant"] .markdown',
    '[data-message-author-role="assistant"] [data-message-content]',
    '[data-message-author-role="assistant"] .prose',
    '.agent-turn .markdown',
    '.markdown.prose',
    '.markdown',
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
  ],
  fileInput: [
    '#upload-files', '#upload-photos', 'input[type="file"]',
  ],
  uploadButton: [
    'button[aria-label="Attach files"]', '#composer-actions-button',
  ],
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
  DEBUG && console.warn(`[MindM3rge] ChatGPT selector broken: ${elementType}`, details);
  try {
    chrome.runtime.sendMessage({
      type: 'SELECTOR_ERROR',
      model: 'chatgpt',
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
  DEBUG && console.log('[MindM3rge] ChatGPT health check:', report);
  try {
    chrome.runtime.sendMessage({ type: 'HEALTH_CHECK_REPORT', model: 'chatgpt', report });
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
    const isLoggedIn = !window.location.href.includes('/auth/login');
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

async function uploadFilesThenPrompt(files, prompt) {
  // ChatGPT uses a + button to open an upload menu, then #upload-files for docs
  const plusBtn = find('uploadButton').el;
  if (plusBtn) {
    plusBtn.click();
    await new Promise(r => setTimeout(r, 500));
  }

  // Prefer #upload-files for documents, fall back to #upload-photos or generic file input
  let fileInput = document.getElementById('upload-files')
    || document.getElementById('upload-photos')
    || find('fileInput').el;

  if (!fileInput && !plusBtn) {
    // Try discovery: any file input on the page
    fileInput = document.querySelector('input[type="file"]');
  }

  if (fileInput) {
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
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    DEBUG && console.log('[MindM3rge] Uploaded', files.length, 'files to ChatGPT via', fileInput.id || 'input[type="file"]');
    await new Promise(r => setTimeout(r, 3000));
  } else {
    DEBUG && console.log('[MindM3rge] No file input found on ChatGPT');
    reportBroken('fileInput', { context: 'upload attempt' });
  }

  injectPrompt(prompt);
}

function injectPrompt(prompt) {
  const result = find('input');
  const input = result.el;

  if (!input) {
    console.error('[MindM3rge] Could not find ChatGPT input field');
    reportBroken('input', { context: 'inject prompt', method: result.method });
    setTimeout(() => injectPrompt(prompt), 2000);
    return;
  }

  if (result.method === 'discovery') {
    DEBUG && console.log('[MindM3rge] ChatGPT input found via auto-discovery');
  }

  input.focus();

  // Clear existing content
  document.execCommand('selectAll', false, null);
  document.execCommand('delete', false, null);

  if (input.tagName === 'TEXTAREA') {
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable div — use insertText to trigger React's event system
    const lines = prompt.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].length > 0) {
        document.execCommand('insertText', false, lines[i]);
      }
      if (i < lines.length - 1) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', shiftKey: true, bubbles: true }));
        document.execCommand('insertLineBreak', false, null);
      }
    }
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

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
      // 30 seconds max wait — fallback to Enter key
      clearInterval(trySend);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      isWaitingForResponse = true;
      watchForResponse();
      if (!sendButton) reportBroken('sendButton', { context: 'after typing prompt, send button not found after 30s' });
    }
  }, 1000);
}

function watchForResponse() {
  // Hidden-tab Chrome throttles setInterval/setTimeout aggressively. The
  // earlier MutationObserver fix solved one half of the problem: now we
  // see streaming updates in real time even when the tab is hidden. But
  // there's a second half: AFTER streaming ends, no more mutations fire,
  // so observer-driven stability checks stop arriving. Capture then has
  // to wait for the throttled setInterval to tick, which can be a full
  // minute in heavily throttled tabs.
  //
  // Fix: drive the stability check off a debounced setTimeout instead of
  // polling. Each mutation resets a STABILITY_MS timer. When mutations
  // stop, the timer fires STABILITY_MS later (even in hidden tabs —
  // setTimeout still fires, just possibly delayed by throttling) and
  // captures the current response. No dependence on setInterval cadence.

  const responseCountAtStart = findAll('response').length;
  let captured = false;
  let stabilityTimer = null;

  const STABILITY_MS = 3000;

  function tryCapture() {
    if (captured) return;

    const stopBtn = find('stopButton').el;
    if (stopBtn) return; // still generating; next mutation will reschedule

    const responses = findAll('response');
    if (responses.length === 0) return;

    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.innerText || lastResponse.textContent;
    if (!text || text.length <= 10) return;

    const isNew = responses.length > responseCountAtStart;
    const isChanged = text !== lastResponseText;
    if (!isNew && !isChanged) return;

    captured = true;
    clearInterval(checkInterval);
    clearTimeout(stabilityTimer);
    if (observer) observer.disconnect();
    lastResponseText = text;
    isWaitingForResponse = false;
    chrome.runtime.sendMessage({
      type: 'RESPONSE_CAPTURED',
      data: { model: 'chatgpt', response: text },
    });
  }

  function resetStabilityTimer() {
    if (captured) return;
    if (stabilityTimer) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(tryCapture, STABILITY_MS);
  }

  // Backup poll — fires when mutations don't (e.g., very rare cases where
  // the response area is populated before the observer is even installed).
  const checkInterval = setInterval(tryCapture, 1000);

  // Primary path: MutationObserver runs regardless of tab visibility.
  // Each mutation re-arms the stability timer. When mutations stop for
  // STABILITY_MS, the timer fires and we capture.
  let observer = null;
  try {
    observer = new MutationObserver(resetStabilityTimer);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    // Arm the timer immediately so a fast response that's already finished
    // before the observer fires still gets captured via the first tick.
    resetStabilityTimer();
  } catch (e) {
    DEBUG && console.warn('[MindM3rge] ChatGPT MutationObserver setup failed', e);
  }

  setTimeout(() => {
    if (isWaitingForResponse) {
      clearInterval(checkInterval);
      clearTimeout(stabilityTimer);
      if (observer) observer.disconnect();
      isWaitingForResponse = false;
      const responses = findAll('response');
      if (responses.length > 0) {
        const text = responses[responses.length - 1].innerText || '';
        if (text.length > 10 && text !== lastResponseText) {
          lastResponseText = text;
          chrome.runtime.sendMessage({
            type: 'RESPONSE_CAPTURED',
            data: { model: 'chatgpt', response: text },
          });
          return;
        }
      }
      reportBroken('response', { context: 'timeout waiting for response after 5 minutes' });
    }
  }, 300000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'chatgpt' });
