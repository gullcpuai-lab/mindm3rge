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
    'button[aria-label="Open upload file menu"]', 'button[aria-label*="upload"]',
  ],
  uploadFilesButton: [
    'button[aria-label*="Upload files"]',
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
  return true;
});

async function uploadFilesThenPrompt(files, prompt) {
  let uploaded = false;
  let fileInput = find('fileInput').el;

  // Step 1: Click the upload menu button (+ button) to open the upload menu
  if (!fileInput) {
    const openMenuBtn = find('uploadButton').el;
    if (openMenuBtn) {
      openMenuBtn.click();
      await new Promise(r => setTimeout(r, 1000));
    } else {
      reportBroken('uploadButton', { context: 'upload attempt - menu button not found' });
    }
  }

  // Step 2: Click "Upload files" in the menu that appeared
  if (!fileInput) {
    const uploadFilesBtn = find('uploadFilesButton').el;
    if (uploadFilesBtn) {
      uploadFilesBtn.click();
      await new Promise(r => setTimeout(r, 1000));
      fileInput = find('fileInput').el;
    } else {
      reportBroken('uploadFilesButton', { context: 'upload attempt - upload files button not found in menu' });
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
    DEBUG && console.log('[MindM3rge] Uploaded', files.length, 'files to Gemini natively');
    uploaded = true;
    await new Promise(r => setTimeout(r, 2000));
  }

  if (!uploaded) {
    // Native upload failed — notify but don't inject binary content into prompt
    DEBUG && console.log('[MindM3rge] Gemini native upload not available — files skipped');
    reportBroken('fileInput', { context: 'upload attempt - native upload failed' });
    const fileNames = files.map(f => f.name).join(', ');
    prompt = prompt + `\n\n[Note: Files could not be uploaded to this model: ${fileNames}]`;
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
  const responseCountAtStart = findAll('response').length;
  let stableText = '';
  let stableCount = 0;

  const checkInterval = setInterval(() => {
    const stopBtn = find('stopButton').el;
    if (stopBtn) { stableCount = 0; return; }

    const responses = findAll('response');
    if (responses.length === 0) return;

    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.innerText || lastResponse.textContent;
    const isNew = responses.length > responseCountAtStart;
    const isChanged = text && text !== lastResponseText && text.length > 10;

    if ((isNew || isChanged) && text && text.length > 10) {
      if (text === stableText) {
        stableCount++;
      } else {
        stableText = text;
        stableCount = 1;
      }

      if (stableCount >= 3) {
        clearInterval(checkInterval);
        lastResponseText = text;
        isWaitingForResponse = false;
        chrome.runtime.sendMessage({
          type: 'RESPONSE_CAPTURED',
          data: { model: 'gemini', response: text },
        });
      }
    }
  }, 1000);

  setTimeout(() => {
    if (isWaitingForResponse) {
      clearInterval(checkInterval);
      isWaitingForResponse = false;
      const responses = findAll('response');
      if (responses.length > 0) {
        const text = responses[responses.length - 1].innerText || '';
        if (text.length > 10 && text !== lastResponseText) {
          lastResponseText = text;
          chrome.runtime.sendMessage({
            type: 'RESPONSE_CAPTURED',
            data: { model: 'gemini', response: text },
          });
          return;
        }
      }
      reportBroken('response', { context: 'timeout waiting for response after 5 minutes' });
    }
  }, 300000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'gemini' });
