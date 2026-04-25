// Content script for chatgpt.com / chat.openai.com — self-healing with selector engine

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
    '[data-message-author-role="assistant"]', '.agent-turn .markdown',
    '.message-content',
  ],
  stopButton: [
    'button[aria-label="Stop generating"]', 'button[data-testid="stop-button"]',
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
  console.warn(`[MindM3rge] ChatGPT selector broken: ${elementType}`, details);
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
  console.log('[MindM3rge] ChatGPT health check:', report);
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
    console.log('[MindM3rge] Uploaded', files.length, 'files to ChatGPT via', fileInput.id || 'input[type="file"]');
    await new Promise(r => setTimeout(r, 3000));
  } else {
    console.log('[MindM3rge] No file input found on ChatGPT');
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
    console.log('[MindM3rge] ChatGPT input found via auto-discovery');
  }

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    input.value = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable div
    input.textContent = prompt;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

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
              data: { model: 'chatgpt', response: finalText },
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

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'chatgpt' });
