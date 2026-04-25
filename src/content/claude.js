// Content script for claude.ai
// Handles injecting prompts and capturing responses

let isWaitingForResponse = false;
let lastResponseText = '';

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PROMPT') {
    injectPrompt(message.prompt);
    sendResponse({ ok: true });
  }
  return true;
});

function injectPrompt(prompt) {
  // Find the input field on claude.ai
  const inputSelectors = [
    'div[contenteditable="true"]', // Main chat input
    'fieldset div[contenteditable="true"]',
    'div.ProseMirror',
  ];

  let input = null;
  for (const selector of inputSelectors) {
    input = document.querySelector(selector);
    if (input) break;
  }

  if (!input) {
    console.error('[Tribunal] Could not find Claude input field');
    // Retry after a short delay
    setTimeout(() => injectPrompt(prompt), 1000);
    return;
  }

  // Set the text content
  input.focus();
  input.textContent = prompt;

  // Dispatch input event to trigger React state update
  input.dispatchEvent(new Event('input', { bubbles: true }));

  // Small delay then click send
  setTimeout(() => {
    const sendButton = document.querySelector('button[aria-label="Send Message"]')
      || document.querySelector('button[type="submit"]')
      || [...document.querySelectorAll('button')].find(b => b.querySelector('svg') && b.closest('fieldset'));

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      isWaitingForResponse = true;
      watchForResponse();
    } else {
      console.error('[Tribunal] Could not find/click Claude send button');
    }
  }, 500);
}

function watchForResponse() {
  // Poll for the response to finish generating
  const checkInterval = setInterval(() => {
    // Check if Claude is still generating
    const stopButton = document.querySelector('button[aria-label="Stop Response"]')
      || document.querySelector('button:has(svg.animate-spin)');

    if (stopButton) {
      // Still generating — wait
      return;
    }

    // Get the last response
    const responses = document.querySelectorAll('[data-is-streaming]');
    const messageBlocks = document.querySelectorAll('.font-claude-message');

    // Try multiple selectors for Claude's response
    let responseElements = document.querySelectorAll('.font-claude-message');
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('[data-testid="chat-message-content"]');
    }
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('.prose');
    }

    if (responseElements.length > 0) {
      const lastResponse = responseElements[responseElements.length - 1];
      const text = lastResponse.innerText || lastResponse.textContent;

      if (text && text !== lastResponseText && text.length > 10) {
        // Wait a bit more to make sure it's done
        setTimeout(() => {
          const finalText = lastResponse.innerText || lastResponse.textContent;
          if (finalText === text) {
            // Response is complete
            lastResponseText = finalText;
            isWaitingForResponse = false;
            clearInterval(checkInterval);

            // Send to background
            chrome.runtime.sendMessage({
              type: 'RESPONSE_CAPTURED',
              data: {
                model: 'claude',
                response: finalText,
              },
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
      console.error('[Tribunal] Claude response timeout');
    }
  }, 300000);
}

// Notify background that content script is ready
chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'claude' });
