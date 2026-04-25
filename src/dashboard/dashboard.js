// Dashboard script — full-page UI for Tribunal

const MODEL_COLORS = { claude: '#f59e0b', chatgpt: '#10b981', gemini: '#3b82f6' };
const MODEL_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

let selectedModel = 'claude';
let selectedPasses = 1;
let uploadedFiles = [];
let tabsVisible = false;
let customDirectives = [];

// Directive descriptions for prompt building
const DIRECTIVE_LABELS = {
  'strengths-weaknesses': 'Identify strengths and weaknesses in the reasoning',
  'factual-accuracy': 'Verify factual accuracy and flag unsupported claims',
  'logical-gaps': 'Identify logical gaps, fallacies, or unsound reasoning',
  'legal-sufficiency': 'Evaluate legal sufficiency, procedural requirements, and statutory compliance',
  'risk-analysis': 'Analyze risks, assumptions, and potential failure points',
  'alternative-approaches': 'Suggest alternative approaches, frameworks, or strategies',
  'evidence-alignment': 'Check if conclusions are supported by the provided evidence',
  'bias-detection': 'Detect cognitive biases, confirmation bias, or one-sided reasoning',
  'completeness': 'Identify missing information, overlooked factors, or incomplete analysis',
  'clarity-readability': 'Evaluate clarity, structure, and readability of the response',
  'counterarguments': 'Present counterarguments and devil\'s advocate perspectives',
  'code-review': 'Review code for bugs, security vulnerabilities, and best practices',
  'security-analysis': 'Analyze security implications, attack vectors, and vulnerabilities',
};

// Model selection
document.querySelectorAll('.model-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.model-chip').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedModel = btn.dataset.model;
  });
});

// Pass selection
document.querySelectorAll('.pass-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pass-chip').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedPasses = parseInt(btn.dataset.passes);
    document.getElementById('custom-passes').value = '';
    document.getElementById('custom-passes').style.borderColor = '#27272a';
  });
});

// Custom pass count
document.getElementById('custom-passes').addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  if (val > 0) {
    document.querySelectorAll('.pass-chip').forEach(b => b.classList.remove('selected'));
    selectedPasses = Math.min(val, 50);
    e.target.style.borderColor = '#7c3aed';
  } else {
    e.target.style.borderColor = '#27272a';
  }
});

// Directive chip selection
document.querySelectorAll('.directive-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('selected');
  });
});

// Custom directives
document.getElementById('add-custom-directive').addEventListener('click', () => {
  const id = 'custom_' + Date.now();
  customDirectives.push({ id, text: '' });
  renderCustomDirectives();
});

