// Content script for chatgpt.com / chat.openai.com — self-healing with selector engine

const DEBUG = true; // v0.5.1 — temporarily on so users can diagnose
                    // capture failures from the chatgpt.com console.
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
//
// Searches DOCUMENT-WIDE and returns the last matching button —
// the toolbar may not be a child of [data-message-author-role=
// "assistant"], so scoping the query to the turn's subtree misses it.
// We then verify the button is positioned BELOW the assistant turn
// (the toolbar always renders below the message body, not inside it).
function findMessageCopyButton(assistantTurn) {
  // v0.5.7 — priority-ordered + scoped lookup. The pre-v0.5.7 version
  // matched every selector equally and returned the LAST hit in
  // document order. That worked for simple responses but failed for
  // responses with inline section / heading / "ChatGPT said" wrapper
  // copy buttons — the section-level button would be last in document
  // order, and clicking it copied only that section, not the whole
  // message. User-reported bug: "it picked up just the first part of
  // the response" because the LAST copy button in DOM order was an
  // inline button for a sub-section, not the message-level toolbar.
  //
  // Fix: prefer message-level `data-testid="copy-turn-action-button"`
  // (and the older `copy-message-action-button`) over generic selectors.
  // Scope the search to the assistant turn container's vicinity so we
  // don't accidentally pull a button from a different message or the
  // composer toolbar.
  const PRIORITY = [
    'button[data-testid="copy-turn-action-button"]',     // ChatGPT current — message-level
    'button[data-testid="copy-message-action-button"]',  // older — message-level
    'button[aria-label="Copy response"]',                // message-level by aria
    'button[aria-label="Copy message"]',                 // message-level by aria
  ];
  const FALLBACK = [
    'button[data-testid$="copy-response"]',
    'button[data-testid="copy-button"]',                 // generic — last resort
    'button[aria-label="Copy"]',                         // generic — last resort
    'button[aria-label*="Copy" i][aria-label*="response" i]',
  ];

  // Try to climb from the .markdown / response element up to the
  // [data-message-author-role="assistant"] wrapper. The toolbar with
  // the Copy response button sits adjacent to (not inside) .markdown,
  // so we widen to the wrapper's parent subtree.
  let container = null;
  try {
    container = assistantTurn && assistantTurn.closest
      ? assistantTurn.closest('[data-message-author-role="assistant"]')
      : null;
  } catch (e) {}
  if (!container) {
    const all = document.querySelectorAll('[data-message-author-role="assistant"]');
    container = all.length > 0 ? all[all.length - 1] : null;
  }
  const scope = (container && container.parentElement) || container || document;

  const collect = (selector, where) => {
    const out = [];
    try {
      for (const el of where.querySelectorAll(selector)) {
        if (el.closest('pre')) continue;                                    // code-block copy
        const aria = (el.getAttribute('aria-label') || '').toLowerCase();
        if (aria.includes('table') || aria.includes('code') || aria.includes('link')) continue;
        out.push(el);
      }
    } catch (e) {}
    return out;
  };

  // 1. Priority selectors, scoped to the assistant turn vicinity.
  for (const sel of PRIORITY) {
    const found = collect(sel, scope);
    if (found.length > 0) return found[found.length - 1];
  }
  // 2. Priority selectors, document-wide (in case scope climb failed).
  for (const sel of PRIORITY) {
    const found = collect(sel, document);
    if (found.length > 0) return found[found.length - 1];
  }
  // 3. Fallback selectors, scoped.
  for (const sel of FALLBACK) {
    const found = collect(sel, scope);
    if (found.length > 0) return found[found.length - 1];
  }
  // 4. Fallback selectors, document-wide.
  for (const sel of FALLBACK) {
    const found = collect(sel, document);
    if (found.length > 0) return found[found.length - 1];
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
    '#composer-plus-btn', 'button[data-testid="composer-plus-btn"]',
    'button[aria-label="Add files and more"]',
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
// Matches ChatGPT file-chip labels: "report.pdf", "canary_val", "data (2)", etc.
const isFilenameish = (t) =>
  /^[A-Za-z0-9_().\-\s]{1,80}\.[A-Za-z]{2,5}$/.test(t) ||
  /^[A-Za-z0-9_\-]+(\s*\(\d+\))?\s*$/.test(t) ||
  /^[A-Za-z0-9_]+(?:[ _-][A-Za-z0-9_]+){0,4}\s*\(\d+\)\s*$/.test(t);

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

  // Strip ChatGPT uploaded-file reference cards: `not-prose` chips whose text is a
  // filename (e.g. <p class="not-prose … truncate">canary_val</p>). ChatGPT also uses
  // `not-prose` for legit wrappers (tables/code/KaTeX), so never touch a node holding
  // <table>/<pre>/<code> or substantial text — only short, filename-ish chip labels.
  clone.querySelectorAll('.not-prose').forEach((node) => {
    if (!clone.contains(node)) return; // already removed with an outer card
    if (node.querySelector('table, pre, code') || ['TABLE', 'PRE', 'CODE'].includes(node.tagName)) return;
    const t = (node.innerText || node.textContent || '').trim();
    if (!t || t.length > 120) return; // substantial prose — keep
    const isChip =
      (node.tagName === 'P' && node.classList.contains('truncate')) ||
      isFilenameish(t);
    if (!isChip) return;
    pillTexts.push(t);
    let parent = node.parentElement;
    node.remove();
    // Peel off the enclosing card wrapper(s) if the chip was their only text content.
    while (parent && parent !== clone && !(parent.textContent || '').trim()) {
      const next = parent.parentElement;
      parent.remove();
      parent = next;
    }
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
    // Strip if text content looks like a file name / short identifier.
    if (isFilenameish(t)) {
      pillTexts.push(t);
      btn.remove();
    }
  });

  const prose = (clone.innerText || clone.textContent || '').trim();
  return { prose, pillTexts };
}

// v0.6.0 — A ChatGPT "thinking" (GPT-5 Thinking) response is ONE assistant turn
// that contains MULTIPLE sibling prose blocks: a short reasoning PREAMBLE
// (e.g. "I'll ground this against the uploaded FAC first..."), then the real
// answer, then sometimes a canvas / writing-block. Confirmed via a live DOM
// dump of a shared thinking response: three `.markdown` siblings of 217 / 8963
// / 2691 chars inside one [data-message-author-role="assistant"] container.
//
// The pre-v0.6.0 capture grabbed responses[responses.length-1] — a SINGLE
// block. During the preamble->think pause (preamble rendered, answer not yet),
// that single block IS the 217-char preamble, so capture locked onto it and
// the real answer below was never sent ("it only grabs the first part").
//
// Fix: capture the WHOLE last assistant turn — concatenate every prose block
// (.markdown answer/preamble + ProseMirror writing-block canvas) inside the
// last assistant container, pill-stripped, in document order.
// v0.7.1 — During the brief pre-answer render, the assistant turn can contain
// ONLY uploaded-file reference chips (a filename repeated per chip) that aren't
// yet the not-prose structure extractProse strips. A part made entirely of
// filename-like lines is that transient state, never a real answer — drop it
// so capture keeps waiting for the real prose to stream in.
function isAllFilenames(text) {
  const lines = (text || '').split('\n').map((l) => l.trim()).filter((l) => l.length);
  if (!lines.length) return false;
  return lines.every((l) => isFilenameish(l));
}

function getLastAssistantTurnText() {
  const turns = document.querySelectorAll('[data-message-author-role="assistant"]');
  if (!turns.length) return '';
  const turn = turns[turns.length - 1];
  let blocks = [...turn.querySelectorAll('.markdown, .ProseMirror, [data-message-content]')];
  // Drop blocks nested inside an earlier-collected block (avoids double-counting
  // a .markdown that also lives inside a .ProseMirror canvas wrapper).
  blocks = blocks.filter((el, i) => !blocks.some((o, j) => j < i && o.contains(el)));
  // Fallback also goes through extractProse so a pre-prose render (file cards only,
  // no content blocks yet) yields '' instead of the filenames.
  if (!blocks.length) {
    const prose = extractProse(turn).prose;
    return isAllFilenames(prose) ? '' : prose;
  }
  const parts = blocks.map((b) => extractProse(b).prose).filter((p) => p && p.length && !isAllFilenames(p));
  return parts.join('\n\n').trim();
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
  if (message.type === 'DO_CAPTURE_WITH_CLIPBOARD') {
    // v0.5.3 — the background just focused our tab. Click the copy
    // button, wait for ChatGPT to populate the clipboard, then read it.
    // This works (whereas reading clipboard from a background tab
    // doesn't) because our tab is now the active foreground tab.
    //
    // v0.5.4 — added staleness defense. The pre-v0.5.4 path silently
    // accepted whatever was on the clipboard if it was > 10 chars long,
    // which meant a SILENT copy-button failure (e.g. ChatGPT's "Failed
    // to copy" toast) left the PREVIOUS turn's response on the
    // clipboard and we captured that as the "new" response. We now
    // (a) snapshot the clipboard BEFORE the click and reject the read
    // if it didn't change, and (b) reject the read if it equals the
    // text we captured for the previous turn.
    (async () => {
      const responses = findAll('response');
      if (responses.length === 0) { sendResponse({ ok: false, error: 'no response' }); return; }
      const last = responses[responses.length - 1];
      const copyBtn = findMessageCopyButton(last);
      if (!copyBtn) { sendResponse({ ok: false, error: 'no copy button' }); return; }

      // v0.5.4 staleness defense step 1: snapshot the clipboard before
      // we click. If the post-click read equals this, the copy did not
      // write anything new.
      let preClipboard = '';
      try {
        preClipboard = await navigator.clipboard.readText();
      } catch (e) {
        DEBUG && console.log('[MindM3rge] pre-click clipboard read failed (ok, continuing):', e.message);
      }

      try {
        copyBtn.click();
      } catch (e) {
        sendResponse({ ok: false, error: 'click failed: ' + e.message }); return;
      }
      // v0.5.4 — bumped from 350ms to 500ms. Recent ChatGPT updates
      // populate the clipboard slightly slower, and a longer wait is
      // far cheaper than a stale capture.
      await new Promise((r) => setTimeout(r, 500));

      let text = '';
      try {
        text = await navigator.clipboard.readText();
      } catch (e) {
        sendResponse({ ok: false, error: 'clipboard.readText failed: ' + e.message });
        return;
      }

      if (!text || text.length <= 10) {
        sendResponse({ ok: false, error: 'clipboard empty or tiny: ' + (text?.length || 0) });
        return;
      }

      // v0.5.4 staleness check 1: pre-click clipboard equals post-click
      // clipboard ⇒ the copy click wrote nothing. Either the button
      // click didn't actually fire on the page's handler, ChatGPT
      // showed a "Failed to copy" toast, or the page's clipboard write
      // errored silently.
      if (text === preClipboard) {
        DEBUG && console.warn('[MindM3rge] STALE: clipboard unchanged by copy click',
                              { len: text.length, preview: text.slice(0, 80) });
        sendResponse({
          ok: false,
          error: 'clipboard unchanged after copy click — stale (ChatGPT did not write new content)',
          preLen: preClipboard.length,
          postLen: text.length,
        });
        return;
      }

      // v0.5.4 staleness check 2: post-click clipboard equals the text
      // we captured for the previous turn ⇒ we'd be re-capturing the
      // prior response as the new one. This catches the case where
      // someone else (or a prior session) left the same response on
      // the clipboard and the copy click failed silently.
      if (lastResponseText && text === lastResponseText) {
        DEBUG && console.warn('[MindM3rge] STALE: clipboard matches previously captured response',
                              { len: text.length, preview: text.slice(0, 80) });
        sendResponse({
          ok: false,
          error: 'clipboard matches previous turn — stale (would have captured prior response)',
          previousResponseLen: lastResponseText.length,
        });
        return;
      }

      // v0.5.6 — removed the DOM content-match check that v0.5.5 added.
      // The DOM was the unreliable source we moved away from in the
      // first place (it returned file-reference pill chips during
      // streaming — "Farley_COA7_8_FINAL_v3 × 6"). Validating against
      // it could over-reject legitimate captures during render races.
      // The two staleness checks above are sufficient: if the clipboard
      // didn't change after the click, the copy failed. Simpler and
      // more robust than chasing the DOM ground truth.

      sendResponse({ ok: true, text });
    })();
    return true; // async sendResponse
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

// Wait until `expected` uploaded-file previews render (or timeout) so we never
// send the prompt mid-upload and drop files. Counts known chip elements AND
// visible filename occurrences. Returns the highest count observed.
async function waitForUploads(expected, fileNames, chipSelectors, timeoutMs) {
  timeoutMs = timeoutMs || 45000;
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
    fileInput.dispatchEvent(new Event('input', { bubbles: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    const got = await waitForUploads(files.length, files.map(f => f.name),
      ['[data-testid="image-thumbnail-static-wrapper"]', '[data-testid*="attachment"]', '[data-testid*="thumbnail"]']);
    DEBUG && console.log('[MindM3rge] ChatGPT uploads rendered', got, 'of', files.length, 'via', fileInput.id || 'input');
    if (got < files.length) {
      reportBroken('fileInput', { context: 'upload incomplete (race)', got, expected: files.length });
    }
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

  // Activity-based waiting: wait INDEFINITELY while ChatGPT shows a sign of life
  // (a mutation fired, or the stop button is present) — no cap while it's working.
  // Only after it goes COMPLETELY silent do we start giving up: 3 min to confirm
  // idle + 15 min grace = ~18 min of total silence before we bail.
  const IDLE_TIMEOUT_MS = (3 + 15) * 60 * 1000;
  let lastActivityTs = Date.now();
  let timeoutChecker = null;

  // v0.6.0 anti-premature-capture state. The preamble->think pause leaves the
  // turn text momentarily STABLE (preamble done, answer not started). To avoid
  // locking onto it, require the captured length to hold steady across
  // consecutive tryCapture ticks before accepting — and longer for short text
  // (a lone ~217-char block is almost certainly a preamble, not the answer).
  let settleLen = -1;
  let settleCount = 0;
  const SHORT_GUARD_CHARS = 250;

  // Post-streaming grace cap: web-search answers keep loading citation source
  // chips for several seconds AFTER generation ends, so the text length never
  // settles and the settle gate would hang forever. Once the Stop button has
  // been gone for this long, capture the current text as-is (citations kept).
  // 8s is plenty for the citation tail to load; raise if chips load slower.
  const POST_STREAM_MAX_MS = 8000;
  let streamEndedTs = null;

  async function tryCapture() {
    if (captured) return;

    const stopBtn = find('stopButton').el;
    if (stopBtn) {
      // still generating (or resumed after a thinking pause) — grace clock off
      streamEndedTs = null;
      DEBUG && console.log('[MindM3rge] still streaming (stop btn present)');
      return;
    }
    if (streamEndedTs === null) streamEndedTs = Date.now();

    const responses = findAll('response');
    if (responses.length === 0) { DEBUG && console.log('[MindM3rge] no .markdown yet'); return; }

    const lastResponse = responses[responses.length - 1];

    // v0.6.0 — CHEAP DOM read first (no tab-focus steal): the WHOLE assistant
    // turn (preamble + answer + canvas), pill-stripped. We settle the capture
    // off this so we don't focus-steal the ChatGPT tab on every tick.
    // v0.7.1 — getLastAssistantTurnText() intentionally returns '' during the
    // early file-chip-only render; the raw innerText fallback must respect the
    // same guard or it re-captures the filenames the guard just dropped.
    let capturedText = getLastAssistantTurnText();
    if (!capturedText) {
      const raw = (lastResponse.innerText || lastResponse.textContent || '').trim();
      capturedText = isAllFilenames(raw) ? '' : raw;
    }
    if (!capturedText || capturedText.length <= 10) return;

    // v0.6.0 anti-premature-capture: the length must hold steady across ticks
    // before we accept (bridges the preamble->think pause, where the turn text
    // is momentarily stable before the answer streams in). Short text must hold
    // longer — a lone ~217-char block is almost certainly a preamble, not the
    // answer. tryCapture is called ~1/s by checkInterval, so each tick ~= 1s.
    const streamDoneGrace = streamEndedTs && (Date.now() - streamEndedTs > POST_STREAM_MAX_MS);

    const curLen = capturedText.length;
    if (!streamDoneGrace) {
      if (curLen !== settleLen) { settleLen = curLen; settleCount = 0; return; }
      settleCount++;
      const neededTicks = curLen < SHORT_GUARD_CHARS ? 4 : 2;
      if (settleCount < neededTicks) {
        DEBUG && console.log('[MindM3rge] settling (' + settleCount + '/' + neededTicks +
                             ' @ len ' + curLen + '), waiting');
        return;
      }
    } else {
      DEBUG && console.log('[MindM3rge] post-stream grace cap — capturing despite unsettled citation tail' +
                           ' (len ' + curLen + ', ' + (Date.now() - streamEndedTs) + 'ms since stream end)');
    }
    // Re-verify streaming is really finished — the Stop button reappears if the
    // model resumed after a thinking pause.
    if (find('stopButton').el) { settleCount = 0; DEBUG && console.log('[MindM3rge] stop btn reappeared — resumed, not done'); return; }

    // Settled + done. NOW (once only) try the canonical Copy-response path for
    // clean markdown (v0.5.3 focus+clipboard). Prefer its text for fidelity,
    // UNLESS the whole-turn DOM text is substantially longer — that means the
    // copy button missed blocks (e.g. the preamble or canvas of a thinking
    // response), so completeness wins.
    let usedPath = 'wholeturn-dom';
    const copyBtn = findMessageCopyButton(lastResponse);
    if (copyBtn) {
      const result = await new Promise((resolve) => {
        try {
          chrome.runtime.sendMessage({ type: 'CAPTURE_VIA_FOCUS' }, (r) => resolve(r));
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
      if (result && result.ok && result.text && result.text.length > 10) {
        if (capturedText.length > result.text.length * 1.3) {
          usedPath = 'wholeturn-dom(copy-missed-blocks)';
        } else {
          capturedText = result.text;
          usedPath = 'copy-button-focus-clipboard';
        }
      } else {
        DEBUG && console.log('[MindM3rge] CAPTURE_VIA_FOCUS failed:', result?.error || 'unknown',
                              '— using whole-turn DOM text');
      }
    }

    DEBUG && console.log('[MindM3rge] capturing via ' + usedPath + ', text_len=' + capturedText.length);

    const isNew = responses.length > responseCountAtStart;
    const isChanged = capturedText !== lastResponseText;
    if (!isNew && !isChanged) return;

    captured = true;
    clearInterval(checkInterval);
    clearTimeout(stabilityTimer);
    if (timeoutChecker) clearInterval(timeoutChecker);
    if (observer) observer.disconnect();
    lastResponseText = capturedText;
    isWaitingForResponse = false;
    chrome.runtime.sendMessage({
      type: 'RESPONSE_CAPTURED',
      data: { model: 'chatgpt', response: capturedText, capturePath: usedPath, sourceUrl: location.href },
    });
  }

  function resetStabilityTimer() {
    if (captured) return;
    lastActivityTs = Date.now();  // a mutation fired → ChatGPT is doing something
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

  // Activity-based timeout: only bites after IDLE_TIMEOUT_MS of no mutations and
  // no stop button, or the hard 15-min ceiling. Streaming/thinking keeps it alive.
  timeoutChecker = setInterval(() => {
    if (!isWaitingForResponse || captured) { clearInterval(timeoutChecker); return; }
    const now = Date.now();
    if (find('stopButton').el) lastActivityTs = now; // still generating
    // Only bites after ~18 min of TOTAL silence; while it's active this never fires.
    if (now - lastActivityTs <= IDLE_TIMEOUT_MS) return;

    clearInterval(checkInterval);
    clearTimeout(stabilityTimer);
    clearInterval(timeoutChecker);
    if (observer) observer.disconnect();
    isWaitingForResponse = false;
    const responses = findAll('response');
    if (responses.length > 0) {
      const text = getLastAssistantTurnText() ||
                   responses[responses.length - 1].innerText || '';
      if (text.length > 10 && text !== lastResponseText) {
        lastResponseText = text;
        chrome.runtime.sendMessage({
          type: 'RESPONSE_CAPTURED',
          data: { model: 'chatgpt', response: text, capturePath: 'timeout-fallback', sourceUrl: location.href },
        });
        return;
      }
    }
    reportBroken('response', { context: 'idle: no activity for 18 min' });
  }, 2000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'chatgpt' });
