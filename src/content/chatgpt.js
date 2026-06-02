// Content script for chatgpt.com / chat.openai.com — self-healing with selector engine

const DEBUG = false;
let isWaitingForResponse = false;
let lastResponseText = '';

// v0.5.0 — Copy-response capture path.
//
// Rather than scrape the .markdown DOM and try to filter out file-
// reference buttons / citation pills (which keep changing per model
// version — GPT-5 used unmarked <button> elements that v0.4.x had to
// chase), we let ChatGPT's own "Copy response" button do the work.
//
// The button click invokes ChatGPT's internal renderer that produces
// the canonical text representation of the assistant message —
// markdown formatting, file refs as plain text, citation footnotes.
// Exactly what the user would get by clicking Copy themselves.
//
// We can't read the clipboard from a background-tab content script
// (the tab needs focus for clipboard reads), so instead we monkey-
// patch navigator.clipboard.writeText() and document.execCommand('copy')
// in the page's MAIN world. When ChatGPT's copy code calls writeText,
// we intercept the text. No clipboard read required.
let interceptedCopyText = null;
function injectClipboardInterceptor() {
  if (document.getElementById('mindmerge-clip-interceptor')) return;
  // Build the inline script content. The {{ }} doubles unwind to single
  // braces — this lets us avoid JS template-literal escaping.
  const code = `
    (function () {
      if (window.__mindmergeClipPatched) return;
      window.__mindmergeClipPatched = true;
      const post = (text) => {
        try {
          window.postMessage({ source: 'mindmerge', type: 'COPY_INTERCEPTED', text }, '*');
        } catch (e) {}
      };
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
          navigator.clipboard.writeText = function (text) {
            post(text);
            return orig(text);
          };
        }
      } catch (e) {}
      try {
        const origExec = document.execCommand.bind(document);
        document.execCommand = function (cmd, ...rest) {
          if (cmd === 'copy') {
            const s = window.getSelection && window.getSelection().toString();
            if (s) post(s);
          }
          return origExec(cmd, ...rest);
        };
      } catch (e) {}
    })();
  `;
  const s = document.createElement('script');
  s.id = 'mindmerge-clip-interceptor';
  s.textContent = code;
  (document.head || document.documentElement).appendChild(s);
  s.remove();
}
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const d = event.data;
  if (d && d.source === 'mindmerge' && d.type === 'COPY_INTERCEPTED' &&
      typeof d.text === 'string') {
    interceptedCopyText = d.text;
    DEBUG && console.log('[MindM3rge] intercepted copy text, len=' + d.text.length);
  }
});
injectClipboardInterceptor();

// Locate the message-level "Copy response" button for the LAST
// assistant turn. NOT the per-code-block Copy or per-table Copy.
function findMessageCopyButton(assistantTurn) {
  if (!assistantTurn) return null;
  // Try known selectors in priority order. Action toolbar lives in a
  // sibling of the main message body, not inside .markdown.
  const candidates = [
    'button[data-testid="copy-turn-action-button"]',
    'button[data-testid$="copy-response"]',
    'button[aria-label="Copy"]',
    'button[aria-label="Copy response"]',
  ];
  // Look UP from the turn to the parent message wrapper so we can
  // find the action toolbar that's a sibling of .markdown.
  const wrap = assistantTurn.parentElement || assistantTurn;
  for (const sel of candidates) {
    const els = wrap.querySelectorAll(sel);
    for (const el of els) {
      if (el.closest('pre')) continue;     // code block copy — skip
      // Skip the in-message "Copy table" buttons; those have empty
      // text in their inner <span>. The message-level copy buttons
      // typically also have empty inner text but a clear aria-label.
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      if (aria.includes('table')) continue;
      if (aria.includes('code')) continue;
      return el;
    }
  }
  return null;
}

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