function renderCustomDirectives() {
  const container = document.getElementById('custom-directives');
  container.innerHTML = customDirectives.map(d => `
    <div class="custom-directive-row">
      <input type="text" value="${d.text}" placeholder="e.g., Check for HIPAA compliance" data-id="${d.id}"
        oninput="this.closest('.custom-directive-row').querySelector('input').value">
      <button data-remove="${d.id}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Wire up input changes
  container.querySelectorAll('input').forEach(inp => {
    inp.addEventListener('input', (e) => {
      const dir = customDirectives.find(d => d.id === e.target.dataset.id);
      if (dir) dir.text = e.target.value;
    });
  });

  // Wire up remove buttons
  container.querySelectorAll('button[data-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      customDirectives = customDirectives.filter(d => d.id !== btn.dataset.remove);
      renderCustomDirectives();
    });
  });
}

function getSelectedDirectives() {
  const selected = [];
  document.querySelectorAll('.directive-chip.selected').forEach(chip => {
    const key = chip.dataset.directive;
    selected.push(DIRECTIVE_LABELS[key] || key);
  });
  customDirectives.forEach(d => {
    if (d.text.trim()) selected.push(d.text.trim());
  });
  return selected;
}

// File upload — multi-file support (up to 10)
document.getElementById('file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  for (const file of files) {
    if (uploadedFiles.length >= 10) break;
    if (uploadedFiles.some(f => f.name === file.name)) continue; // skip duplicates

    // Read as base64 for native file upload to each LLM
    const base64 = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]); // strip data: prefix
      reader.readAsDataURL(file);
    });

    // Also read as text for fallback context injection
    let textContent = '';
    try {
      textContent = await file.text();
    } catch {
      textContent = `[Binary file: ${file.name}]`;
    }

    uploadedFiles.push({
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      base64,
      content: textContent,
    });
  }

  renderFileList();
  e.target.value = ''; // reset so same file can be re-added if removed
});

function renderFileList() {
  const list = document.getElementById('file-list');
  list.innerHTML = uploadedFiles.map((f, i) => `
    <div class="file-item">
      <span class="name">${f.name}</span>
      <span class="size">${(f.size / 1024).toFixed(1)} KB</span>
      <button class="remove" data-idx="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Remove buttons
  list.querySelectorAll('.remove').forEach(btn => {
    btn.addEventListener('click', () => {
      uploadedFiles.splice(parseInt(btn.dataset.idx), 1);
      renderFileList();
    });
  });

  document.getElementById('file-count').textContent = uploadedFiles.length > 0
    ? `${uploadedFiles.length}/10 documents attached`
    : '';
}

function buildFileContext() {
  if (uploadedFiles.length === 0) return null;
  return uploadedFiles.map((f, i) =>
    `--- DOCUMENT ${i + 1}: ${f.name} ---\n${f.content}\n--- END ${f.name} ---`
  ).join('\n\n');
}

// Toggle LLM tabs visibility
document.getElementById('toggle-tabs-btn').addEventListener('click', async () => {
  tabsVisible = !tabsVisible;
  const btn = document.getElementById('toggle-tabs-btn');
  btn.classList.toggle('active', tabsVisible);
  btn.innerHTML = tabsVisible
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg> Hide LLM Tabs'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg> Show LLM Tabs';

  // Tell background to show/hide tabs
  chrome.runtime.sendMessage({ type: 'TOGGLE_TABS', visible: tabsVisible });
});

// Start session
document.getElementById('start-btn').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) {
    document.getElementById('prompt-input').style.borderColor = '#ef4444';
    return;
  }

  document.getElementById('start-btn').disabled = true;
  document.getElementById('start-btn').textContent = 'Starting...';

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'START_SESSION',
      data: {
        prompt,
        starterModel: selectedModel,
        passes: selectedPasses,
        fileContent: buildFileContext(),
        files: uploadedFiles.map(f => ({ name: f.name, base64: f.base64, mimeType: f.mimeType })),
        directives: getSelectedDirectives(),
        hideTabs: true,
      },
    });

    if (response?.ok) {
      document.getElementById('setup-section').classList.add('hidden');
      document.getElementById('discussion-section').classList.remove('hidden');
      startPolling();
    }
  } catch (err) {
    console.error('Failed to start:', err);
    document.getElementById('start-btn').disabled = false;
    document.getElementById('start-btn').textContent = 'Start Discussion';
  }
});

// New session
document.getElementById('new-btn')?.addEventListener('click', () => {
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  document.getElementById('discussion-feed').innerHTML = '';
  document.getElementById('synthesis-card').classList.add('hidden');
  document.getElementById('action-buttons').style.display = 'none';
  document.getElementById('waiting-indicator').classList.add('hidden');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').textContent = 'Start Discussion';
  document.getElementById('prompt-input').value = '';
  document.getElementById('prompt-input').style.borderColor = '';
  uploadedFiles = [];
  renderFileList();
  stopPolling();
});

// Copy final answer
document.getElementById('copy-btn')?.addEventListener('click', async () => {
  const content = document.getElementById('synthesis-content').textContent;
  if (content) {
    await navigator.clipboard.writeText(content);
    document.getElementById('copy-btn').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('copy-btn').textContent = 'Copy Final Answer'; }, 2000);
  }
});

