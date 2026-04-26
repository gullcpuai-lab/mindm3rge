// Dashboard script — full-page UI for MindM3rge

const MODEL_COLORS = { claude: '#f59e0b', chatgpt: '#10b981', gemini: '#3b82f6' };
const MODEL_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };

let selectedModel = 'claude';
let selectedPasses = 1;
let participatingModels = new Set(['claude', 'chatgpt', 'gemini']);
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

// Sidebar navigation
document.getElementById('nav-setup')?.addEventListener('click', () => {
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('nav-setup').classList.add('active');
});
document.getElementById('nav-discussion')?.addEventListener('click', () => {
  document.getElementById('setup-section').classList.add('hidden');
  document.getElementById('discussion-section').classList.remove('hidden');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('nav-discussion').classList.add('active');
});

// Model participation toggles
document.querySelectorAll('.model-toggle').forEach(toggle => {
  toggle.addEventListener('change', (e) => {
    const model = e.target.dataset.model;
    const label = e.target.closest('.model-card');
    if (e.target.checked) {
      participatingModels.add(model);
      label.classList.add('on');
    } else {
      // Must have at least 2 models
      if (participatingModels.size <= 2) {
        e.target.checked = true;
        return;
      }
      participatingModels.delete(model);
      label.classList.remove('on');
      // If the removed model was the starter, switch starter
      if (selectedModel === model) {
        const first = [...participatingModels][0];
        selectedModel = first;
        document.querySelectorAll('.starter-chip').forEach(b => {
          b.classList.toggle('on', b.dataset.model === first);
        });
      }
    }
    // Update starter chip visibility
    document.querySelectorAll('.starter-chip').forEach(b => {
      b.style.display = participatingModels.has(b.dataset.model) ? '' : 'none';
    });
  });
});

// Starting model selection
document.querySelectorAll('.starter-chip').forEach(btn => {
  btn.addEventListener('click', () => {
    if (!participatingModels.has(btn.dataset.model)) return;
    document.querySelectorAll('.starter-chip').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    selectedModel = btn.dataset.model;
  });
});

// Pass selection
document.querySelectorAll('.pass-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pass-btn').forEach(b => b.classList.remove('on'));
    btn.classList.add('on');
    selectedPasses = parseInt(btn.dataset.passes);
    document.getElementById('custom-passes').value = '';
    document.getElementById('custom-passes').style.borderColor = '#27272a';
  });
});

// Custom pass count
document.getElementById('custom-passes').addEventListener('input', (e) => {
  const val = parseInt(e.target.value);
  if (val > 0) {
    document.querySelectorAll('.pass-btn').forEach(b => b.classList.remove('on'));
    selectedPasses = val;
    e.target.style.borderColor = '#7c3aed';
  } else {
    e.target.style.borderColor = '#27272a';
  }
});

