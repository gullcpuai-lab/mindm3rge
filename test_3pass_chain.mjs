// Quick test: does the 3-pass revision prompt include the full discussion history?
// Run: node test_3pass_chain.mjs

import { buildCritiquePrompt, buildRevisionPrompt, buildSynthesisPrompt } from './src/utils/prompts.js';

// Simulate a 3-pass session right before pass 3 starts (revision step).
// State after pass 2 completes:
//   turns = [
//     {role:'initial',   model:'claude',  modelName:'Claude',  round:1, content:'P1-CLAUDE-INITIAL'},
//     {role:'critique',  model:'chatgpt', modelName:'ChatGPT', round:1, content:'P1-CHATGPT-CRITIQUE'},
//     {role:'critique',  model:'gemini',  modelName:'Gemini',  round:1, content:'P1-GEMINI-CRITIQUE'},
//     {role:'revision',  model:'claude',  modelName:'Claude',  round:2, content:'P2-CLAUDE-REVISION'},
//     {role:'critique',  model:'chatgpt', modelName:'ChatGPT', round:2, content:'P2-CHATGPT-CRITIQUE'},
//     {role:'critique',  model:'gemini',  modelName:'Gemini',  round:2, content:'P2-GEMINI-CRITIQUE'},
//   ]
// Next action: pass 3 begins with Claude doing a revision.

const turns = [
  { role: 'initial',  model: 'claude',  modelName: 'Claude',  round: 1, content: 'P1-CLAUDE-INITIAL' },
  { role: 'critique', model: 'chatgpt', modelName: 'ChatGPT', round: 1, content: 'P1-CHATGPT-CRITIQUE' },
  { role: 'critique', model: 'gemini',  modelName: 'Gemini',  round: 1, content: 'P1-GEMINI-CRITIQUE' },
  { role: 'revision', model: 'claude',  modelName: 'Claude',  round: 2, content: 'P2-CLAUDE-REVISION' },
  { role: 'critique', model: 'chatgpt', modelName: 'ChatGPT', round: 2, content: 'P2-CHATGPT-CRITIQUE' },
  { role: 'critique', model: 'gemini',  modelName: 'Gemini',  round: 2, content: 'P2-GEMINI-CRITIQUE' },
];

// Replicate the revision-step prompt construction from background/index.js line ~248
const currentPass = 2;
const passes = 3;
const starterName = 'Claude';
const userPrompt = 'WHAT-USER-ASKED';

const critiquesThisPass = turns.filter(t => t.role === 'critique' && t.round === currentPass);
const critiques = critiquesThisPass.map(t => ({ modelName: t.modelName, content: t.content }));
const originalResponse = turns.find(
  t => t.round === currentPass && (t.role === 'initial' || t.role === 'revision'),
)?.content || '';

// Match the call site in background/index.js — passes `turns` for full history
const revisionPrompt = buildRevisionPrompt(userPrompt, starterName, originalResponse, critiques, turns);

console.log('==== PROMPT SENT TO STARTER FOR PASS 3 REVISION ====');
console.log(revisionPrompt);
console.log('==== END PROMPT ====\n');

// Assertions
const checks = [
  { name: 'P1 initial present',      needle: 'P1-CLAUDE-INITIAL'  },
  { name: 'P1 ChatGPT critique',     needle: 'P1-CHATGPT-CRITIQUE' },
  { name: 'P1 Gemini critique',      needle: 'P1-GEMINI-CRITIQUE'  },
  { name: 'P2 revision present',     needle: 'P2-CLAUDE-REVISION' },
  { name: 'P2 ChatGPT critique',     needle: 'P2-CHATGPT-CRITIQUE' },
  { name: 'P2 Gemini critique',      needle: 'P2-GEMINI-CRITIQUE'  },
];

let pass = 0, fail = 0;
for (const c of checks) {
  const ok = revisionPrompt.includes(c.needle);
  console.log(`${ok ? 'PASS' : 'FAIL'} — ${c.name} (${c.needle})`);
  ok ? pass++ : fail++;
}
console.log(`\n${pass}/${checks.length} checks passed.`);
process.exit(fail > 0 ? 1 : 0);
