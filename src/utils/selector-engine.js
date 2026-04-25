// Self-healing selector engine with auto-discovery and error reporting

const SELECTOR_CONFIGS = {
  claude: {
    input: [
      'div[contenteditable="true"]',
      'div.ProseMirror',
      'fieldset div[contenteditable="true"]',
      '[data-placeholder="Reply..."]',
      '[data-placeholder*="How can"]',
    ],
    sendButton: [
      'button[aria-label="Send Message"]',
      'button[type="submit"]',
      'fieldset button:has(svg)',
      'button[aria-label="Send"]',
    ],
    response: [
      '.font-claude-message',
      '[data-testid="chat-message-content"]',
      '.prose',
      '[class*="response"]',
      '[class*="message-content"]',
    ],
    stopButton: [
      'button[aria-label="Stop Response"]',
      'button:has(svg.animate-spin)',
    ],
    fileInput: [
      'input[type="file"]',
    ],
    uploadButton: [
      'button[aria-label="Add content"]',
      'button[aria-label="Attach files"]',
    ],
  },
  chatgpt: {
    input: [
      '#prompt-textarea',
      'div[contenteditable="true"][id="prompt-textarea"]',
      'textarea[data-id="root"]',
    ],
    sendButton: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'form button[type="submit"]',
    ],
    response: [
      '[data-message-author-role="assistant"]',
      '.agent-turn .markdown',
      '.message-content',
    ],
    stopButton: [
      'button[aria-label="Stop generating"]',
      'button[data-testid="stop-button"]',
    ],
    fileInput: [
      '#upload-files',
      '#upload-photos',
      'input[type="file"]',
    ],
    uploadButton: [
      'button[aria-label="Attach files"]',
      '#composer-actions-button',
    ],
  },
  gemini: {
    input: [
      'div.ql-editor',
      'rich-textarea div[contenteditable="true"]',
      'div[contenteditable="true"][aria-label*="prompt"]',
      '.input-area div[contenteditable="true"]',
    ],
    sendButton: [
      'button[aria-label="Send message"]',
      'button.send-button',
    ],
    response: [
      'model-response .markdown',
      '.response-container .markdown',
      'message-content.model-response-text',
    ],
    stopButton: [
      'button[aria-label="Stop"]',
    ],
    fileInput: [
      'input[type="file"]',
    ],
    uploadButton: [
      'button[aria-label="Open upload file menu"]',
      'button[aria-label*="upload"]',
    ],
    uploadFilesButton: [
      'button[aria-label*="Upload files"]',
    ],
  },
};

// Heuristic patterns for auto-discovery when selectors fail
const DISCOVERY_PATTERNS = {
  input: {
    test: (el) => {
      if (el.getAttribute('contenteditable') === 'true') {
        const rect = el.getBoundingClientRect();
        // Input fields are usually near the bottom of the page
        if (rect.bottom > window.innerHeight * 0.5 && rect.width > 200) return true;
      }
      if (el.tagName === 'TEXTAREA' && el.getBoundingClientRect().width > 200) return true;
      return false;
    },
    search: () => {
      const candidates = [...document.querySelectorAll('[contenteditable="true"], textarea')];
      return candidates.filter(DISCOVERY_PATTERNS.input.test).sort((a, b) => {
        // Prefer the one closest to the bottom
        return b.getBoundingClientRect().bottom - a.getBoundingClientRect().bottom;
      })[0] || null;
    },
  },
  sendButton: {
    test: (el) => {
      if (el.tagName !== 'BUTTON') return false;
      const label = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.textContent || '').toLowerCase();
      if (label.includes('send') || text.includes('send')) return true;
      // Button with SVG near the input area, at the bottom
      if (el.querySelector('svg') && el.getBoundingClientRect().bottom > window.innerHeight * 0.7) return true;
      return false;
    },
    search: () => {
      const buttons = [...document.querySelectorAll('button')];
      return buttons.filter(DISCOVERY_PATTERNS.sendButton.test)[0] || null;
    },
  },
  response: {
    test: (el) => {
      const text = el.innerText || '';
      // Response blocks are large text areas that appeared recently
      if (text.length > 50 && text.length < 50000 && !text.includes('New chat')) return true;
      return false;
    },
    search: () => {
      const divs = [...document.querySelectorAll('div, article, section')];
      const candidates = divs.filter(el => {
        const text = el.innerText || '';
        const rect = el.getBoundingClientRect();
        return text.length > 100 && text.length < 20000 && rect.width > 300 && el.children.length < 50;
      });
      // Return the last (most recent) large text block
      return candidates[candidates.length - 1] || null;
    },
  },
};

