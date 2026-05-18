// Parameterized N-pass test. Simulates full flow for any number of passes and
// asserts that every prompt sent to every LLM contains every prior turn.
// Run: node test_N_pass_flow.mjs

import { buildCritiquePrompt, buildRevisionPrompt, buildSynthesisPrompt } from './src/utils/prompts.js';

const MODEL_NAMES = { claude: 'Claude', chatgpt: 'ChatGPT', gemini: 'Gemini' };
const starterModel = 'claude';
const modelOrder = ['claude', 'chatgpt', 'gemini'];
const otherModels = modelOrder.filter(m => m !== starterModel);
const userPrompt = 'WHAT-USER-ASKED';
const directives = [];

function runForPasses(passes) {
  let turns = [];

  const pushTurn = (model, role, round) => turns.push({
    model,
    modelName: MODEL_NAMES[model],
    role,
    round,
    content: `${MODEL_NAMES[model]}-${role.toUpperCase()}-P${round}`,
  });

  const critiqueP = (currentPass) =>
    buildCritiquePrompt(userPrompt, '', '', currentPass, passes, directives, turns);

  const revisionP = (currentPass) => {
    const critiquesThisPass = turns.filter(t => t.role === 'critique' && t.round === currentPass);
    const critiques = critiquesThisPass.map(t => ({ modelName: t.modelName, content: t.content }));
    const originalResponse = turns.find(
      t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'),
    )?.content || '';
    return buildRevisionPrompt(userPrompt, MODEL_NAMES[starterModel], originalResponse, critiques, turns);
  };

  let failures = 0;
  let totalChecks = 0;

  const allPriorContent = () => turns.map(t => t.content);

  // Pass 1
  pushTurn('claude', 'initial', 1);
  for (let i = 0; i < otherModels.length; i++) {
    const expected = allPriorContent();
    const prompt = critiqueP(1);
    for (const needle of expected) {
      totalChecks++;
      if (!prompt.includes(needle)) {
        failures++;
        console.log(`  FAIL — passes=${passes} P1 ${otherModels[i]} critique missing "${needle}"`);
      }
    }
    pushTurn(otherModels[i], 'critique', 1);
  }

  // Passes 2 through N
  for (let pass = 2; pass <= passes; pass++) {
    // Revision step: starter sees ALL prior turns from prior passes
    const expectedRev = allPriorContent();
    const revPrompt = revisionP(pass - 1);
    for (const needle of expectedRev) {
      totalChecks++;
      if (!revPrompt.includes(needle)) {
        failures++;
        console.log(`  FAIL — passes=${passes} P${pass} revision missing "${needle}"`);
      }
    }
    pushTurn(starterModel, 'revision', pass);

    // Critique steps: each non-starter critiques and must see everything before it
    for (let i = 0; i < otherModels.length; i++) {
      const expected = allPriorContent();
      const prompt = critiqueP(pass);
      for (const needle of expected) {
        totalChecks++;
        if (!prompt.includes(needle)) {
          failures++;
          console.log(`  FAIL — passes=${passes} P${pass} ${otherModels[i]} critique missing "${needle}"`);
        }
      }
      pushTurn(otherModels[i], 'critique', pass);
    }
  }

  // Synthesis
  const expected = allPriorContent();
  const synth = buildSynthesisPrompt(userPrompt, turns);
  for (const needle of expected) {
    totalChecks++;
    if (!synth.includes(needle)) {
      failures++;
      console.log(`  FAIL — passes=${passes} synthesis missing "${needle}"`);
    }
  }

  console.log(`passes=${passes}: ${totalChecks - failures}/${totalChecks} checks passed (${turns.length} turns total)`);
  return failures;
}

let grandFail = 0;
for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
  grandFail += runForPasses(n);
}

console.log(`\n${grandFail === 0 ? '✅ ALL N-PASS CONFIGURATIONS PASS (1–10 passes)' : `❌ ${grandFail} FAILURE(S)`}`);
process.exit(grandFail === 0 ? 0 : 1);
