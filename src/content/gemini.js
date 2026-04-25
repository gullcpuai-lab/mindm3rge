// Content script for gemini.google.com

let isWaitingForResponse = false;
let lastResponseText = '';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PROMPT') {
    injectPrompt(message.prompt);
    sendResponse({ ok: true });
  }
  return true;
});

function injectPrompt(prompt) {
  const inputSelectors = [
    'div.ql-editor',
    'rich-textarea div[contenteditable="true"]',
    'div[contenteditable="true"][aria-label*="prompt"]',
    '.input-area div[contenteditable="true"]',
  ];

  let input = null;
  for (const selector of inputSelectors) {
    input = document.querySelector(selector);
    if (input) break;
  }

  if (!input) {
    console.error('[Tribunal] Could not find Gemini input field');
    setTimeout(() => injectPrompt(prompt), 1000);
    return;
  }

  input.focus();
  input.textContent = prompt;
  input.dispatchEvent(new Event('input', { bubbles: true }));

  setTimeout(() => {
    const sendButton = document.querySelector('button[aria-label="Send message"]')
      || document.querySelector('button.send-button')
      || document.querySelector('mat-icon[data-mat-icon-name="send"]')?.closest('button');

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      isWaitingForResponse = true;
      watchForResponse();
    } else {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      isWaitingForResponse = true;
      watchForResponse();
    }
  }, 500);
}

function watchForResponse() {
  const checkInterval = setInterval(() => {
    // Check if still generating
    const stopButton = document.querySelector('button[aria-label="Stop"]')
      || document.querySelector('mat-icon[data-mat-icon-name="stop_circle"]')?.closest('button');

    if (stopButton) return;

    // Get responses
    let responseElements = document.querySelectorAll('model-response .markdown');
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('.response-container .markdown');
    }
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('message-content.model-response-text');
    }

    if (responseElements.length > 0) {
      const lastResponse = responseElements[responseElements.length - 1];
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
              data: {
                model: 'gemini',
                response: finalText,
              },
            });
          }
        }, 2000);
      }
    }
  }, 1000);

  setTimeout(() => {
    if (isWaitingForResponse) {
      clearInterval(checkInterval);
      isWaitingForResponse = false;
    }
  }, 300000);
}

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'gemini' });
