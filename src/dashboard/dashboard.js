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

    // All files are uploaded natively to each LLM via their file input
    // No text extraction needed — the LLMs handle it themselves

    uploadedFiles.push({
      name: file.name,
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      base64,
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
  // All files are uploaded natively to LLMs — no text injection into prompts
  return null;
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
// Clear the rendered discussion UI back to an empty state. Called at the
// start of every new session (and by the New Session button) so the prior
// session's turn cards, synthesis, and progress don't bleed into a fresh
// run. Without this, lastTurnCount keeps the prior session's count and
// updateUI's "if (session.turns.length > lastTurnCount)" guard silently
// skips rendering the early turns of the new session.
function resetDiscussionUI() {
  document.getElementById('discussion-feed').innerHTML = '';
  document.getElementById('synthesis-card').classList.add('hidden');
  document.getElementById('action-buttons').style.display = 'none';
  document.getElementById('waiting-indicator').classList.add('hidden');
  const pf = document.getElementById('progress-fill');
  if (pf) pf.style.width = '0%';
  const tc = document.getElementById('turn-count');
  if (tc) tc.textContent = '0';
  const pc = document.getElementById('pass-current');
  if (pc) pc.textContent = '1';
  lastTurnCount = 0;
}

document.getElementById('start-btn').addEventListener('click', async () => {
  const prompt = document.getElementById('prompt-input').value.trim();
  if (!prompt) {
    document.getElementById('prompt-input').style.borderColor = '#ef4444';
    return;
  }

  document.getElementById('start-btn').disabled = true;
  document.getElementById('start-btn').textContent = 'Starting...';

  // Clear any prior discussion's rendered state before the new session begins.
  resetDiscussionUI();

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
// Capture current answer from the stuck model
document.getElementById('capture-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('capture-btn');
  btn.textContent = 'Capturing...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'FORCE_CAPTURE' });
  setTimeout(() => { btn.textContent = 'Capture'; btn.disabled = false; }, 3000);
});

// Paste response manually
document.getElementById('paste-btn')?.addEventListener('click', () => {
  document.getElementById('paste-modal').classList.remove('hidden');
  document.getElementById('paste-textarea').value = '';
  document.getElementById('paste-textarea').focus();
});

document.getElementById('paste-cancel')?.addEventListener('click', () => {
  document.getElementById('paste-modal').classList.add('hidden');
});

document.getElementById('paste-submit')?.addEventListener('click', async () => {
  const text = document.getElementById('paste-textarea').value.trim();
  if (!text) return;
  document.getElementById('paste-modal').classList.add('hidden');
  const btn = document.getElementById('paste-btn');
  btn.textContent = 'Submitting...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'MANUAL_RESPONSE', response: text });
  setTimeout(() => { btn.textContent = 'Paste'; btn.disabled = false; }, 3000);
});

// v0.6.0 — short-response confirmation modal. Only (re)populate when the
// pending turn changes, so the 1.5s poll loop doesn't wipe out text the user
// is typing into the confirm textarea.
let confirmShownFor = null;
function showConfirmModal(pc) {
  const modal = document.getElementById('confirm-modal');
  if (!modal) return;
  if (confirmShownFor !== pc.turnIndex) {
    document.getElementById('confirm-len').textContent = pc.length ?? 0;
    document.getElementById('confirm-preview').textContent = pc.preview || '(empty)';
    document.getElementById('confirm-textarea').value = '';
    confirmShownFor = pc.turnIndex;
  }
  modal.classList.remove('hidden');
}
function hideConfirmModal() {
  document.getElementById('confirm-modal')?.classList.add('hidden');
  confirmShownFor = null;
}

// "Looks good" — accept the short capture as-is and resume the rotation.
document.getElementById('confirm-looks-good')?.addEventListener('click', async () => {
  const btn = document.getElementById('confirm-looks-good');
  btn.disabled = true; btn.textContent = 'Continuing...';
  await chrome.runtime.sendMessage({ type: 'CONFIRM_RESPONSE' });
  hideConfirmModal();
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Looks good — continue'; }, 2000);
});

// "Use pasted text" — replace the captured turn with the user's full paste,
// then resume. Falls back to a plain confirm if the textarea is empty.
document.getElementById('confirm-replace')?.addEventListener('click', async () => {
  const text = document.getElementById('confirm-textarea').value.trim();
  const btn = document.getElementById('confirm-replace');
  btn.disabled = true; btn.textContent = 'Continuing...';
  if (text) {
    await chrome.runtime.sendMessage({ type: 'REPLACE_AND_CONTINUE', response: text });
  } else {
    await chrome.runtime.sendMessage({ type: 'CONFIRM_RESPONSE' });
  }
  hideConfirmModal();
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Use pasted text — continue'; }, 2000);
});

// Retry current model in a fresh chat
document.getElementById('retry-model-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('retry-model-btn');
  btn.textContent = 'Retrying...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'RETRY_MODEL' });
  setTimeout(() => { btn.textContent = 'Retry'; btn.disabled = false; }, 5000);
});

// Skip current model and continue discussion
document.getElementById('skip-btn')?.addEventListener('click', async () => {
  const btn = document.getElementById('skip-btn');
  btn.textContent = 'Skipping...';
  btn.disabled = true;
  await chrome.runtime.sendMessage({ type: 'SKIP_MODEL' });
  setTimeout(() => { btn.textContent = 'Skip'; btn.disabled = false; }, 3000);
});

document.getElementById('cancel-btn')?.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CANCEL_SESSION' });
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  document.getElementById('start-btn').disabled = false;
  document.getElementById('start-btn').textContent = 'Start Discussion';
  stopPolling();
});

