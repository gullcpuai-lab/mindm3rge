// Critique prompt templates for multi-model validation

export function buildCritiquePrompt(originalPrompt, previousModelName, previousResponse, roundNumber, totalRounds, directives, priorTurns) {
  const directiveBlock = directives && directives.length > 0
    ? `\n\nFOCUS YOUR CRITIQUE ON THESE SPECIFIC AREAS:\n${directives.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n`
    : '';

  // Extract goal from the prompt if present
  const goalMatch = originalPrompt.match(/--- DISCUSSION GOAL ---\n([\s\S]*?)\n--- END GOAL ---/);
  const goalBlock = goalMatch
    ? `\n\nDISCUSSION GOAL: ${goalMatch[1].trim()}\nYou must work toward this goal. Don't just critique — actively propose specific improvements and fixes.\n`
    : '';

  // Build discussion chain — show all prior turns so each model sees the full conversation
  let discussionBlock = '';
  if (priorTurns && priorTurns.length > 0) {
    const chain = priorTurns.map(t =>
      `--- ${t.modelName} (Round ${t.round}, ${t.role}) ---\n${t.content}`
    ).join('\n\n');
    discussionBlock = `\nDISCUSSION SO FAR:\n${chain}\n`;
  } else {
    discussionBlock = `\n${previousModelName.toUpperCase()}'S RESPONSE:\n${previousResponse}\n`;
  }

  return `You are participating in a multi-model validation process (Round ${roundNumber}/${totalRounds}).

IMPORTANT: Do NOT create downloadable files, artifacts, or code blocks with download buttons. Put your ENTIRE analysis directly in your response text. Everything must be readable in the chat — nothing hidden in attachments.

ORIGINAL USER PROMPT:
${originalPrompt}
${discussionBlock}${goalBlock}${directiveBlock}
Review the discussion above. Consider what has been said by all prior participants, then provide your analysis:

1. **AGREE**: What points from the discussion are correct and well-reasoned?
2. **DISAGREE**: What points are incorrect, poorly reasoned, or incomplete? Explain why.
3. **NEW INSIGHTS**: What important aspects were missed by all prior participants?
4. **RISKS**: What assumptions are dangerous or unvalidated?
5. **IMPROVED ANSWER**: Provide your own improved version of the answer, building on the strengths of the discussion while addressing the weaknesses.

Be rigorous, specific, and constructive. Do not be deferential — if a previous response is wrong, say so clearly and explain why.`;
}

export function buildRevisionPrompt(originalPrompt, modelName, originalResponse, critiques, priorTurns) {
  // Full discussion chain across ALL prior passes, so the starter model sees
  // the entire cross-model history when revising (not just the current pass's
  // critiques). Without this, pass 3+ "resets" because each LLM is on a
  // separate thread and never received the earlier-pass critiques inline.
  let discussionBlock;
  if (priorTurns && priorTurns.length > 0) {
    const chain = priorTurns.map(t =>
      `--- ${t.modelName} (Round ${t.round}, ${t.role}) ---\n${t.content}`
    ).join('\n\n');
    discussionBlock = `FULL DISCUSSION SO FAR (all prior passes):\n${chain}`;
  } else {
    // Back-compat path if caller doesn't supply turns
    const critiqueText = critiques.map(c =>
      `--- ${c.modelName}'s Critique ---\n${c.content}`
    ).join('\n\n');
    discussionBlock = `YOUR ORIGINAL RESPONSE:\n${originalResponse}\n\nCRITIQUES FROM OTHER MODELS:\n${critiqueText}`;
  }

  return `You are ${modelName}. You previously provided a response to a prompt, and other AI models have critiqued your answer across multiple passes.

IMPORTANT: Do NOT create downloadable files, artifacts, or code blocks with download buttons. Put your ENTIRE response directly in the chat text.

ORIGINAL PROMPT:
${originalPrompt}

${discussionBlock}

Please revise your response based on the FULL discussion above (across all prior passes). You may:
- Accept valid criticisms and incorporate them
- Defend parts of your original answer if the critiques are wrong (explain why)
- Add new insights prompted by the discussion

Provide your revised, improved answer that takes into account everything every model has said across all prior passes — not just the most recent pass.`;
}

export function buildSynthesisPrompt(originalPrompt, allTurns) {
  const discussion = allTurns.map((t, i) =>
    `--- ${t.modelName} (${t.role}, Round ${t.round}) ---\n${t.content}`
  ).join('\n\n');

  return `You are synthesizing a multi-model discussion into a final answer.

IMPORTANT: Do NOT create downloadable files, artifacts, or code blocks with download buttons. Put your ENTIRE synthesis directly in the chat text.

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
