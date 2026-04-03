// ─────────────────────────────────────────────────────────────
// Agent Configuration
// ─────────────────────────────────────────────────────────────

const baseURL = "https://api.fireworks.ai/inference/v1";
const BEARER_TOKEN = "[REPLACE_WITH_YOUR_FIREWORKS_API_KEY]";
export const MODEL = "accounts/fireworks/routers/kimi-k2p5-turbo";

// AGENT
export const AGENT = "claude";
export const AGENT_MODEL_IDENTIFIER = MODEL.split("/").pop() || "kimi-k2p5-turbo";

//
export const QUEST_RELAY_URL = "https://quest-api.nara.build/";
export const RELAY_SUBMIT_TIMEOUT_MS = 22_000;
export const DELAY_WRONG_ANSWER_MS = 1_000;

export const AGENT_CONFIG = {
  baseURL,
  apiKey: BEARER_TOKEN,
  model: MODEL,
  maxIterations: 10,
  thinking: false as const,
  thinking_params: {
    "mode": "fast"
  }
} as const;

export const SYSTEM_PROMPT = `
You are a trivia quest solver for the Nara network.

Your job:
1. Read the question carefully.
2. Determine the correct answer.
3. Call the \`submit_answer\` tool with your answer.

Rules:
- For multiple choice questions (A, B, C, D), submit ONLY the letter (e.g. "D")
- For open-ended questions, submit the answer as concisely as possible
- Use correct standard English capitalization (case-sensitive)

Capitalization rules:
- Proper nouns MUST be capitalized (e.g. "Narukami Island")
- Do NOT use all lowercase if the term normally uses capitalization
- Match the most standard and commonly accepted casing of the term

Validation step (MANDATORY before submitting):
- Double-check that capitalization is correct
- Fix any incorrect casing before calling the tool

Examples:
- Correct: "Narukami Island"
- Incorrect: "narukami island"
- Correct: "Leprosy"
- Incorrect: "leprosy"
- Correct: "coffee cup"
- Incorrect: "Coffee cup"

- If your answer was wrong, you will be told. Reconsider and try a DIFFERENT answer.
- Be fast — time is limited.`;

// Max retries for errors (empty completion, etc.) on the same round
export const MAX_ROUND_RETRIES = 2;

// Polling intervals (ms)
export const POLL_AGGRESSIVE = 200; // Aggressive re-poll after deadline
export const POLL_MODERATE = 500; // Retry on fetch error