// New session (full reset — also clears the prompt input and uploaded files)
document.getElementById('new-btn')?.addEventListener('click', () => {
  document.getElementById('setup-section').classList.remove('hidden');
  document.getElementById('discussion-section').classList.add('hidden');
  resetDiscussionUI();
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

// ─── PDF Export Helpers ─────────────────────────────────────────────────
// Two flavors:
//   1) Responses-only PDF: the synthesis the user reads, round-by-round
//   2) Prompts + Responses PDF: shows the exact prompt sent to each model
//      alongside its response — proves the conversation chain is being
//      passed between models round to round (vs. each model receiving the
//      original prompt cold each time).
// Chrome extensions can't directly write a PDF without bundling a library
// (jsPDF, pdfmake, etc., 100KB+). The cleaner approach: build an HTML
// document styled with @media print and trigger window.print() — the user
// gets the native browser "Save as PDF" dialog. Zero extra deps, native
// rendering, and the user controls the file destination.

// Note: escapeHtml is already defined later in this file and is hoisted
// to top of script — reusing the existing helper instead of redeclaring.

function roleLabel(role) {
  return {
    initial: 'Initial Answer',
    critique: 'Critique',
    revision: 'Revision',
    synthesis: 'Final Synthesis',
  }[role] || role;
}

function buildPdfHtml({ title, subtitle, prompt, models, passes, blocks, sessionId }) {
  // Generated PDF window — we open this in a new tab and immediately
  // trigger window.print(). Print-specific CSS keeps the output clean
  // when the user saves to PDF.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    background: #fff; color: #1e293b; margin: 0; padding: 36px 40px;
    -webkit-font-smoothing: antialiased; line-height: 1.55; font-size: 11.5pt; }
  h1 { font-size: 22pt; color: #0f172a; margin: 0 0 6px 0; letter-spacing: -0.3px; }
  h2 { font-size: 13pt; color: #1e293b; margin: 22px 0 8px 0;
    border-bottom: 1.5px solid #0f172a; padding-bottom: 4px; }
  .sub { color: #64748b; font-size: 10.5pt; margin-bottom: 14px; }
  .meta { background: #f8fafc; border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 10px 14px; font-size: 10pt; color: #334155; margin-bottom: 24px; }
  .meta b { color: #0f172a; }
  .meta-row { margin: 3px 0; }
  .prompt-box { background: #fef3c7; border-left: 3px solid #b45309;
    padding: 10px 14px; margin: 10px 0 14px 0; font-size: 10.5pt;
    color: #4a2c0b; white-space: pre-wrap; word-wrap: break-word; }
  .prompt-box strong { color: #92400e; display: block; margin-bottom: 4px;
    font-size: 10pt; text-transform: uppercase; letter-spacing: 0.5px; }
  .response-box { background: #f0fdf4; border-left: 3px solid #16a34a;
    padding: 10px 14px; margin: 0 0 22px 0; font-size: 11pt;
    color: #064e3b; white-space: pre-wrap; word-wrap: break-word; }
  .response-box strong { color: #15803d; display: block; margin-bottom: 4px;
    font-size: 10pt; text-transform: uppercase; letter-spacing: 0.5px; }
  .turn { page-break-inside: avoid; margin-bottom: 6px; }
  .turn-header { font-weight: 700; color: #0f172a; font-size: 11.5pt;
    margin: 16px 0 6px 0; padding-bottom: 4px;
    border-bottom: 1px dashed #cbd5e1; }
  .turn-header .pill { display: inline-block; background: #0f172a; color: #fff;
    padding: 2px 8px; border-radius: 3px; font-size: 9pt; margin-left: 8px;
    font-weight: 600; letter-spacing: 0.4px; }
  .footer { margin-top: 32px; padding-top: 14px; border-top: 1px solid #cbd5e1;
    color: #64748b; font-size: 9pt; }
  @media print {
    body { padding: 18px 20px; }
    .no-print { display: none !important; }
    h2 { page-break-after: avoid; }
    .turn { page-break-inside: avoid; }
  }
  .print-bar { background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 8px 14px; margin: -8px 0 18px 0; font-size: 10pt; color: #334155;
    display: flex; justify-content: space-between; align-items: center; }
  .print-bar button { background: #0f172a; color: #fff; border: none;
    padding: 6px 14px; border-radius: 4px; font-size: 10pt; cursor: pointer;
    font-family: inherit; }
</style>
</head>
<body>
  <div class="print-bar no-print">
    <span>Use your browser&rsquo;s <b>Save as PDF</b> in the print dialog to save this report.</span>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${escapeHtml(subtitle)}</div>
  <div class="meta">
    <div class="meta-row"><b>Session ID:</b> ${escapeHtml(sessionId)}</div>
    <div class="meta-row"><b>Models:</b> ${escapeHtml(models)}</div>
    <div class="meta-row"><b>Rounds:</b> ${escapeHtml(String(passes))}</div>
    <div class="meta-row"><b>Original prompt:</b></div>
    <div style="white-space:pre-wrap;margin-top:4px;color:#0f172a;font-size:10.5pt;">${escapeHtml(prompt)}</div>
  </div>
  ${blocks}
  <div class="footer">
    Generated by MindM3rge &mdash; ${new Date().toLocaleString()}
  </div>
  <script>
    // Auto-open the print dialog so the user can immediately save as PDF.
    // The print-bar button remains as a fallback if the dialog is dismissed.
    setTimeout(() => { try { window.print(); } catch (e) {} }, 250);
  </script>
</body></html>`;
}

function buildResponsesOnlyBlocks(turns) {
  // Group by round so the PDF reads as round-by-round synthesis
  const byRound = new Map();
  for (const t of turns) {
    const r = t.round || 1;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(t);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  let html = '';
  for (const r of rounds) {
    html += `<h2>Round ${r}</h2>`;
    for (const t of byRound.get(r)) {
      html += `<div class="turn">
        <div class="turn-header">${escapeHtml(t.modelName || t.model)}
          <span class="pill">${escapeHtml(roleLabel(t.role))}</span></div>
        <div class="response-box"><strong>Response</strong>${escapeHtml(t.content)}</div>
      </div>`;
    }
  }
  return html;
}

function buildPromptsAndResponsesBlocks(turns) {
  const byRound = new Map();
  for (const t of turns) {
    const r = t.round || 1;
    if (!byRound.has(r)) byRound.set(r, []);
    byRound.get(r).push(t);
  }
  const rounds = [...byRound.keys()].sort((a, b) => a - b);
  let html = '';
  for (const r of rounds) {
    html += `<h2>Round ${r}</h2>`;
    for (const t of byRound.get(r)) {
      const prompt = t.promptSent
        ? escapeHtml(t.promptSent)
        : '<em style="color:#94a3b8;">[Prompt was not captured for this turn &mdash; this turn predates the prompt-capture instrumentation in the extension.]</em>';
      html += `<div class="turn">
        <div class="turn-header">${escapeHtml(t.modelName || t.model)}
          <span class="pill">${escapeHtml(roleLabel(t.role))}</span></div>
        <div class="prompt-box"><strong>Prompt sent to ${escapeHtml(t.modelName || t.model)}</strong>${prompt}</div>
        <div class="response-box"><strong>${escapeHtml(t.modelName || t.model)} response</strong>${escapeHtml(t.content)}</div>
      </div>`;
    }
  }
  return html;
}

async function exportPdf(kind) {
  const status = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  if (!status?.session) return;
  const s = status.session;
  const models = s.modelOrder.map(m => MODEL_NAMES[m] || m).join(', ');
  const prompt = s.originalPrompt || s.prompt || '(none)';
  const sessionId = s.id || '(unknown)';
  const title = kind === 'full'
    ? 'MindM3rge — Prompts and Responses'
    : 'MindM3rge — Round-by-Round Responses';
  const subtitle = kind === 'full'
    ? 'Every prompt sent to each model + each model&rsquo;s response, by round'
    : 'Each model&rsquo;s response by round';
  const blocks = kind === 'full'
    ? buildPromptsAndResponsesBlocks(s.turns)
    : buildResponsesOnlyBlocks(s.turns);

  const html = buildPdfHtml({ title, subtitle, prompt, models, passes: s.passes, blocks, sessionId });
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  // Open in a new tab so the user gets the native browser print-to-PDF flow.
  // setTimeout in the generated HTML triggers window.print() automatically.
  const win = window.open(url, '_blank');
  if (!win) {
    // Pop-up blocked — fall back to download
    const a = document.createElement('a');
    a.href = url;
    a.download = `mindmerge-${kind}-${sessionId}.html`;
    a.click();
  }
  // Revoke after a short delay so the new tab has time to load
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

document.getElementById('export-responses-pdf-btn')?.addEventListener('click', () => exportPdf('responses'));
document.getElementById('export-full-pdf-btn')?.addEventListener('click', () => exportPdf('full'));

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
      // Pass the actual array index so the edit handler can target
      // the right turn when sending EDIT_TURN to the background.
      feed.appendChild(createTurnCard(turn, i));
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

  // v0.6.0 — short-response confirmation gate. When the background pauses on a
  // suspiciously short ChatGPT capture, surface the confirm panel so the user
  // can accept it or paste the real answer before the rotation continues.
  if (session.status === 'awaiting_confirmation' && session.pendingConfirmation) {
    showConfirmModal(session.pendingConfirmation);
  } else {
    hideConfirmModal();
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

const MODEL_ICONS = {
  claude: `<svg width="18" height="18" viewBox="0 0 24 24" fill="#D97706"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"/></svg>`,
  chatgpt: `<svg width="18" height="18" viewBox="0 0 24 24"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.047 6.047 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z" fill="#10a37f"/></svg>`,
  gemini: `<svg width="18" height="18" viewBox="0 0 28 28"><path d="M14 0C14 7.73 7.73 14 0 14C7.73 14 14 20.27 14 28C14 20.27 20.27 14 28 14C20.27 14 14 7.73 14 0Z" fill="url(#gem-t)"/><defs><linearGradient id="gem-t" x1="0" y1="0" x2="28" y2="28"><stop offset="0%" stop-color="#4285F4"/><stop offset="33%" stop-color="#EA4335"/><stop offset="66%" stop-color="#FBBC05"/><stop offset="100%" stop-color="#34A853"/></linearGradient></defs></svg>`,
};

function createTurnCard(turn, turnIndex) {
  const card = document.createElement('div');
  card.className = `turn ${turn.model}`;
  // Stash the index so handlers can find it later (button event listeners
  // can also use closures, but data-* is the simplest read path).
  if (typeof turnIndex === 'number') card.dataset.turnIndex = String(turnIndex);

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
    <div class="turn-avatar">${MODEL_ICONS[turn.model] || ''}</div>
    <div class="turn-content">
      <div class="turn-top">
        <span class="turn-name">${turn.modelName}</span>
        <span class="turn-badge">${roleLabels[turn.role] || turn.role}</span>
        <span class="turn-meta">R${turn.round} · ${time}</span>
        <div class="turn-actions">
          <button class="turn-act pin-btn" title="Pin" data-turn="${turnId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l-1.5 5.5L17 11H7l3.5-3.5z"/></svg></button>
          <button class="turn-act ann-btn" title="Annotate" data-turn="${turnId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></button>
          <button class="turn-act edit-btn" title="Edit response — useful if MindM3rge captured the response incorrectly. Edits propagate to all subsequent prompts in the chain." data-turn="${turnId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg></button>
          <button class="turn-act retry" title="Retry this turn" data-turn="${turnId}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg></button>
        </div>
      </div>
      <div class="turn-body">${escapeHtml(turn.content)}</div>
    </div>
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
    const contentEl = card.querySelector('.turn-content');
    contentEl.appendChild(toggle);
  }

  // Pin button
  card.querySelector('.pin-btn').addEventListener('click', (e) => {
    e.target.closest('.turn-act').classList.toggle('pinned');
  });

  // Annotation button
  card.querySelector('.ann-btn').addEventListener('click', (e) => {
    const contentEl = card.querySelector('.turn-content');
    const existing = contentEl.querySelector('.ann-input');
    if (existing) { existing.remove(); return; }
    const input = document.createElement('input');
    input.className = 'ann-input';
    input.placeholder = 'Add a note about this response...';
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && input.value.trim()) {
        const ann = document.createElement('div');
        ann.className = 'annotation';
        ann.innerHTML = `<span class="ann-icon"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg></span><span class="ann-text">${escapeHtml(input.value)}</span>`;
        input.replaceWith(ann);
        e.target.classList.add('annotated');
      }
    });
    contentEl.appendChild(input);
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

  // Edit button — inline textarea so the user can override the captured
  // response live. Useful when MindM3rge's content-script capture grabs
  // a partial / wrong response. After saving, the corrected text replaces
  // session.turns[turnIndex].content in storage, and is what gets baked
  // into every subsequent buildCritiquePrompt / buildRevisionPrompt /
  // buildSynthesisPrompt call by getNextAction(). Edits do NOT retro-
  // actively change prompts already sent to downstream models — only
  // future prompts.
  card.querySelector('.edit-btn').addEventListener('click', () => {
    const contentEl = card.querySelector('.turn-content');
    const bodyEl = card.querySelector('.turn-body');
    // Toggle off if already editing
    if (card.classList.contains('editing')) {
      const existing = contentEl.querySelector('.turn-edit-wrap');
      if (existing) existing.remove();
      bodyEl.style.display = '';
      card.classList.remove('editing');
      return;
    }
    card.classList.add('editing');
    const wrap = document.createElement('div');
    wrap.className = 'turn-edit-wrap';
    wrap.style.cssText = 'margin-top:8px;';
    const ta = document.createElement('textarea');
    ta.className = 'turn-edit-area';
    ta.value = turn.content;
    ta.style.cssText = 'width:100%;min-height:140px;max-height:480px;padding:10px;border:1px solid var(--accent,#7c5cfc);border-radius:6px;background:rgba(124,92,252,0.05);color:var(--text,#f5f5f7);font-family:inherit;font-size:13px;line-height:1.5;resize:vertical;box-sizing:border-box;';
    const note = document.createElement('div');
    note.style.cssText = 'font-size:11px;color:var(--text2,#86868b);margin:4px 0 8px 2px;';
    note.textContent = 'Edits propagate to all SUBSEQUENT prompts. Prompts already sent to downstream models are unchanged.';
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'display:flex;gap:8px;margin-top:6px;';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save edit';
    saveBtn.style.cssText = 'background:var(--accent,#7c5cfc);color:#fff;border:none;padding:6px 14px;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';
    cancelBtn.style.cssText = 'background:rgba(255,255,255,0.05);color:var(--text,#f5f5f7);border:1px solid rgba(255,255,255,0.12);padding:6px 14px;border-radius:5px;font-size:12px;cursor:pointer;font-family:inherit;';
    const status = document.createElement('span');
    status.style.cssText = 'font-size:11px;color:var(--text2,#86868b);margin-left:8px;align-self:center;';

    const cleanup = () => {
      wrap.remove();
      bodyEl.style.display = '';
      card.classList.remove('editing');
    };

    cancelBtn.addEventListener('click', cleanup);
    saveBtn.addEventListener('click', async () => {
      const newContent = ta.value;
      // Read the array index off the card dataset — set when the card
      // was created in the updateUI render loop.
      const turnIndex = Number(card.dataset.turnIndex);
      if (!Number.isInteger(turnIndex) || turnIndex < 0) {
        status.textContent = 'Error: could not determine turn index';
        return;
      }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'EDIT_TURN',
          turnIndex,
          content: newContent,
        });
        if (!res?.ok) {
          status.textContent = res?.error ? `Error: ${res.error}` : 'Save failed';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save edit';
          return;
        }
        // Update local turn so closure stays accurate
        turn.content = newContent;
        // Update the visible body and the data-content search index
        bodyEl.textContent = newContent;
        card.dataset.content = newContent;
        // Mark the card so the user can see it's been edited
        card.classList.add('user-edited');
        if (!card.querySelector('.edit-badge')) {
          const badge = document.createElement('span');
          badge.className = 'edit-badge';
          badge.textContent = 'edited';
          badge.style.cssText = 'display:inline-block;background:#7c5cfc;color:#fff;font-size:10px;padding:2px 8px;border-radius:3px;margin-left:6px;font-weight:600;letter-spacing:0.3px;text-transform:uppercase;';
          card.querySelector('.turn-meta')?.appendChild(badge);
        }
        cleanup();
      } catch (e) {
        status.textContent = `Error: ${e.message || e}`;
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save edit';
      }
    });

    btnRow.appendChild(saveBtn);
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(status);
    wrap.appendChild(ta);
    wrap.appendChild(note);
    wrap.appendChild(btnRow);
    // Hide the rendered body while editing so the textarea is the source of truth
    bodyEl.style.display = 'none';
    contentEl.appendChild(wrap);
    ta.focus();
    // Place cursor at end of text for convenience
    ta.setSelectionRange(ta.value.length, ta.value.length);
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
    const restorable = ['running', 'complete', 'awaiting_confirmation'];
    if (status?.session && restorable.includes(status.session.status)) {
      document.getElementById('setup-section').classList.add('hidden');
      document.getElementById('discussion-section').classList.remove('hidden');
      lastTurnCount = 0;
      updateUI(status.session);
      // Keep polling while running OR paused on confirmation (so resume is picked up).
      if (status.session.status !== 'complete') startPolling();
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

  // Re-check connections when user returns to the dashboard tab
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkConnections();
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