// Directive chip selection
document.querySelectorAll('.chip').forEach(chip => {
  chip.addEventListener('click', () => {
    chip.classList.toggle('on');
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
    <div class="cd-row">
      <input type="text" value="${d.text}" placeholder="e.g., Check for HIPAA compliance" data-id="${d.id}"
        oninput="this.closest('.cd-row').querySelector('input').value">
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
  document.querySelectorAll('.chip.on').forEach(chip => {
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
    <div class="f-item">
      <span class="nm">${f.name}</span>
      <span class="sz">${(f.size / 1024).toFixed(1)} KB</span>
      <button class="x" data-idx="${i}" title="Remove">&times;</button>
    </div>
  `).join('');

  // Remove buttons
  list.querySelectorAll('.x').forEach(btn => {
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
        models: [...participatingModels],
        modelRoles: getModelRoles(),
        goal: document.getElementById('goal-input')?.value?.trim() || '',
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

// Back to setup (keeps session data for editing)
document.getElementById('back-btn')?.addEventListener('click', () => {
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').textContent = 'Start Discussion';
  stopPolling();
});

// Cancel session
document.getElementById('cancel-btn')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CANCEL_SESSION' });
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').textContent = 'Start Discussion';
  stopPolling();
});

// New session (full reset)
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
  let md = `# MindM3rge Discussion\n\n**Prompt:** ${s.originalPrompt || s.prompt}\n\n`;
  md += `**Models:** ${s.modelOrder.map(m => MODEL_NAMES[m]).join(', ')}\n`;
  md += `**Passes:** ${s.pass-btnes}\n\n---\n\n`;

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

  // Hide skeleton once we have turns
  if (session.turns.length > 0) hideSkeleton();

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

  // Update timeline
  updateTimeline(session);

  // Waiting indicator
  const waiting = document.getElementById('waiting-indicator');
  if (session.status === 'running') {
    waiting.classList.remove('hidden');
    const modelName = MODEL_NAMES[session.currentModel] || session.currentModel;
    document.getElementById('waiting-text').textContent = `Waiting for ${modelName}...`;
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

function updateTimeline(session) {
  const tl = document.getElementById('timeline');
  if (!tl) return;

  const roleLabels = {
    initial: 'Initial Response',
    critique: 'Critique',
    revision: 'Revision',
    synthesis: 'Synthesis',
  };

  // Build expected steps based on session config
  const steps = [];
  const models = session.modelOrder || ['claude', 'chatgpt', 'gemini'];
  const starter = models[0];
  const others = models.slice(1);

  for (let pass = 1; pass <= session.passes; pass++) {
    if (pass === 1) {
      steps.push({ model: starter, role: 'initial', round: 1, label: MODEL_NAMES[starter], sub: 'Initial Response' });
    } else {
      steps.push({ model: starter, role: 'revision', round: pass, label: MODEL_NAMES[starter], sub: `Revision (R${pass})` });
    }
    for (const m of others) {
      steps.push({ model: m, role: 'critique', round: pass, label: MODEL_NAMES[m], sub: `Critique (R${pass})` });
    }
  }
  steps.push({ model: others[0] || starter, role: 'synthesis', round: session.passes, label: 'Synthesis', sub: 'Final Answer' });

  // Determine which steps are done, active, pending
  const doneTurns = session.turns.length;

  tl.innerHTML = '<div class="tl-title">Progress</div>' + steps.map((step, i) => {
    const isDone = i < doneTurns;
    const isActive = i === doneTurns && session.status === 'running';
    const isPending = i > doneTurns;
    const state = isDone ? 'done' : isActive ? 'active' : 'pending';
    const isLast = i === steps.length - 1;

    const actualTurn = session.turns[i];
    const time = actualTurn ? new Date(actualTurn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

    return `
      <div class="tl-item ${state}">
        <div class="tl-track">
          <div class="tl-dot ${step.model} ${state}"></div>
          ${!isLast ? `<div class="tl-line ${isDone ? 'done' : ''}"></div>` : ''}
        </div>
        <div class="tl-content">
          <div class="tl-label">${step.label}</div>
          <div class="tl-sub">${isActive ? 'Thinking...' : isDone ? (time || step.sub) : step.sub}</div>
        </div>
      </div>
    `;
  }).join('');
}

function createTurnCard(turn) {
  const card = document.createElement('div');
  card.className = `turn ${turn.model}`;

  const roleLabels = {
    initial: 'Initial Response',
    critique: 'Critique',
    revision: 'Revised Response',
    synthesis: 'Final Synthesis',
  };

  const time = new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  const turnId = `turn-${Date.now()}-${Math.random().toString(36).slice(2,6)}`;
  card.id = turnId;
  card.dataset.content = turn.content; // for search

  card.innerHTML = `
    <div class="turn-top">
      <span style="width:8px;height:8px;border-radius:50%;background:${MODEL_COLORS[turn.model]}"></span>
      <span class="turn-name">${turn.modelName}</span>
      <span class="turn-badge">${roleLabels[turn.role] || turn.role}</span>
      <span class="turn-meta">R${turn.round} · ${time}</span>
      <div class="turn-actions">
        <button class="turn-act pin-btn" title="Pin" data-turn="${turnId}">&#128204;</button>
        <button class="turn-act ann-btn" title="Annotate" data-turn="${turnId}">&#128221;</button>
        <button class="turn-act retry" title="Retry this turn" data-turn="${turnId}">&#8635;</button>
      </div>
    </div>
    <div class="turn-body">${escapeHtml(turn.content)}</div>
  `;

  // Collapsible (6) — auto-collapse long responses
  const body = card.querySelector('.turn-body');
  if (turn.content.length > 400) {
    body.classList.add('collapsed');
    const toggle = document.createElement('button');
    toggle.className = 'turn-toggle';
    toggle.innerHTML = '&#9660; Show more';
    toggle.addEventListener('click', () => {
      const isCollapsed = body.classList.toggle('collapsed');
      toggle.innerHTML = isCollapsed ? '&#9660; Show more' : '&#9650; Show less';
    });
    card.appendChild(toggle);
  }

  // Pin button
  card.querySelector('.pin-btn').addEventListener('click', (e) => {
    e.target.classList.toggle('pinned');
  });

  // Annotation button
  card.querySelector('.ann-btn').addEventListener('click', (e) => {
    const existing = card.querySelector('.ann-input');
    if (existing) { existing.remove(); return; }
    const input = document.createElement('input');
    input.className = 'ann-input';
    input.placeholder = 'Add a note about this response...';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && input.value.trim()) {
        const ann = document.createElement('div');
        ann.className = 'annotation';
        ann.innerHTML = `<span class="ann-icon">&#128221;</span><span class="ann-text">${escapeHtml(input.value)}</span>`;
        input.replaceWith(ann);
        e.target.classList.add('annotated');
      }
    });
    card.appendChild(input);
    input.focus();
  });

  // Retry button (9)
  card.querySelector('.retry').addEventListener('click', async () => {
    const retryBtn = card.querySelector('.retry');
    retryBtn.classList.add('retrying');
    try {
      await chrome.runtime.sendMessage({ type: 'RETRY_TURN', turnIndex: turn.index });
    } catch {}
    setTimeout(() => retryBtn.classList.remove('retrying'), 3000);
  });

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

  // Connect buttons — open LLM login pages in a new tab
  document.querySelectorAll('.conn-btn[data-connect]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      chrome.tabs.create({ url: btn.dataset.connect });
    });
  });

  // Check connection status for each model
  checkConnections();
  // Load history
  loadHistory();
})();

// ═══ View transitions (8) ═══
function switchView(showId) {
  const views = ['setup-section', 'discussion-section', 'history-section'];
  views.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    if (id === showId) {
      el.classList.remove('hidden');
      el.classList.remove('view-out');
      el.classList.add('view');
    } else {
      el.classList.add('hidden');
    }
  });
  // Update nav
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (showId === 'setup-section') document.getElementById('nav-setup')?.classList.add('active');
  if (showId === 'discussion-section') document.getElementById('nav-discussion')?.classList.add('active');
  if (showId === 'history-section') document.getElementById('nav-history')?.classList.add('active');
}

