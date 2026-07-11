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

// Attachment-card selectors, most specific first. Use the FIRST selector that
// matches anything — never a union or Math.max across selectors, and never the
// broad [data-testid*="file"] wildcard (it over-counts and caused false 2s).
const FILE_CARD_SELECTORS = [
  '[data-testid="file-upload"]',
  '[data-testid="file-thumbnail"]',
];

function getFileCards() {
  for (const sel of FILE_CARD_SELECTORS) {
    let els = [];
    try { els = Array.from(document.querySelectorAll(sel)); } catch (e) {}
    if (!els.length) continue;
    return els.filter(el => !els.some(other => other !== el && other.contains(el)));
  }
  return [];
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

// Gate: resolves true ONLY when exactly `expected` attachment cards are
// rendered, none busy, and stable for ~1s. A settled over-count (double-attach)
// fails fast; under-count keeps polling until timeout.
async function waitForUploads(expected, fileNames, timeoutMs) {
  timeoutMs = timeoutMs || 45000;
  const POLL_MS = 250;
  const STABLE_POLLS = 4; // ~1s of stability
  const start = Date.now();
  let stable = 0;
  let lastCount = -1;
  let lastBusy = true;

  while (Date.now() - start < timeoutMs) {
    const cards = getFileCards();
    const count = cards.length;
    const busy = cards.some(cardIsBusy);

    if (count >= expected && !busy && count === lastCount) stable++;
    else stable = 0;
    lastCount = count;
    lastBusy = busy;

    if (stable >= STABLE_POLLS) {
      if (count === expected) return true;
      reportBroken('fileInput', {
        context: 'DOUBLE-ATTACH: more file cards than files uploaded',
        got: count, expected, fileNames,
      });
      return false;
    }
    await new Promise(r => setTimeout(r, POLL_MS));
  }

  reportBroken('fileInput', {
    context: 'upload gate timeout (incomplete or unstable attach)',
    got: lastCount, expected, stillUploading: lastBusy, fileNames,
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
      // Stale cards from a previous run count toward the expected total.
      const baseline = getFileCards().length;
      if (baseline > 0) DEBUG && console.log('[MindM3rge] pre-existing file cards:', baseline);

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

      const clean = await waitForUploads(baseline + files.length, files.map(f => f.name));
      DEBUG && console.log('[MindM3rge] Claude upload gate:', clean ? 'clean' : 'FAILED',
        '(expected', files.length, 'file(s), baseline', baseline + ')');
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

function watchForResponse() {
  const responseCountAtStart = findAll('response').length;
  let stableText = '';
  let stableCount = 0;

  const checkInterval = setInterval(() => {
    // Check if still generating
    const stopBtn = find('stopButton').el;
    if (stopBtn) {
      stableCount = 0;
      return;
    }

    // Skip error states — wait for retry
    const errorEl = document.querySelector('[class*="error"], [class*="retry"]');
    if (errorEl && errorEl.offsetParent !== null) {
      stableCount = 0;
      return;
    }

    // Get responses
    const responses = findAll('response');
    if (responses.length === 0) return;

    // Get text from the LAST response element
    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.innerText || lastResponse.textContent;
    const isNew = responses.length > responseCountAtStart;
    const isChanged = text && text !== lastResponseText && text.length > 10;

    if ((isNew || isChanged) && text && text.length > 10) {
      // Check stability — text must stay the same for 3 consecutive checks (3 seconds)
      if (text === stableText) {
        stableCount++;
      } else {
        stableText = text;
        stableCount = 1;
      }

      if (stableCount >= 5) {
        // Response is stable — capture it
        clearInterval(checkInterval);

        // Also capture any artifact content (files Claude generated)
        const fullResponse = text + captureArtifacts();

        lastResponseText = text;
        isWaitingForResponse = false;

        chrome.runtime.sendMessage({
          type: 'RESPONSE_CAPTURED',
          data: { model: 'claude', response: fullResponse },
        });
      }
    }
  }, 1000);

  // Timeout after 5 minutes
  setTimeout(() => {
    if (isWaitingForResponse) {
      clearInterval(checkInterval);
      isWaitingForResponse = false;
      // Try to capture whatever we have
      const responses = findAll('response');
      if (responses.length > 0) {
        const text = responses[responses.length - 1].innerText || '';
        if (text.length > 10 && text !== lastResponseText) {
          const fullResponse = text + captureArtifacts();
          lastResponseText = text;
          chrome.runtime.sendMessage({
            type: 'RESPONSE_CAPTURED',
            data: { model: 'claude', response: fullResponse },
          });
          return;
        }
      }
      reportBroken('response', { context: 'timeout waiting for response after 5 minutes' });
    }
  }, 300000);
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
