// Model IDs and free-tier limits change often. Never inline a model ID anywhere else.
//
// Verified against live keys on 2026-08-02 by `node tools/check-keys.mjs`:
//
//   groq/llama-3.3-70b-versatile — live on the free plan.
//     30 req/min · 1,000 req/day · 12K tokens/min · 100K TOKENS PER DAY.
//     The daily token cap is the one that bites. See `budget` below.
//
//   gemini-3.5-flash — current generation, works on a new key.
//     gemini-2.0-flash was shut down 2026-06-01.
//     gemini-2.5-flash is still LISTED by the models endpoint but returns 404 for keys
//     created after that date: "no longer available to new users". Listed does not mean
//     usable — always call it, never trust the catalogue.
//
//   gemini-embedding-001 — Phase 2. text-embedding-004 is gone, 404 on this key.
export const models = {
  // llama-3.3-70b-versatile was retired out from under us — the endpoint began returning
  // 404 model_not_found, which the adapter latched as "no endpoint" while the Gemini
  // fallback quietly carried every turn. Groq's current lineup is all reasoning models,
  // hence reasoning_effort below: without it the whole output budget goes to thinking and
  // the reply comes back empty, exactly like Gemini did before thinkingBudget: 0.
  // Roles swapped. Gemini can be told to do NO reasoning (thinkingBudget: 0) and then
  // answers these jobs in ~20 output tokens, which is what the token caps below are sized
  // for. Groq's current lineup is reasoning-only — even at reasoning_effort "low" it wants
  // a few hundred output tokens to think before writing, so it is the fallback and gets a
  // bigger allowance rather than the default caps.
  primary: { provider: 'gemini', id: 'gemini-3.5-flash' },
  fallback: { provider: 'groq', id: 'openai/gpt-oss-120b', reasoningEffort: 'low', capFloor: 700 },
  embedding: { provider: 'gemini', id: 'gemini-embedding-001', dims: 256 },
  // OUTPUT caps, per job. Groq's free tier is 100,000 tokens PER DAY — not per minute —
  // and this agent makes two or three calls a turn. Left uncapped, `route` and
  // `converse` defaulted to 250 each and burned the daily budget in an afternoon of
  // testing. A route reply is twenty tokens; there is no reason to reserve 250.
  // What to do when the language-agnostic checker cannot be reached.
  //
  // failClosed: unverified prose does not ship — the deterministic template goes out
  // instead. Safest, and the cost is real: a conversational turn now needs TWO successful
  // calls, so on a flaky free tier you will see more canned replies.
  //
  // Set false to fall back to the English regex verdict alone. That is today's behaviour
  // and today's hole: an action claim in another language would ship unchecked. Only worth
  // it if the flat replies hurt more than that risk.
  verification: { failClosed: true },

  maxTokens: {
    route: 80,
    // Three booleans. It needs room to read the reply, not to write.
    verify: 30,
    converse: 120,
    extract: 60,
    interpret_need: 200,
    plan: 400,
    compose: 220,
    answer_faq: 220,
    reason_lines: 200,
    compare: 240,
    summarize_handoff: 160,
  },

  // Deadlines. Every other failure mode degrades — a 404 latches, a 429 latches, junk
  // output is discarded, and all of them land on the deterministic path. A HANG does not
  // degrade: the socket is open, nothing errors, and the promise never settles. Without a
  // clock somewhere the typing dots spin until the tab is closed.
  //
  // The three budgets nest: one provider < one server request < one client turn.
  timeouts: {
    providerMs: 5_000,     // one provider attempt — leaves room for the fallback to run
    serverMs: 9_000,       // both providers together, under the platform's function limit
    clientMs: 14_000,      // one adapter run, retry included
    turnMs: 20_000,        // last resort in the UI, so the input always comes back
  },

  // Roughly what one turn costs, for capacity planning. Input dominates: the prompts
  // are long, the replies are short.
  budget: {
    freeTierTokensPerDay: 100_000,
    approxTokensPerTurn: 2_200,
    approxTurnsPerDay: 45,
  },
}