// Override nav clicks to use transitions
document.getElementById('nav-setup')?.removeEventListener('click', () => {});
document.getElementById('nav-setup')?.addEventListener('click', () => switchView('setup-section'));
document.getElementById('nav-discussion')?.addEventListener('click', () => switchView('discussion-section'));
document.getElementById('nav-history')?.addEventListener('click', () => { switchView('history-section'); loadHistory(); });
document.getElementById('nav-about')?.addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('src/dashboard/about.html') }); });

// ═══ Skeleton loader (9) ═══
function showSkeleton() {
  document.getElementById('skeleton-loader')?.classList.remove('hidden');
}
function hideSkeleton() {
  document.getElementById('skeleton-loader')?.classList.add('hidden');
}

// ═══ Search within discussion (11) ═══
document.getElementById('search-input')?.addEventListener('input', (e) => {
  const query = e.target.value.toLowerCase().trim();
  const turns = document.querySelectorAll('.turn');
  let matchCount = 0;

  turns.forEach(turn => {
    const content = turn.dataset.content || turn.textContent || '';
    const body = turn.querySelector('.turn-body');

    if (!query) {
      turn.classList.remove('search-hidden');
      if (body) body.innerHTML = escapeHtml(content.substring(0, 2000));
      return;
    }

    if (content.toLowerCase().includes(query)) {
      turn.classList.remove('search-hidden');
      matchCount++;
      // Highlight matches in body
      if (body) {
        const text = turn.dataset.content || '';
        const regex = new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
        body.innerHTML = escapeHtml(text).replace(regex, '<span class="search-highlight">$1</span>');
      }
    } else {
      turn.classList.add('search-hidden');
    }
  });

  const countEl = document.getElementById('search-count');
  if (countEl) countEl.textContent = query ? `${matchCount} found` : '';
});

