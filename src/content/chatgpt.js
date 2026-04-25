// Content script for chatgpt.com / chat.openai.com

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
    '#prompt-textarea',
    'textarea[data-id="root"]',
    'div[contenteditable="true"][id="prompt-textarea"]',
    'div#prompt-textarea',
  ];

  let input = null;
  for (const selector of inputSelectors) {
    input = document.querySelector(selector);
    if (input) break;
  }

  if (!input) {
    console.error('[Tribunal] Could not find ChatGPT input field');
    setTimeout(() => injectPrompt(prompt), 1000);
    return;
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
    const sendButton = document.querySelector('button[data-testid="send-button"]')
      || document.querySelector('button[aria-label="Send prompt"]')
      || document.querySelector('form button[type="submit"]');

    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      isWaitingForResponse = true;
      watchForResponse();
    } else {
      // Try pressing Enter
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      isWaitingForResponse = true;
      watchForResponse();
    }
  }, 500);
}

function watchForResponse() {
  const checkInterval = setInterval(() => {
    // Check if still generating
    const stopButton = document.querySelector('button[aria-label="Stop generating"]')
      || document.querySelector('button[data-testid="stop-button"]');

    if (stopButton) return;

    // Get responses
    let responseElements = document.querySelectorAll('[data-message-author-role="assistant"]');
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('.agent-turn .markdown');
    }
    if (responseElements.length === 0) {
      responseElements = document.querySelectorAll('.message-content');
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
                model: 'chatgpt',
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

chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_READY', model: 'chatgpt' });