// Export markdown
document.getElementById('export-btn')?.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!status?.session) return;

  const s = status.session;
  let md = `# Tribunal Discussion\n\n**Prompt:** ${s.originalPrompt || s.prompt}\n\n`;
  md += `**Models:** ${s.modelOrder.map(m => MODEL_NAMES[m]).join(', ')}\n`;
  md += `**Passes:** ${s.passes}\n\n---\n\n`;

  for (const t of s.turns) {
    md += `## ${t.modelName} — ${t.role} (Round ${t.round})\n\n${t.content}\n\n---\n\n`;
  }

  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tribunal-${s.id}.md`;
  a.click();
  URL.revokeObjectURL(url);
});

// Polling
let pollInterval = null;
let lastTurnCount = 0;

function startPolling() {
  pollInterval = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status?.session) updateUI(status.session);
  }, 1500);
}

function stopPolling() {
  if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
}

function updateUI(session) {
  // Progress
  const totalTurns = session.passes * 3; // rough estimate
  const progress = Math.min(100, (session.turns.length / totalTurns) * 100);
  document.getElementById('progress-fill').style.width = progress + '%';
  document.getElementById('pass-current').textContent = session.currentPass;
  document.getElementById('pass-total').textContent = session.passes;
  document.getElementById('turn-count').textContent = session.turns.length;

  // Add new turns
  if (session.turns.length > lastTurnCount) {
    const feed = document.getElementById('discussion-feed');
    for (let i = lastTurnCount; i < session.turns.length; i++) {
      const turn = session.turns[i];
      feed.appendChild(createTurnCard(turn));
    }
    lastTurnCount = session.turns.length;

    // Scroll to bottom
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  }

  // Waiting indicator
  const waiting = document.getElementById('waiting-indicator');
  if (session.status === 'running') {
    waiting.classList.remove('hidden');
    const modelName = MODEL_NAMES[session.currentModel] || session.currentModel;
    document.getElementById('waiting-text').textContent = `Waiting for ${modelName} to respond...`;
  } else {
    waiting.classList.add('hidden');
  }

  // Complete
  if (session.status === 'complete') {
    stopPolling();
    document.getElementById('action-buttons').style.display = 'flex';
    document.getElementById('progress-fill').style.width = '100%';

    // Show synthesis (last turn)
    const lastTurn = session.turns[session.turns.length - 1];
    if (lastTurn?.role === 'synthesis') {
      const card = document.getElementById('synthesis-card');
      card.classList.remove('hidden');
      document.getElementById('synthesis-content').textContent = lastTurn.content;
    }
  }
}

function createTurnCard(turn) {
  const card = document.createElement('div');
  card.className = `turn-card ${turn.model}`;

  const roleLabels = {
    initial: 'Initial Response',
    critique: 'Critique',
    revision: 'Revised Response',
    synthesis: 'Final Synthesis',
  };

  const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  card.innerHTML = `
    <div class="turn-header">
      <span class="dot dot-${turn.model}" style="width:10px;height:10px;border-radius:50%;background:${MODEL_COLORS[turn.model]}"></span>
      <span class="turn-model">${turn.modelName}</span>
      <span class="turn-role">${roleLabels[turn.role] || turn.role}</span>
      <span class="turn-time">Round ${turn.round} · ${time}</span>
    </div>
    <div class="turn-body">${escapeHtml(turn.content)}</div>
  `;

  return card;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Listen for session completion from background
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_COMPLETE') {
    updateUI(message.session);
  }
});

// Check for active session on load
(async () => {
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status?.session && (status.session.status === 'running' || status.session.status === 'complete')) {
      document.getElementById('setup-section').classList.add('hidden');
      document.getElementById('discussion-section').classList.remove('hidden');
      lastTurnCount = 0;
      updateUI(status.session);
      if (status.session.status === 'running') startPolling();
    }
  } catch (e) {}
})();
