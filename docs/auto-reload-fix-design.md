Memory-tool permissions weren't granted in this session, so I designed straight from your spec. Here's the complete fix: a frozen-render detector in each content script that hands off to the background, and a background-orchestrated reload → wait → recapture chain that records the completed static response.

## Design in one paragraph

The content script is the only thing that can see the freeze (text length flat while the streaming indicator persists), but it's also running inside the throttled tab — so it does the minimum: detect once, notify the background, and stand down. The background service worker (never throttled) owns the recovery: it validates the request against the current session, reloads the tab with the `onUpdated` listener attached *before* calling reload (so `status: 'complete'` can't be missed), waits for load + a settle delay, then pulls the finished response via `FORCE_CAPTURE` with retries, falling back to a direct DOM scrape via `chrome.scripting.executeScript`. Everything runs in one awaited async chain kicked off by the message — no alarms or long detached timers, and every intermediate sleep is short enough (≤2.5s) that interleaved chrome API calls keep the MV3 service worker alive.

---

## Part 1 — Content script: frozen-render detection

### chatgpt.js — paste this near the top of the file (module scope, next to your other constants)

```js
// ── Frozen-render detection (background-tab rAF/timer throttling) ─────────
// Chrome throttles hidden tabs, so the streaming render can freeze at a few
// chars even though the response completes server-side. If the streaming
// indicator is present but the text length hasn't moved for FROZEN_RENDER_MS,
// we hand off to the background for a reload-and-recapture and stop watching.
const FROZEN_RENDER_MS = 18000;   // text must be flat this long to count as frozen
const FROZEN_MIN_CHARS = 3;      // require some text, so we don't fire pre-first-token
let frozenLastLen = -1;
let frozenLastChangeTs = 0;
let reloadRecaptureFired = false; // once-per-turn guard

// Returns true when the freeze has been reported and this watcher should stop.
function checkFrozenRender(text, isStreaming) {
  if (reloadRecaptureFired) return true; // already handed off; stay stopped

  const len = (text || '').length;
  const now = Date.now();

  if (len !== frozenLastLen) {
    frozenLastLen = len;
    frozenLastChangeTs = now;
    return false;
  }
  if (!isStreaming || len < FROZEN_MIN_CHARS || !frozenLastChangeTs) return false;
  if (now - frozenLastChangeTs < FROZEN_RENDER_MS) return false;

  reloadRecaptureFired = true;
  if (DEBUG) console.log(`[MindM3rge:chatgpt] frozen render detected (len=${len}, flat for ${now - frozenLastChangeTs}ms, streaming indicator present) — requesting RELOAD_RECAPTURE`);
  try {
    chrome.runtime.sendMessage({ type: 'RELOAD_RECAPTURE', model: 'chatgpt' }, () => {
      // swallow "receiving end does not exist" — background will still get it via SW wake
      void chrome.runtime.lastError;
    });
  } catch (e) {
    if (DEBUG) console.log('[MindM3rge:chatgpt] RELOAD_RECAPTURE send failed', e);
  }
  return true;
}
```

### chatgpt.js — inside `watchForResponse()`

**(a)** At the very top of `watchForResponse()`, where the watch for a new turn begins, reset the per-turn state:

```js
  // reset frozen-render tracking for this turn
  frozenLastLen = -1;
  frozenLastChangeTs = 0;
  reloadRecaptureFired = false;
```

**(b)** Inside the ~1/s polling tick, right after you extract the latest assistant text and before/alongside the existing stop-button/idle logic, add:

```js
    // ChatGPT has no Stop button mid-stream in the current UI — the
    // .streaming-animation element is the streaming indicator.
    const isStreaming = !!document.querySelector('.streaming-animation');

    if (checkFrozenRender(responseText, isStreaming)) {
      if (DEBUG) console.log('[MindM3rge:chatgpt] stopping watch — background owns recovery');
      clearInterval(watchInterval); // stop our own watch; do NOT capture the partial
      return;
    }
```

(`responseText` = whatever variable your tick already holds the last-assistant-message text in; `watchInterval` = your existing interval handle. If your loop is a `setTimeout` chain instead, replace `clearInterval(...); return;` with a plain `return` before scheduling the next tick.)

### claude.js — identical, two lines differ

```js
    // Claude: Stop button, or the spinner (which can linger after Stop disappears)
    const isStreaming = !!document.querySelector('button[aria-label="Stop response"]')
                     || !!document.querySelector('svg.animate-spin');
```
…and `model: 'claude'` in the `sendMessage` (and `[MindM3rge:claude]` in the log tags).

### gemini.js — identical, two lines differ

