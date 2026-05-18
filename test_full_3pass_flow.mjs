// Comprehensive test: walk through a full 3-pass discussion step-by-step and
// assert that every prompt sent to every LLM contains all prior cross-model turns.
// Run: node test_full_3pass_flow.mjs

import { buildCritiquePrompt, buildRevisionPrompt, buildSynthesisPrompt } from './src/utils/prompts.js';

// Simulate exactly what background/index.js does in getNextAction at each step.
// Three models, three passes:
//   Pass 1: Claude initial → ChatGPT critique → Gemini critique
//   Pass 2: Claude revision → ChatGPT critique → Gemini critique
//   Pass 3: Claude revision → ChatGPT critique → Gemini critique
//   Synthesis: by ChatGPT or Gemini

const MODEL_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const starterModel = 'claude';
const modelOrder = ['claude', 'chatgpt', 'gemini'];
const otherModels = modelOrder.filter(m => m !== starterModel);
const passes = 3;
const userPrompt = 'WHAT-USER-ASKED';
const directives = [];

let turns = [];

// Each step pushes a fake response then computes the next prompt.
// We then assert what content the next prompt contains.

function fakeResponse(model, role, round) {
  return `${MODEL_NAMES[model]}-${role.toUpperCase()}-P${round}`;
}

function pushTurn(model, role, round) {
  turns.push({
    model,
    modelName: MODEL_NAMES[model],
    role,
    round,
    content: fakeResponse(model, role, round),
  });
}

function critiqueP(currentPass) {
  // Mirrors getNextAction's critique-prompt building
  return buildCritiquePrompt(
    userPrompt,
    '',
    '',
    currentPass,
    passes,
    directives,
    turns
  );
}

function revisionP(currentPass) {
  // Mirrors getNextAction's revision-prompt building (post-fix call site)
  const critiquesThisPass = turns.filter(t => t.role === 'critique' && t.round === currentPass);
  const critiques = critiquesThisPass.map(t => ({ modelName: t.modelName, content: t.content }));
  const originalResponse = turns.find(
    t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'),
  )?.content || '';
  return buildRevisionPrompt(userPrompt, MODEL_NAMES[starterModel], originalResponse, critiques, turns);
}

function assertContains(label, prompt, needles) {
  let allOk = true;
  for (const n of needles) {
    const ok = prompt.includes(n);
    if (!ok) {
      console.log(`  FAIL — ${label}: missing "${n}"`);
      allOk = false;
    }
  }
  if (allOk) console.log(`  PASS — ${label}: all ${needles.length} needle(s) present`);
  return allOk;
}

let totalFail = 0;

// === Pass 1 ===
console.log('\n=== PASS 1 ===');
pushTurn('claude', 'initial', 1);

// Next: ChatGPT critique. Should see Claude's initial.
let p = critiqueP(1);
if (!assertContains('ChatGPT P1 critique sees Claude P1 initial', p, ['Claude-INITIAL-P1'])) totalFail++;
pushTurn('chatgpt', 'critique', 1);

// Next: Gemini critique. Should see Claude P1 initial + ChatGPT P1 critique.
p = critiqueP(1);
if (!assertContains('Gemini P1 critique sees full P1', p, ['Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1'])) totalFail++;
pushTurn('gemini', 'critique', 1);

// === Pass 2 ===
console.log('\n=== PASS 2 ===');
// Next: Claude revision. Should see ALL of P1.
p = revisionP(1);
if (!assertContains('Claude P2 revision sees full P1', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
])) totalFail++;
pushTurn('claude', 'revision', 2);

// Next: ChatGPT P2 critique. Should see ALL of P1 + Claude P2 revision.
p = critiqueP(2);
if (!assertContains('ChatGPT P2 critique sees all prior', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1', 'Claude-REVISION-P2',
])) totalFail++;
pushTurn('chatgpt', 'critique', 2);

// Next: Gemini P2 critique.
p = critiqueP(2);
if (!assertContains('Gemini P2 critique sees all prior', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
  'Claude-REVISION-P2', 'ChatGPT-CRITIQUE-P2',
])) totalFail++;
pushTurn('gemini', 'critique', 2);

// === Pass 3 ===
console.log('\n=== PASS 3 ===');
// Next: Claude revision. Should see ALL of P1 and P2. THIS IS THE BUG CASE.
p = revisionP(2);
if (!assertContains('Claude P3 revision sees full P1+P2', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
  'Claude-REVISION-P2', 'ChatGPT-CRITIQUE-P2', 'Gemini-CRITIQUE-P2',
])) totalFail++;
pushTurn('claude', 'revision', 3);

// Next: ChatGPT P3 critique.
p = critiqueP(3);
if (!assertContains('ChatGPT P3 critique sees all prior', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
  'Claude-REVISION-P2', 'ChatGPT-CRITIQUE-P2', 'Gemini-CRITIQUE-P2',
  'Claude-REVISION-P3',
])) totalFail++;
pushTurn('chatgpt', 'critique', 3);

// Next: Gemini P3 critique.
p = critiqueP(3);
if (!assertContains('Gemini P3 critique sees all prior', p, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
  'Claude-REVISION-P2', 'ChatGPT-CRITIQUE-P2', 'Gemini-CRITIQUE-P2',
  'Claude-REVISION-P3', 'ChatGPT-CRITIQUE-P3',
])) totalFail++;
pushTurn('gemini', 'critique', 3);

// === Synthesis ===
console.log('\n=== SYNTHESIS ===');
const synth = buildSynthesisPrompt(userPrompt, turns);
if (!assertContains('Synthesis sees every turn', synth, [
  'Claude-INITIAL-P1', 'ChatGPT-CRITIQUE-P1', 'Gemini-CRITIQUE-P1',
  'Claude-REVISION-P2', 'ChatGPT-CRITIQUE-P2', 'Gemini-CRITIQUE-P2',
  'Claude-REVISION-P3', 'ChatGPT-CRITIQUE-P3', 'Gemini-CRITIQUE-P3',
])) totalFail++;

console.log(`\n${totalFail === 0 ? '✅ ALL CHECKS PASSED' : `❌ ${totalFail} CHECK(S) FAILED`}`);
process.exit(totalFail === 0 ? 0 : 1);