// Strip inline pill/citation/badge elements from a response element and
// return the prose-only innerText. ChatGPT renders web-search citations
// and uploaded-file references as inline <span data-testid="*-pill">
// chips inside .markdown. A response that says
//   "I reviewed [pdf_a] and [pdf_b]. Here is my analysis: ..."
// renders the bracketed parts as pills. When capture fires during
// streaming — before the analysis prose has filled in — the visible
// text is dominated by pill names, and the captured response looks
// like:
//   "I\nfile_a\nfile_b\nfile_a\n..."
//
// This helper produces a cleaned text and a per-pill list so the
// capture logic can both (a) gate on real-prose-length to avoid
// premature capture, and (b) annotate the final captured text with
// the references in a way that doesn't dominate it.
function extractProse(el) {
  if (!el) return { prose: '', pillTexts: [] };
  const clone = el.cloneNode(true);
  const pillTexts = [];

  // GPT-5 renders file references as <button> elements (no
  // data-testid, no aria-label, text-only content = the file name)
  // — NOT as <span data-testid="*-pill"> like older models. Strip
  // BOTH styles.
  const knownPillSelectors = [
    '[data-testid$="-pill"]',
    '[data-testid$="-chip"]',
    '[data-testid*="citation"]',
    '[data-testid*="source"]',
    '[data-testid*="file-attachment"]',
    'a[target="_blank"][rel*="noopener"]',
  ];
  const seen = new Set();
  clone.querySelectorAll(knownPillSelectors.join(',')).forEach((p) => {
    if (seen.has(p)) return;
    seen.add(p);
    const t = (p.innerText || p.textContent || '').trim();
    if (t) pillTexts.push(t);
    p.remove();
  });

  // Also strip <button> elements that look like file-reference chips:
  // - no aria-label (legitimate action buttons like "Copy table" have one)
  // - no data-testid
  // - text content matches a filename-ish pattern OR is short
  // This catches GPT-5's unmarked file-ref buttons without scrubbing
  // legitimate action buttons.
  clone.querySelectorAll('button').forEach((btn) => {
    if (btn.hasAttribute('aria-label')) return;       // action button — keep
    if (btn.dataset && btn.dataset.testid) return;    // marked button — keep
    const t = (btn.innerText || btn.textContent || '').trim();
    if (!t) return;
    // Strip if text content looks like a file name / short identifier
    // (no spaces typical of prose, or contains a recognized extension)
    const isFilenameish =
      /^[A-Za-z0-9_().\-\s]{1,80}\.[A-Za-z]{2,5}$/.test(t) ||      // ends in extension
      /^[A-Za-z0-9_\-]+(\s*\(\d+\))?\s*$/.test(t) ||                // bare ident, maybe (1)
      /^[A-Za-z0-9_]+(?:[ _-][A-Za-z0-9_]+){0,4}\s*\(\d+\)\s*$/.test(t); // ident (1)
    if (isFilenameish) {
      pillTexts.push(t);
      btn.remove();
    }
  });

  const prose = (clone.innerText || clone.textContent || '').trim();
  return { prose, pillTexts };
}

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
    // Async path — try the copy-response button first, fall back to
    // .markdown innerText if the button doesn't exist yet or the
    // intercept fires no data.
    (async () => {
      const responses = findAll('response');
      if (responses.length === 0) {
        sendResponse({ response: null });
        return;
      }
      const last = responses[responses.length - 1];
      const copyBtn = findMessageCopyButton(last);
      if (copyBtn) {
        interceptedCopyText = null;
        try { copyBtn.click(); } catch (e) {}
        await new Promise((r) => setTimeout(r, 250));
        if (interceptedCopyText) {
          lastResponseText = interceptedCopyText;
          isWaitingForResponse = false;
          sendResponse({ response: interceptedCopyText });
          return;
        }
      }
      const text = last.innerText || last.textContent;
      lastResponseText = text;
      isWaitingForResponse = false;
      sendResponse({ response: text });
    })();
    return true; // keep the channel open for async sendResponse
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

  async function tryCapture() {
    if (captured) return;

    const stopBtn = find('stopButton').el;
    if (stopBtn) return; // still generating; next mutation will reschedule

    const responses = findAll('response');
    if (responses.length === 0) return;

    const lastResponse = responses[responses.length - 1];

    // Detection of "response is truly done": the message-level copy
    // button must exist. ChatGPT only renders the action toolbar
    // (copy / regenerate / like / dislike) AFTER the message is
    // fully complete — past every tool call, past every streaming
    // chunk, past every web-search source. This is a far stronger
    // completion signal than "stop button is gone" because the stop
    // button can disappear DURING tool calls.
    const copyBtn = findMessageCopyButton(lastResponse);
    if (!copyBtn) return; // not done yet — wait

    // Trigger ChatGPT's own copy logic. The page main-world monkey
    // patch on navigator.clipboard.writeText fires a window.postMessage
    // we listen for. interceptedCopyText is updated synchronously
    // from the message handler.
    interceptedCopyText = null;
    try { copyBtn.click(); } catch (e) {
      DEBUG && console.warn('[MindM3rge] copy click failed', e);
    }

    // Wait briefly for the intercept event to fire. ChatGPT's copy
    // is synchronous in practice but give it a tick.
    await new Promise((r) => setTimeout(r, 250));

    let capturedText = interceptedCopyText;

    // Fallback 1: maybe the interceptor wasn't injected in time, or
    // ChatGPT used a path we didn't patch. Fall back to .markdown
    // innerText.
    if (!capturedText) {
      const text = lastResponse.innerText || lastResponse.textContent;
      if (!text || text.length <= 10) return;
      // Apply the older v0.4.5 prose-length gate so we don't capture
      // the streaming-intro garbage if we end up here.
      const { prose } = extractProse(lastResponse);
      if (prose.length < 200) return;
      capturedText = text;
    }

    const isNew = responses.length > responseCountAtStart;
    const isChanged = capturedText !== lastResponseText;
    if (!isNew && !isChanged) return;

    captured = true;
    clearInterval(checkInterval);
    clearTimeout(stabilityTimer);
    if (observer) observer.disconnect();
    lastResponseText = capturedText;
    isWaitingForResponse = false;
    chrome.runtime.sendMessage({
      type: 'RESPONSE_CAPTURED',
      data: { model: 'chatgpt', response: capturedText },
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