```js
    // Gemini: reuse the existing streaming check verbatim
    const isStreaming = /* <the boolean your existing gemini stop/loading check already computes> */;
```
…and `model: 'gemini'` in the `sendMessage`. Don't invent a new selector here — pass the same boolean your existing capture logic already uses to decide "still streaming".

---

## Part 2 — Background (index.js): reload-and-recapture orchestration

Paste this block anywhere at module scope in index.js:

```js
// ── Reload-and-recapture: recover a response whose render froze in a
//    throttled background tab. The response is complete server-side; a full
//    reload re-fetches it as a static page, then we FORCE_CAPTURE it. ───────
const RELOAD_RECAPTURE_LOAD_TIMEOUT_MS = 25000; // max wait for tab 'complete'
const RELOAD_RECAPTURE_SETTLE_MS = 2500;        // extra delay for static render + content-script inject
const RELOAD_RECAPTURE_MIN_CHARS = 200;         // below this we assume we grabbed junk, not the response
const RELOAD_RECAPTURE_RETRIES = 4;             // FORCE_CAPTURE attempts
const RELOAD_RECAPTURE_RETRY_MS = 1500;         // gap between attempts

// DOM-scrape fallback selectors (last matching element = last assistant turn)
const RELOAD_RECAPTURE_SELECTORS = {
  chatgpt: 'div[data-message-author-role="assistant"]',
  claude:  'div[data-is-streaming="false"], .font-claude-message',
  gemini:  'message-content .markdown, message-content',
};

const reloadRecaptureInFlight = new Set(); // re-entrancy guard, keyed by model

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve true when tabId reaches status 'complete', false on timeout.
// IMPORTANT: call this (attaching the listener) BEFORE chrome.tabs.reload,
// so the 'complete' event cannot fire before we're listening.
function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') finish(true);
    };
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { chrome.tabs.onUpdated.removeListener(listener); } catch (e) { /* ignore */ }
      resolve(ok);
    };
    try {
      chrome.tabs.onUpdated.addListener(listener);
      timer = setTimeout(() => finish(false), timeoutMs);
    } catch (e) {
      finish(false);
    }
  });
}

async function findModelTabForRecapture(model) {
  try {
    const base = MODEL_URLS[model];
    if (!base) return null;
    const pattern = new URL(base).origin + '/*';
    const tabs = await chrome.tabs.query({ url: pattern });
    return (tabs && tabs.length) ? tabs[0] : null;
  } catch (e) {
    if (DEBUG) console.log(`[MindM3rge:bg] findModelTabForRecapture(${model}) failed`, e);
    return null;
  }
}

// Fallback: scrape the last assistant message straight out of the DOM.
async function domScrapeLastResponse(tabId, model) {
  const selector = RELOAD_RECAPTURE_SELECTORS[model];
  if (!selector) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (sel) => {
        const nodes = document.querySelectorAll(sel);
        if (!nodes.length) return null;
        const text = nodes[nodes.length - 1].innerText;
        return text ? text.trim() : null;
      },
      args: [selector],
    });
    return (results && results[0] && results[0].result) || null;
  } catch (e) {
    if (DEBUG) console.log(`[MindM3rge:bg] DOM scrape fallback failed for ${model}`, e);
    return null;
  }
}

async function handleReloadRecapture(model) {
  // ── guards: one recovery per model at a time, and only for the live turn ──
  if (reloadRecaptureInFlight.has(model)) {
    if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}) ignored — already in flight`);
    return;
  }
  const session = getSession();
  if (!session || !session.running || session.currentModel !== model) {
    if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}) ignored — stale (current=${session && session.currentModel}, running=${session && session.running})`);
    return;
  }

  reloadRecaptureInFlight.add(model);
  try {
    const tab = await findModelTabForRecapture(model);
    if (!tab || tab.id == null) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): no tab found`);
      return;
    }
    const tabId = tab.id;
    if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): frozen render reported — reloading tab ${tabId}`);

    // Attach the load listener BEFORE reloading so 'complete' can't be missed.
    const loadPromise = waitForTabComplete(tabId, RELOAD_RECAPTURE_LOAD_TIMEOUT_MS);
    try {
      await chrome.tabs.reload(tabId, { bypassCache: false });
    } catch (e) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): tabs.reload failed`, e);
      return;
    }
    const loaded = await loadPromise;
    if (!loaded && DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): load-complete timeout — proceeding anyway`);
    await sleep(RELOAD_RECAPTURE_SETTLE_MS); // let the static response render + content script inject

    // Session may have moved on (user skipped, watchdog advanced) during the reload.
    const s2 = getSession();
    if (!s2 || !s2.running || s2.currentModel !== model) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): session moved on during reload — aborting`);
      return;
    }

    // ── capture path 1: FORCE_CAPTURE via the (re-injected) content script ──
    let response = null;
    for (let attempt = 1; attempt <= RELOAD_RECAPTURE_RETRIES; attempt++) {
      try {
        const res = await chrome.tabs.sendMessage(tabId, { type: 'FORCE_CAPTURE' });
        if (res && res.response && res.response.length > RELOAD_RECAPTURE_MIN_CHARS) {
          response = res.response;
          break;
        }
        if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): FORCE_CAPTURE attempt ${attempt} returned ${res && res.response ? res.response.length + ' chars' : 'nothing'}`);
      } catch (e) {
        // content script not injected yet — normal right after reload
        if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): FORCE_CAPTURE attempt ${attempt} failed (content script not ready?)`);
      }
      await sleep(RELOAD_RECAPTURE_RETRY_MS);
    }

    // ── capture path 2: direct DOM scrape ──
    if (!response) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): falling back to DOM scrape`);
      const scraped = await domScrapeLastResponse(tabId, model);
      if (scraped && scraped.length > RELOAD_RECAPTURE_MIN_CHARS) response = scraped;
    }

    if (!response) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): FAILED — no substantial response after reload; leaving turn to existing timeout handling`);
      return;
    }

    // Final staleness check: the content script's own watcher may have already
    // captured the static response after reload and advanced the session.
    const s3 = getSession();
    if (!s3 || !s3.running || s3.currentModel !== model) {
      if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): already captured by another path — dropping duplicate`);
      return;
    }

    if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): recovered ${response.length} chars — recording`);
    await handleResponseCaptured({ model, response, capturePath: 'reload-recapture' }, tab);
  } catch (e) {
    if (DEBUG) console.log(`[MindM3rge:bg] RELOAD_RECAPTURE(${model}): unexpected error`, e);
  } finally {
    reloadRecaptureInFlight.delete(model);
  }
}
```

### onMessage registration

Add one case to your existing `chrome.runtime.onMessage.addListener` (alongside `RESPONSE_CAPTURED` etc.):

```js
  if (message.type === 'RELOAD_RECAPTURE') {
    // Fire-and-forget: the whole reload→wait→capture runs as one awaited
    // chain; its chrome API calls keep the MV3 service worker alive.
    handleReloadRecapture(message.model).catch((e) => {
      if (DEBUG) console.log('[MindM3rge:bg] handleReloadRecapture rejected', e);
    });
    sendResponse({ ok: true }); // sync ack so the content script's callback resolves
    return false;
  }
