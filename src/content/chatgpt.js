// Content script for chatgpt.com / chat.openai.com

let isWaitingForResponse = false;
let lastResponseText = '';

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'INJECT_PROMPT') {
    if (message.files && message.files.length > 0) {
      uploadFilesThenPrompt(message.files, message.prompt).then(() => sendResponse({ ok: true }));
    } else {
      injectPrompt(message.prompt);
      sendResponse({ ok: true });
    }
  }
  return true;
});

async function uploadFilesThenPrompt(files, prompt) {
  // ChatGPT uses a file input triggered by the + button
  const attachBtn = document.querySelector('button[aria-label="Attach files"]')
    || document.querySelector('button[aria-label="Upload file"]')
    || document.querySelector('#prompt-textarea ~ button');

  let fileInput = document.querySelector('input[type="file"]');
  if (!fileInput && attachBtn) {
    attachBtn.click();
    await new Promise(r => setTimeout(r, 500));
    fileInput = document.querySelector('input[type="file"]');
  }

  // ChatGPT has multiple file inputs: upload-files (docs), upload-photos (images)
  // When logged in, upload-files accepts all types. When not logged in, only images work.
  // Try the + button first to trigger the upload menu
  const plusBtn = document.querySelector('button[aria-label="Attach files"]')
    || document.querySelector('#composer-actions-button');
  if (plusBtn) {
    plusBtn.click();
    await new Promise(r => setTimeout(r, 500));
  }

  // Prefer upload-files for documents
  const docInput = document.getElementById('upload-files');
  const photoInput = document.getElementById('upload-photos');
  const targetInput = docInput || photoInput || fileInput;

  if (targetInput) {
    const dt = new DataTransfer();
    for (const f of files) {
      const binary = atob(f.base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const blob = new Blob([bytes], { type: f.mimeType || 'application/octet-stream' });
      const file = new File([blob], f.name, { type: f.mimeType || 'application/octet-stream' });
      dt.items.add(file);
    }
    targetInput.files = dt.files;
    targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[Tribunal] Uploaded', files.length, 'files to ChatGPT via', targetInput.id);
    await new Promise(r => setTimeout(r, 3000));
  } else {
    console.log('[Tribunal] No file input found on ChatGPT — falling back to text context');
  }

  injectPrompt(prompt);
}

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
