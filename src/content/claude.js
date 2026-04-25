// Content script for claude.ai — self-healing with selector engine

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
  uploadButton: ['button[aria-label="Add content"]', 'button[aria-label="Attach files"]'],
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
  console.warn(`[MindM3rge] Claude selector broken: ${elementType}`, details);
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
  console.log('[MindM3rge] Claude health check:', report);
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
  return true;
});

async function uploadFilesThenPrompt(files, prompt) {
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
    console.log('[MindM3rge] Uploaded', files.length, 'files to Claude');
    await new Promise(r => setTimeout(r, 2000));
  } else {
    console.log('[MindM3rge] No file input found on Claude');
    reportBroken('fileInput', { context: 'upload attempt' });
  }

  injectPrompt(prompt);
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
    console.log('[MindM3rge] Claude input found via auto-discovery');
  }

  input.focus();
  input.textContent = prompt;
  input.dispatchEvent(new Event('input', { bubbles: true }));

  setTimeout(() => {
    const sendResult = find('sendButton');
    const sendButton = sendResult.el;

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      isWaitingForResponse = true;
      watchForResponse();
    } else {
      // Fallback: try Enter key
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      isWaitingForResponse = true;
      watchForResponse();
      if (!sendButton) reportBroken('sendButton', { context: 'after typing prompt' });
    }
  }, 500);
}

function watchForResponse() {
  const checkInterval = setInterval(() => {
    // Check if still generating
    const stopBtn = find('stopButton').el;
    if (stopBtn) return;

    // Get responses
    const responses = findAll('response');

    if (responses.length > 0) {
      const lastResponse = responses[responses.length - 1];
      const text = lastResponse.innerText || lastResponse.textContent;

      if (text && text !== lastResponseText && text.length > 10) {
        setTimeout(() => {
          const finalText = lastResponse.innerText || lastResponse.textContent;
          if (finalText === text) {
            lastResponseText = finalText;
            isWaitingForResponse = false;
            clearInterval(checkInterval);

            chrome.runtime.sendMessage({
              type: 'RESPONSE_CAPTURED',
              data: { model: 'claude', response: finalText },
            });
          }
        }, 2000);
      }
    }
  }, 1000);

  // Timeout after 5 minutes
  setTimeout(() => {
    if (isWaitingForResponse) {
      clearInterval(checkInterval);
      isWaitingForResponse = false;
      reportBroken('response', { context: 'timeout waiting for response after 5 minutes' });
    }
  }, 300000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'claude' });