```

---

## Integration notes

- **Manifest**: the DOM fallback needs `"scripting"` in `permissions` and host permissions for the three model origins (you almost certainly have the hosts already for content scripts; `scripting` may be new).
- **Reuse existing helpers**: if index.js already has a find-the-model-tab helper (the one `handleForceCapture` uses), call that instead of `findModelTabForRecapture` — I included mine only so the block is self-contained. Same for `DEBUG`/logging: I used `if (DEBUG) console.log('[MindM3rge:…]')` — swap in your logger if it's named differently.
- **Why the listener-before-reload order matters**: `waitForTabComplete` is created (listener attached) *before* `tabs.reload` is awaited. Reload the other way around and a fast load can emit `complete` before you're listening, and you'd sit out the full 25s timeout every time.
- **Double-capture safety**: after reload the content script re-injects and its fresh `watchForResponse` may legitimately capture the now-static response on its own before the background's FORCE_CAPTURE lands. That's fine — the background re-checks `getSession().currentModel === model` immediately before recording and drops its copy if the session already advanced. Verify `handleResponseCaptured` advances `currentModel` synchronously enough for this check (it does if it's the same function the normal path uses).
- **MV3 lifetime**: no alarms needed. The chain's longest pure wait is the 25s load timeout, and during a page load `tabs.onUpdated` events are firing (which reset the SW idle clock); all other sleeps are 1.5–2.5s bracketed by chrome API calls. If you ever raise `RELOAD_RECAPTURE_LOAD_TIMEOUT_MS` past ~28s, split it into two shorter waits with a `chrome.tabs.get` between them.
- **Tuning**: `FROZEN_RENDER_MS = 18000` at a 1/s poll means ~18 flat ticks — comfortably above any real mid-stream pause at normal token rates, and combined with the "streaming indicator still present" condition it can't fire on a completed response. The Claude `svg.animate-spin` lingering case is harmless: if the spinner lingers *after* completion, text length is flat but the eventual reload-recapture recovers the same full text the idle path would have captured; if that lingering spinner currently blocks your idle-capture path, this fix actually doubles as the recovery for that too.
- **Selector maintenance**: `RELOAD_RECAPTURE_SELECTORS` for claude/gemini are best-effort guesses at current DOM — align them with whatever selectors your claude.js/gemini.js content scripts already use to extract the last assistant message (those are the ground truth you're maintaining anyway).
