// Popup script — handles UI interactions

let selectedModel = 'claude';
let selectedPasses = 1;
let fileContent = null;

// Model selection
document.querySelectorAll('.model-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.model-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedModel = btn.dataset.model;
  });
});

// Pass selection
document.querySelectorAll('.pass-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pass-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    selectedPasses = parseInt(btn.dataset.passes);
  });
});

// File upload
document.getElementById('file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;

  document.getElementById('file-name').textContent = `📄 ${file.name} (${(file.size / 1024).toFixed(1)} KB)`;
  document.getElementById('file-name').classList.remove('hidden');

  // Read file content
  if (file.name.endsWith('.txt') || file.name.endsWith('.md') || file.name.endsWith('.csv')) {
    fileContent = await file.text();
  } else if (file.name.endsWith('.pdf')) {
    fileContent = `[PDF document: ${file.name} — PDF parsing requires server-side processing. Content will be extracted when available.]`;
  } else if (file.name.endsWith('.docx')) {
    fileContent = `[DOCX document: ${file.name} — DOCX parsing requires server-side processing. Content will be extracted when available.]`;
  } else {
    fileContent = await file.text();
  }
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
        fileContent,
      },
    });

    if (response?.ok) {
      showSessionView();
    }
  } catch (err) {
    console.error('Failed to start session:', err);
    document.getElementById('start-btn').disabled = false;
    document.getElementById('start-btn').textContent = 'Start Discussion';
  }
});

// Cancel session
document.getElementById('cancel-btn').addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CANCEL_SESSION' });
  showNewSessionView();
});

// New session
document.getElementById('new-session-btn')?.addEventListener('click', () => {
  showNewSessionView();
});

// Copy final answer
document.getElementById('copy-btn')?.addEventListener('click', async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (status?.session?.turns?.length > 0) {
    const lastTurn = status.session.turns[status.session.turns.length - 1];
    await navigator.clipboard.writeText(lastTurn.content);
    document.getElementById('copy-btn').textContent = 'Copied!';
    setTimeout(() => { document.getElementById('copy-btn').textContent = 'Copy Final Answer'; }, 2000);
  }
});

// Listen for session updates
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SESSION_COMPLETE') {
    updateSessionView(message.session);
  }
});

// Poll for status updates
let pollInterval = null;

function showSessionView() {
  document.getElementById('new-session').classList.add('hidden');
  document.getElementById('session-view').classList.remove('hidden');

  // Start polling
  pollInterval = setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
    if (status?.session) {
      updateSessionView(status.session);
    }
  }, 2000);
}

function showNewSessionView() {
  document.getElementById('new-session').classList.remove('hidden');
  document.getElementById('session-view').classList.add('hidden');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').textContent = 'Start Discussion';
  document.getElementById('prompt-input').value = '';
  document.getElementById('prompt-input').style.borderColor = '';
  fileContent = null;
  document.getElementById('file-name').classList.add('hidden');

  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
}

function updateSessionView(session) {
  const statusEl = document.getElementById('session-status');
  statusEl.textContent = session.status === 'complete' ? 'Complete' : session.status === 'cancelled' ? 'Cancelled' : 'Running...';
  statusEl.className = `status-value ${session.status === 'complete' ? 'complete' : 'running'}`;

  document.getElementById('current-pass').textContent = session.currentPass;
  document.getElementById('total-passes').textContent = session.passes;
  document.getElementById('turn-count').textContent = session.turns.length;

  // Render turns
  const turnsList = document.getElementById('turns-list');
  turnsList.innerHTML = session.turns.map(t => `
    <div class="turn-item ${t.model}">
      <div class="turn-model">${t.modelName}</div>
      <div class="turn-role">Round ${t.round} · ${t.role}</div>
      <div class="turn-preview">${t.content.substring(0, 200)}${t.content.length > 200 ? '...' : ''}</div>
    </div>
  `).join('');

  // Show/hide buttons based on status
  if (session.status === 'complete' || session.status === 'cancelled') {
    document.getElementById('cancel-btn').classList.add('hidden');
    document.getElementById('new-session-btn').classList.remove('hidden');
    document.getElementById('copy-btn').classList.remove('hidden');

    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }
}

// Check if there's an active session on popup open
(async () => {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (status?.session && (status.session.status === 'running' || status.session.status === 'complete')) {
    showSessionView();
    updateSessionView(status.session);
  }
})();