// ═══ Share results (17) ═══
document.getElementById('share-btn')?.addEventListener('click', async () => {
  let summary = '';
  try {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status?.session) {
      const s = status.session;
      summary = `TRIBUNAL DISCUSSION SUMMARY\n\nPrompt: ${s.originalPrompt || s.prompt}\nModels: ${s.modelOrder?.map(m => MODEL_NAMES[m]).join(', ')}\nRounds: ${s.passes}\n\n`;
      s.turns.forEach(t => {
        summary += `--- ${t.modelName} (${t.role}, R${t.round}) ---\n${t.content}\n\n`;
      });
    }
  } catch {
    summary = 'Unable to generate summary — no active session.';
  }

  document.getElementById('share-summary').textContent = summary;
  document.getElementById('share-modal').style.display = 'flex';
});

document.getElementById('share-copy')?.addEventListener('click', () => {
  const text = document.getElementById('share-summary').textContent;
  navigator.clipboard.writeText(text);
  document.getElementById('share-copy').textContent = 'Copied!';
  setTimeout(() => { document.getElementById('share-copy').textContent = 'Copy Summary'; }, 2000);
});

document.getElementById('share-close')?.addEventListener('click', () => {
  document.getElementById('share-modal').style.display = 'none';
});

// ═══ Session history (1) ═══
// ═══ Templates (8) ═══
const TEMPLATES = {
  legal: {
    prompt: 'Paste your legal document, complaint, or filing here.',
    goal: 'Review this document for legal sufficiency. Identify every factual gap, procedural weakness, and vulnerability to demurrer or anti-SLAPP motion. Propose specific language fixes.',
    directives: ['strengths-weaknesses', 'factual-accuracy', 'logical-gaps', 'legal-sufficiency', 'risk-analysis', 'evidence-alignment', 'completeness', 'counterarguments'],
    roles: { claude: 'legal', chatgpt: 'advocate', gemini: 'factcheck' },
    passes: 5,
  },
  code: {
    prompt: 'Paste your code here for review.',
    goal: 'Review this code for bugs, security vulnerabilities, performance issues, and architectural problems. Propose specific fixes for each issue found.',
    directives: ['strengths-weaknesses', 'logical-gaps', 'completeness', 'code-review', 'security-analysis', 'alternative-approaches'],
    roles: { claude: 'technical', chatgpt: 'advocate', gemini: 'factcheck' },
    passes: 3,
  },
  research: {
    prompt: 'Paste your research findings, hypothesis, or analysis here.',
    goal: 'Validate this research. Challenge the methodology, identify confounding variables, check statistical claims, and suggest improvements.',
    directives: ['strengths-weaknesses', 'factual-accuracy', 'logical-gaps', 'bias-detection', 'completeness', 'alternative-approaches', 'counterarguments'],
    roles: { claude: '', chatgpt: 'advocate', gemini: 'factcheck' },
    passes: 3,
  },
  strategy: {
    prompt: 'Describe your business strategy, go-to-market plan, or strategic decision here.',
    goal: 'Stress-test this strategy. Identify blind spots, challenge assumptions, evaluate feasibility, and propose alternatives.',
    directives: ['strengths-weaknesses', 'risk-analysis', 'alternative-approaches', 'completeness', 'counterarguments', 'bias-detection'],
    roles: { claude: '', chatgpt: 'advocate', gemini: '' },
    passes: 3,
  },
  writing: {
    prompt: 'Paste your writing, article, or document here.',
    goal: 'Improve this writing. Evaluate structure, clarity, argument strength, narrative flow, and factual accuracy. Propose specific edits.',
    directives: ['strengths-weaknesses', 'factual-accuracy', 'clarity-readability', 'completeness', 'counterarguments'],
    roles: { claude: 'creative', chatgpt: '', gemini: 'factcheck' },
    passes: 3,
  },
};

