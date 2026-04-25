// Critique prompt templates for multi-model validation

export function buildCritiquePrompt(originalPrompt, previousModelName, previousResponse, roundNumber, totalRounds, directives) {
  const directiveBlock = directives && directives.length > 0
    ? `\n\nFOCUS YOUR CRITIQUE ON THESE SPECIFIC AREAS:\n${directives.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n`
    : '';

  // Extract goal from the prompt if present
  const goalMatch = originalPrompt.match(/--- DISCUSSION GOAL ---\n([\s\S]*?)\n--- END GOAL ---/);
  const goalBlock = goalMatch
    ? `\n\nDISCUSSION GOAL: ${goalMatch[1].trim()}\nYou must work toward this goal. Don't just critique — actively propose specific improvements and fixes.\n`
    : '';

  return `You are participating in a multi-model validation process (Round ${roundNumber}/${totalRounds}).

ORIGINAL USER PROMPT:
${originalPrompt}

${previousModelName.toUpperCase()}'S RESPONSE:
${previousResponse}
${goalBlock}${directiveBlock}
Please provide a thorough, structured critique of the above response:

1. **STRENGTHS**: What is correct, well-reasoned, or valuable in this response?
2. **WEAKNESSES**: What is incorrect, poorly reasoned, incomplete, or misleading?
3. **RISKS**: What assumptions are dangerous, unvalidated, or could lead to bad outcomes?
4. **GAPS**: What important aspects were not addressed or were overlooked?
5. **ALTERNATIVES**: What different approaches, frameworks, or perspectives should be considered?
6. **IMPROVED ANSWER**: Provide your own improved version of the answer, incorporating the strengths of the original while addressing the weaknesses you identified.

Be rigorous, specific, and constructive. Do not be deferential — if the previous response is wrong, say so clearly and explain why.`;
}

export function buildRevisionPrompt(originalPrompt, modelName, originalResponse, critiques) {
  const critiqueText = critiques.map((c, i) =>
    `--- ${c.modelName}'s Critique ---\n${c.content}`
  ).join('\n\n');

  return `You are ${modelName}. You previously provided a response to a prompt, and other AI models have critiqued your answer.

ORIGINAL PROMPT:
${originalPrompt}

YOUR ORIGINAL RESPONSE:
${originalResponse}

CRITIQUES FROM OTHER MODELS:
${critiqueText}

Please revise your response based on the critiques above. You may:
- Accept valid criticisms and incorporate them
- Defend parts of your original answer if the critiques are wrong (explain why)
- Add new insights prompted by the discussion

Provide your revised, improved answer.`;
}

export function buildSynthesisPrompt(originalPrompt, allTurns) {
  const discussion = allTurns.map((t, i) =>
    `--- ${t.modelName} (${t.role}, Round ${t.round}) ---\n${t.content}`
  ).join('\n\n');

  return `You are synthesizing a multi-model discussion into a final answer.

ORIGINAL PROMPT:
${originalPrompt}

FULL DISCUSSION:
${discussion}

Please produce a final synthesized answer that includes:

1. **FINAL ANSWER**: The best possible answer to the original prompt, incorporating the strongest reasoning from all models.
2. **CONSENSUS**: Key points where all models agreed.
3. **DISAGREEMENTS**: Key points where models disagreed, and which position is strongest.
4. **KEY RISKS**: Important risks, caveats, or assumptions identified during the discussion.
5. **CONFIDENCE**: Rate your confidence in this final answer (Low / Medium / High) and explain why.

Produce the most thorough, well-reasoned answer possible.`;
}