/**
 * Try all selectors for a given element type. Returns the first match.
 * If all fail, attempts auto-discovery.
 */
export function findElement(model, elementType) {
  const selectors = SELECTOR_CONFIGS[model]?.[elementType] || [];
  const results = { tried: [], found: null, method: null };

  // Try known selectors
  for (const selector of selectors) {
    results.tried.push(selector);
    const el = document.querySelector(selector);
    if (el) {
      results.found = el;
      results.method = 'selector';
      results.selector = selector;
      return results;
    }
  }

  // All selectors failed — try auto-discovery
  const pattern = DISCOVERY_PATTERNS[elementType];
  if (pattern) {
    const discovered = pattern.search();
    if (discovered) {
      results.found = discovered;
      results.method = 'discovery';
      results.discoveredTag = discovered.tagName;
      results.discoveredClass = discovered.className?.substring(0, 100);
      results.discoveredId = discovered.id;
      return results;
    }
  }

  // Complete failure
  results.method = 'failed';
  return results;
}

/**
 * Find all elements matching selectors (for response lists)
 */
export function findAllElements(model, elementType) {
  const selectors = SELECTOR_CONFIGS[model]?.[elementType] || [];

  for (const selector of selectors) {
    const els = document.querySelectorAll(selector);
    if (els.length > 0) return { found: [...els], selector, method: 'selector' };
  }

  // Auto-discovery for responses
  if (elementType === 'response') {
    const discovered = DISCOVERY_PATTERNS.response.search();
    if (discovered) return { found: [discovered], method: 'discovery' };
  }

  return { found: [], method: 'failed' };
}

/**
 * Run health check on all selectors for a model.
 * Returns a report of what works and what doesn't.
 */
export function healthCheck(model) {
  const config = SELECTOR_CONFIGS[model];
  if (!config) return { model, error: 'Unknown model', status: 'error' };

  const report = { model, timestamp: new Date().toISOString(), elements: {}, status: 'ok' };

  for (const [elementType, selectors] of Object.entries(config)) {
    const result = findElement(model, elementType);
    report.elements[elementType] = {
      status: result.method === 'failed' ? 'broken' : result.method,
      triedSelectors: result.tried,
      foundVia: result.method,
      selector: result.selector || null,
      discovered: result.method === 'discovery' ? {
        tag: result.discoveredTag,
        class: result.discoveredClass,
        id: result.discoveredId,
      } : null,
    };

    if (result.method === 'failed') {
      report.status = 'degraded';
    }
  }

  return report;
}

/**
 * Capture a sanitized DOM snapshot for error reporting.
 * Strips user content, keeps structure + classes.
 */
export function captureDOMSnapshot(rootSelector = 'body') {
  const root = document.querySelector(rootSelector);
  if (!root) return null;

  function sanitizeNode(node, depth = 0) {
    if (depth > 6) return null; // limit depth
    if (node.nodeType !== 1) return null; // elements only

    const tag = node.tagName.toLowerCase();
    const info = {
      tag,
      id: node.id || undefined,
      class: node.className?.substring?.(0, 80) || undefined,
      role: node.getAttribute('role') || undefined,
      ariaLabel: node.getAttribute('aria-label') || undefined,
      contentEditable: node.getAttribute('contenteditable') || undefined,
      type: node.getAttribute('type') || undefined,
      childCount: node.children.length,
    };

    // Only recurse into relevant areas
    if (node.children.length > 0 && node.children.length < 20) {
      info.children = [...node.children]
        .slice(0, 10)
        .map(c => sanitizeNode(c, depth + 1))
        .filter(Boolean);
    }

    return info;
  }

  return sanitizeNode(root);
}

/**
 * Send error report to background for forwarding to Discord
 */
export function reportError(model, elementType, details) {
  const report = {
    type: 'SELECTOR_ERROR',
    model,
    elementType,
    url: window.location.href,
    timestamp: new Date().toISOString(),
    userAgent: navigator.userAgent.substring(0, 100),
    details,
    healthCheck: healthCheck(model),
    domSnapshot: captureDOMSnapshot(),
  };

  try {
    chrome.runtime.sendMessage(report);
  } catch (e) {
    console.error('[Tribunal] Failed to send error report:', e);
  }

  console.warn(`[Tribunal] Selector broken: ${model}.${elementType}`, details);
}