document.querySelectorAll('.template-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const t = TEMPLATES[btn.dataset.template];
    if (!t) return;

    // Fill prompt and goal
    document.getElementById('prompt-input').value = t.prompt;
    document.getElementById('goal-input').value = t.goal;

    // Set passes
    document.querySelectorAll('.pass-btn').forEach(b => b.classList.remove('on'));
    const passBtn = document.querySelector(`.pass-btn[data-passes="${t.passes}"]`);
    if (passBtn) passBtn.classList.add('on');
    selectedPasses = t.passes;

    // Set directives
    document.querySelectorAll('.chip').forEach(c => {
      c.classList.toggle('on', t.directives.includes(c.dataset.directive));
    });

    // Set roles
    for (const [model, role] of Object.entries(t.roles)) {
      const sel = document.querySelector(`.role-select[data-model="${model}"]`);
      if (sel) sel.value = role;
    }

    // Update stats
    document.getElementById('stat-rounds').textContent = t.passes;
    document.getElementById('stat-focus').textContent = t.directives.length;

    // Visual feedback
    btn.style.borderColor = 'var(--accent)';
    btn.style.color = 'var(--text)';
    setTimeout(() => { btn.style.borderColor = ''; btn.style.color = ''; }, 1500);
  });
});

// ═══ Save custom template ═══
document.getElementById('save-template-btn')?.addEventListener('click', () => {
  const name = prompt('Template name:');
  if (!name || !name.trim()) return;

  // Capture current state
  const template = {
    name: name.trim(),
    prompt: document.getElementById('prompt-input')?.value || '',
    goal: document.getElementById('goal-input')?.value || '',
    directives: [...document.querySelectorAll('.chip.on')].map(c => c.dataset.directive),
    roles: {},
    passes: selectedPasses,
    customDirectives: customDirectives.map(d => d.text).filter(Boolean),
  };
  document.querySelectorAll('.role-select').forEach(s => {
    if (s.value) template.roles[s.dataset.model] = s.value;
  });

  // Save to storage
  try {
    chrome.storage?.local?.get('customTemplates', (result) => {
      const templates = result?.customTemplates || [];
      templates.push(template);
      chrome.storage.local.set({ customTemplates: templates });
      renderCustomTemplates(templates);
    });
  } catch {
    // Fallback to localStorage
    const templates = JSON.parse(localStorage.getItem('customTemplates') || '[]');
    templates.push(template);
    localStorage.setItem('customTemplates', JSON.stringify(templates));
    renderCustomTemplates(templates);
  }
});

