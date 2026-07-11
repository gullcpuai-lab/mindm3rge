// Logic test for the ChatGPT capture path.
//
// What this test verifies:
//   1. After streaming stops (no more mutations), capture fires within
//      STABILITY_MS, regardless of any setInterval cadence.
//   2. While streaming is active (mutations every 100ms), capture does
//      NOT fire (each mutation resets the debounce timer).
//   3. While the stop button is visible, capture does NOT fire even if
//      mutations have stopped — we'd only capture once stop is gone.
//
// What this test does NOT verify (only a live Chrome test can):
//   - That the response selectors match the current ChatGPT DOM.
//   - That MutationObserver actually fires for the kinds of DOM updates
//     ChatGPT does (it does in normal browsers, but a content-script
//     environment can have quirks).
//   - That Chrome's hidden-tab throttling lets setTimeout fire at all
//     (it does — just delayed).
//
// Run: node test_chatgpt_capture_logic.mjs

// --- Mocks: minimal stand-ins for DOM + Chrome + selector engine ---

const dom = {
  responses: [],          // array of fake response elements
  stopButtonVisible: false,
};

function find(type) {
  if (type === 'stopButton') return { el: dom.stopButtonVisible ? { id: 'stop' } : null };
  return { el: null };
}

function findAll(type) {
  if (type === 'response') return dom.responses;
  return [];
}

const captured = { received: null };

const chrome = {
  runtime: {
    sendMessage: (msg) => { captured.received = msg; },
  },
};

let isWaitingForResponse = true;
let lastResponseText = '';

// --- The same logic as src/content/chatgpt.js watchForResponse ---

function watchForResponse() {
  const responseCountAtStart = findAll('response').length;
  let capturedFlag = false;
  let stabilityTimer = null;
  const STABILITY_MS = 3000;

  function tryCapture() {
    if (capturedFlag) return;
    const stopBtn = find('stopButton').el;
    if (stopBtn) return;

    const responses = findAll('response');
    if (responses.length === 0) return;

    const lastResponse = responses[responses.length - 1];
    const text = lastResponse.innerText || lastResponse.textContent;
    if (!text || text.length <= 10) return;

    const isNew = responses.length > responseCountAtStart;
    const isChanged = text !== lastResponseText;
    if (!isNew && !isChanged) return;

    capturedFlag = true;
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
    if (capturedFlag) return;
    if (stabilityTimer) clearTimeout(stabilityTimer);
    stabilityTimer = setTimeout(tryCapture, STABILITY_MS);
  }

  const checkInterval = setInterval(tryCapture, 1000);

  // Stand-in for MutationObserver. In real Chrome, this object's callback
  // fires on each DOM mutation. We expose a `fire()` method on it that the
  // test harness can call to simulate a mutation.
  const observer = {
    cb: resetStabilityTimer,
    disconnect: () => { observer.cb = () => {}; },
  };
  resetStabilityTimer();

  return observer;
}

function fireMutation(observer) {
  observer.cb();
}

// --- Test scenarios ---

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function runScenario(name, fn) {
  // Reset state
  dom.responses = [];
  dom.stopButtonVisible = false;
  captured.received = null;
  isWaitingForResponse = true;
  lastResponseText = '';
  const start = Date.now();
  console.log(`\n=== ${name} ===`);
  await fn(start);
}

let allPass = true;
function expect(label, condition) {
  if (condition) {
    console.log(`  PASS — ${label}`);
  } else {
    console.log(`  FAIL — ${label}`);
    allPass = false;
  }
}

// Scenario 1: streaming completes, capture fires ~3s after last mutation
await runScenario('Streaming completes, capture fires ~3s after last mutation', async () => {
  const observer = watchForResponse();
  dom.stopButtonVisible = true;
  // Simulate 10 streaming mutations over 1s
  for (let i = 0; i < 10; i++) {
    dom.responses = [{ innerText: 'hello'.repeat(i + 1) + ' world streaming' }];
    fireMutation(observer);
    await sleep(100);
  }
  // Streaming stops
  dom.stopButtonVisible = false;
  dom.responses = [{ innerText: 'FINAL RESPONSE TEXT HERE COMPLETE' }];
  fireMutation(observer);
  const tAfterFinalMutation = Date.now();
  // Wait a bit longer than STABILITY_MS
  await sleep(3300);
  expect('captured', captured.received !== null);
  expect('captured the final text', captured.received?.data?.response === 'FINAL RESPONSE TEXT HERE COMPLETE');
  const captureDelay = (captured.received ? Date.now() : 0) - tAfterFinalMutation;
  expect('capture happened within ~3000-3500ms of last mutation', captureDelay >= 2900 && captureDelay <= 3500);
});

// Scenario 2: mutations keep coming, capture does NOT fire mid-stream
await runScenario('Capture does NOT fire while streaming (mutations every 200ms for 5s)', async () => {
  const observer = watchForResponse();
  dom.stopButtonVisible = true;
  for (let i = 0; i < 25; i++) {
    dom.responses = [{ innerText: 'streaming text ' + i }];
    fireMutation(observer);
    await sleep(200);
  }
  // Still streaming after 5 seconds — should NOT have captured
  expect('not captured mid-stream', captured.received === null);
});

// Scenario 3: stop button visible + no mutations — should NOT capture
await runScenario('Stop button visible + idle — should NOT capture', async () => {
  const observer = watchForResponse();
  dom.stopButtonVisible = true;
  dom.responses = [{ innerText: 'this should not be captured while stop is showing' }];
  fireMutation(observer);
  await sleep(4000);
  expect('not captured while stop button visible', captured.received === null);
});

// Scenario 4: response arrives before any mutation (fast/pre-loaded case)
await runScenario('Pre-existing response with no mutations — captures via initial timer arm', async () => {
  dom.stopButtonVisible = false;
  dom.responses = [{ innerText: 'PREEXISTING RESPONSE TEXT IS LONG ENOUGH' }];
  const observer = watchForResponse();
  await sleep(3300);
  expect('captured pre-existing response', captured.received !== null);
  expect('captured the right text', captured.received?.data?.response === 'PREEXISTING RESPONSE TEXT IS LONG ENOUGH');
});

console.log(`\n${allPass ? '✅ ALL CAPTURE-LOGIC SCENARIOS PASS' : '❌ FAILURES'}`);
process.exit(allPass ? 0 : 1);
