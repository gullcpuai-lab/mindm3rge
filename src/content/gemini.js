// Content script for gemini.google.com

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
  // Gemini uses a + button or file upload area
  const attachBtn = document.querySelector('button[aria-label="Upload file"]')
    || document.querySelector('uploader button')
    || document.querySelector('.upload-button');

  let fileInput = document.querySelector('input[type="file"]');
  if (!fileInput && attachBtn) {
    attachBtn.click();
    await new Promise(r => setTimeout(r, 500));
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
    console.log('[Tribunal] Uploaded', files.length, 'files to Gemini');
    await new Promise(r => setTimeout(r, 2000));
  } else {
    console.log('[Tribunal] No file input found on Gemini');
  }

  injectPrompt(prompt);
}

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