function renderCustomTemplates(templates) {
  const container = document.getElementById('custom-templates');
  if (!container) return;
  container.innerHTML = templates.map((t, i) => `
    <div style="display:flex;gap:4px;align-items:center;">
      <button class="template-btn custom-tpl" data-idx="${i}">&#11088; ${t.name}</button>
      <button class="turn-act" data-del-tpl="${i}" title="Delete" style="font-size:12px;color:var(--text3);">&times;</button>
    </div>
  `).join('');

  // Load handlers
  container.querySelectorAll('.custom-tpl').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = templates[parseInt(btn.dataset.idx)];
      if (!t) return;
      if (t.prompt) document.getElementById('prompt-input').value = t.prompt;
      if (t.goal) document.getElementById('goal-input').value = t.goal;
      if (t.directives) {
        document.querySelectorAll('.chip').forEach(c => c.classList.toggle('on', t.directives.includes(c.dataset.directive)));
      }
      if (t.roles) {
        for (const [model, role] of Object.entries(t.roles)) {
          const sel = document.querySelector(`.role-select[data-model="${model}"]`);
          if (sel) sel.value = role;
        }
      }
      if (t.passes) {
        document.querySelectorAll('.pass-btn').forEach(b => b.classList.remove('on'));
        const pb = document.querySelector(`.pass-btn[data-passes="${t.passes}"]`);
        if (pb) pb.classList.add('on');
        selectedPasses = t.passes;
      }
      if (t.customDirectives?.length) {
        customDirectives = t.customDirectives.map((text, i) => ({ id: 'ct_' + i, text }));
        renderCustomDirectives();
      }
    });
  });

  // Delete handlers
  container.querySelectorAll('[data-del-tpl]').forEach(btn => {
    btn.addEventListener('click', () => {
      templates.splice(parseInt(btn.dataset.delTpl), 1);
      try { chrome.storage?.local?.set({ customTemplates: templates }); } catch { localStorage.setItem('customTemplates', JSON.stringify(templates)); }
      renderCustomTemplates(templates);
    });
  });
}

// Load custom templates on startup
try {
  chrome.storage?.local?.get('customTemplates', (result) => {
    if (result?.customTemplates?.length) renderCustomTemplates(result.customTemplates);
  });
} catch {
  const saved = JSON.parse(localStorage.getItem('customTemplates') || '[]');
  if (saved.length) renderCustomTemplates(saved);
}

// ═══ Custom role input ═══
document.querySelectorAll('.role-select').forEach(sel => {
  sel.addEventListener('change', (e) => {
    if (e.target.value === 'custom') {
      const custom = prompt('Enter custom role instruction:');
      if (custom && custom.trim()) {
        // Add as a new option
        const opt = document.createElement('option');
        opt.value = 'custom_' + Date.now();
        opt.textContent = custom.trim().substring(0, 30);
        opt.dataset.instruction = custom.trim();
        e.target.insertBefore(opt, e.target.querySelector('[value="custom"]'));
        e.target.value = opt.value;

        // Store the instruction
        ROLE_INSTRUCTIONS[opt.value] = custom.trim();
      } else {
        e.target.value = '';
      }
    }
  });
});

// ═══ Model roles (7) ═══
function getModelRoles() {
  const roles = {};
  document.querySelectorAll('.role-select').forEach(sel => {
    if (sel.value) roles[sel.dataset.model] = sel.value;
  });
  return roles;
}

const ROLE_INSTRUCTIONS = {
  advocate: 'You are playing Devil\'s Advocate. Challenge every assumption, argue the opposing side, and identify every possible weakness.',
  factcheck: 'You are a Fact Checker. Focus exclusively on verifying factual claims, identifying unsourced assertions, and checking logical consistency.',
  legal: 'You are a Legal Expert. Analyze from a legal perspective — statutory requirements, case law, procedural compliance, and litigation risk.',
  technical: 'You are a Technical Reviewer. Focus on implementation details, feasibility, scalability, edge cases, and technical accuracy.',
  creative: 'You are a Creative Thinker. Propose unconventional approaches, reframe the problem, and suggest ideas others might overlook.',
};

// ═══ Feedback widget (17) ═══
document.getElementById('feedback-fab')?.addEventListener('click', () => {
  document.getElementById('feedback-panel').classList.toggle('hidden');
});
document.getElementById('feedback-close')?.addEventListener('click', () => {
  document.getElementById('feedback-panel').classList.add('hidden');
});
document.getElementById('feedback-send')?.addEventListener('click', () => {
  const text = document.getElementById('feedback-text').value.trim();
  if (!text) return;
  // Store feedback locally (could be sent to a server later)
  try {
    chrome.storage?.local?.get('feedback', (result) => {
      const feedbacks = result?.feedback || [];
      feedbacks.push({ text, timestamp: new Date().toISOString() });
      chrome.storage.local.set({ feedback: feedbacks });
    });
  } catch {}
  document.getElementById('feedback-text').value = '';
  document.getElementById('feedback-panel').classList.add('hidden');
  // Show confirmation
  const fab = document.getElementById('feedback-fab');
  fab.textContent = '✓';
  setTimeout(() => { fab.textContent = '💬'; }, 2000);
});

// ═══ Referral (18) ═══
document.getElementById('referral-copy')?.addEventListener('click', () => {
  const input = document.getElementById('referral-url');
  navigator.clipboard.writeText(input.value);
  document.getElementById('referral-copy').textContent = 'Copied!';
  setTimeout(() => { document.getElementById('referral-copy').textContent = 'Copy'; }, 2000);
});

// ═══ Session history (1) ═══
async function loadHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;

  try {
    const result = await chrome.storage?.local?.get('sessionHistory');
    const history = result?.sessionHistory || [];

    if (history.length === 0) {
      list.innerHTML = '<div class="history-empty">No sessions yet. Start a discussion to see it here.</div>';
      return;
    }

    list.innerHTML = history.map(s => `
      <div class="history-item" data-id="${s.id}">
        <div class="hi-prompt">${escapeHtml((s.originalPrompt || s.prompt || '').substring(0, 200))}</div>
        <div class="hi-meta">
          <span>${s.modelOrder?.map(m => MODEL_NAMES[m] || m).join(', ') || 'Unknown'}</span>
          <span>${s.turns?.length || 0} turns</span>
          <span>${s.passes || 1} rounds</span>
          <span>${new Date(s.savedAt || s.createdAt).toLocaleDateString()}</span>
        </div>
      </div>
    `).join('');
  } catch {
    list.innerHTML = '<div class="history-empty">Session history available when running as extension.</div>';
  }
}

async function checkConnections() {
  const models = [
    { id: 'claude', url: 'https://claude.ai', loginIndicator: '/login' },
    { id: 'chatgpt', url: 'https://chatgpt.com', loginIndicator: 'Log in' },
    { id: 'gemini', url: 'https://gemini.google.com/app', loginIndicator: 'Sign in' },
  ];

  for (const m of models) {
    const connEl = document.getElementById(`conn-${m.id}`);
    if (!connEl) continue;
    const dot = connEl.querySelector('.conn-dot');
    const status = connEl.querySelector('.conn-status');
    const btn = connEl.closest('.model-card')?.querySelector('.conn-btn');

    try {
      // Ask background to check if this model's tab exists and is logged in
      const result = await chrome.runtime.sendMessage({ type: 'CHECK_CONNECTION', model: m.id });

      if (result?.connected) {
        dot.style.background = '#00d4aa';
        status.textContent = 'Connected';
        status.style.color = '#00d4aa';
        btn.classList.add('hidden');
      } else {
        dot.style.background = '#ff5858';
        status.textContent = 'Not logged in';
        status.style.color = '#ff5858';
        btn.classList.remove('hidden');
      }
    } catch {
      // Extension APIs not available (testing outside extension)
      dot.style.background = 'var(--text3)';
      status.textContent = 'Unknown';
      status.style.color = 'var(--text3)';
      btn.classList.remove('hidden');
    }
  }
}
