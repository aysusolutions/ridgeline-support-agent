# Build Plan — E-commerce Conversational Support Agent

**Handoff document for a Claude Code session.**
Written 2026-08-01 · Owner: Ayush Bhardwaj

---

## 0. Read this first

A prior design spec exists at
`docs/superpowers/specs/2026-07-30-support-chatbot-design.md`. **Read it before starting** —
it contains the full conversation-flow design, unhappy paths, mock-data schemas and guardrail
layers, and this document does not repeat that detail.

This document supersedes the spec in four places:

| Change | Was | Now |
|---|---|---|
| LLM usage | Off by default, optional adapter | **On by default**, five defined jobs, free-tier providers |
| Hosting | GitHub Pages, static only | **Vercel** — static + one serverless function to hold the API key |
| Storefront | Chat widget on a bare page | **Fake storefront page** with the widget docked in the corner |
| `dist/standalone.html` | A deliverable | **Dropped** — a live URL makes it pointless |

Everything else in the spec stands.

---

## 1. What this is and who it's for

A customer-support conversational agent for a fictional outdoor and camping gear store,
embedded in a fake storefront, deployed to a public URL.

**Two audiences, both of which must be served by the same build:**

1. **Freelance clients** browsing a portfolio. They will click the URL, click one chip, and
   form a judgement in under 30 seconds. They are not reading the code.
2. **An Upwork Talent Accelerator reviewer**, if a pending application is accepted. The brief
   requires order tracking, returns and exchanges, product recommendations, human handoff,
   and clear conversation flows — plus a code repo and a 2–3 minute video demo.

**The design thesis that decides ties:** every claim must be verifiable by a stranger in
under 60 seconds with nothing installed and no account. When in doubt, choose the option that
makes the demo more likely to work on someone else's machine.

**Weighting: roughly 70% support agent, 30% sales agent.** Support (orders, returns, FAQ,
handoff) is the backbone because it's what the brief requires. The product recommender is the
part that makes a client *want* it, so it must be genuinely good, not a stub.

---

## 2. Non-goals

Do not build: a cart, checkout, login, product detail pages, or an admin panel — the
storefront is a facade. No admin or bot-configuration UI. No multilingual support. No voice.
No real payment or carrier integrations. No vector database. No build step, bundler or
framework unless a phase below explicitly calls for one.

---

## 3. LLM strategy

**Use free-tier LLM APIs. Groq primary, Gemini as fallback.** Both are free with no card
required.

> ⚠️ Free-tier rate limits and model names change often, and my information may be stale.
> **Verify current limits and available model IDs before writing the adapter**, and put the
> model ID in config, never inline in code.

### 3.1 Provider-agnostic adapter

```
src/ai/
  adapter.js        // interface: complete({ system, user, maxTokens, json }) -> string
  groq.js           // primary
  gemini.js         // fallback, same interface
  nullAdapter.js    // returns null; forces deterministic path. Used in tests
  firewall.js       // output validation (§3.4)
  prompts.js        // all prompt text, one file, versioned
```

`adapter.js` tries Groq, falls back to Gemini on error or rate limit, then falls back to
`nullAdapter`. **A provider swap must be a one-line config change.** Never let provider
specifics leak into `dialog/` or `ui/`.

### 3.2 The key must never reach the browser

A static site with a client-side API key is a public key. Anyone can read it and drain the
quota.

So: deploy to **Vercel** (free tier), with one serverless function.

```
api/llm.js          // POST { job, payload } -> { text }  |  key read from process.env
```

- Key lives in a Vercel environment variable. `.env.local` is gitignored.
- The function accepts only a **fixed set of job names** (`classify`, `answer_faq`,
  `reason_lines`, `naturalize`, `summarize_handoff`). It builds the prompt server-side from
  `prompts.js`. **The client never sends a prompt** — it sends a job name and structured
  payload. This alone removes most of the abuse surface.
- Best-effort per-IP rate limit in the function, plus a hard `max_tokens` cap per job.
- Reject payloads over a size cap.

Because the free tiers don't bill, worst-case abuse exhausts quota rather than costing money —
and §3.5 means quota exhaustion degrades the demo instead of breaking it. If stricter limiting
is wanted later, add Upstash Redis (free tier) for a shared counter; don't block on it now.

### 3.3 The five jobs the LLM is allowed to do

The LLM is **never an actor**. No tools, no function calling, no data access, no ability to
mutate session state. The deterministic engine owns every decision. Each job below takes
structured input and returns constrained output that is validated before use.

| Job | Input | Output | Validation |
|---|---|---|---|
| `classify` | User utterance + the closed list of intent names | JSON `{ intent, confidence }` | Intent **must** be in the known list, else discard and use the deterministic classifier's result |
| `answer_faq` | Question + top-k FAQ entries retrieved by the existing fuzzy scorer | Answer + the FAQ id(s) it used | Must cite at least one supplied id; if it cites none, **discard** and return the top FAQ answer verbatim |
| `reason_lines` | Product attributes as JSON + the user's stated needs | One sentence per recommended product | Every number in the output must appear in the input attributes |
| `naturalize` | A reply the engine has **already chosen** | A rephrasing | Firewall (§3.4) |
| `summarize_handoff` | The transcript, PII already masked | A short summary for the handoff packet | Length cap; masked input only |

`classify` is called **only when the deterministic classifier lands in the ambiguous band**
(0.45–0.75). Above and below, the deterministic path runs alone. This keeps token spend low
and keeps the happy path fast.

**Deliberately not LLM jobs:** deciding refund eligibility, computing amounts or dates,
deciding whether to escalate, or writing policy text. Those are code, reading
`policies.json`. The bot must be structurally incapable of being talked into an exception.

### 3.4 The semantic firewall

`firewall.js` diffs any generated text against the deterministic original. If the generation
introduces a **number, price, date, order ID, URL, or policy claim** not present in the
source, discard the generation and ship the deterministic text.

The model may rephrase. It can never introduce a fact. Hallucinated policies become
structurally impossible rather than merely unlikely.

Log every firewall rejection as an event — see §3.6.

### 3.5 Graceful degradation is a hard requirement

If the key is missing, the quota is exhausted, the network fails, or the response is malformed:
**the deterministic engine answers instead, and the user sees a normal reply.** No error
bubble, no "AI unavailable", no dead demo.

Test this explicitly: `nullAdapter` must produce a complete, sensible conversation for every
flow. If a flow only works with the LLM on, the seam has leaked.

### 3.6 Prompt injection, now that a model is in the loop

The spec's guardrail layers still apply. The two that matter most here:

- **Input normalization before matching** — Unicode NFKC, strip zero-width and bidi/RLO
  characters, homoglyph folding, length cap, then injection heuristics.
- **Untrusted-content fencing** — user text wrapped in delimiters carrying a random
  per-session nonce, with the nonce stripped from user input first so the fence can't be
  forged. System preamble states fenced content is data, never instruction.

But state the architectural argument first in the docs, because it's the stronger one:
**injected instructions have no lever to pull.** Refunds, escalation and policy live behind
the state machine, and the model cannot reach the state machine. Its output is either an
enum, text that passes the firewall, or discarded.

### 3.7 Build a visible debug panel — this is a demo asset

A toggleable panel showing, per turn: deterministic intent + score, whether the LLM was
called and for which job, the raw generation, and whether the firewall accepted or rejected it.

This is worth building deliberately. Pasting an injection payload and letting the audience
*watch* the firewall reject the output is the single most persuasive thing in the demo video,
and it demonstrates evaluation and guardrail work rather than asserting it.

---

## 4. Architecture

Zero runtime dependencies in `src/`. No bundler, no framework. ES modules loaded directly.
The only server-side code is `api/llm.js`.

```
index.html                  storefront page + widget mount + CSP meta
styles/
  tokens.css                design tokens: brand, type scale, spacing, light/dark
  storefront.css
  chat.css
src/
  main.js                   wiring only, no logic
  config/
    brand.js                name, tagline, voice strings, business hours + timezone, SLAs
    models.js               provider + model IDs + per-job max_tokens
  nlu/
    intents.js  classify.js  entities.js  fuzzy.js  sanitize.js
  dialog/
    engine.js  session.js
    flows/  orderTracking.js  returns.js  recommend.js  faq.js  handoff.js
  data/
    store.js                async facade: getOrder, findProducts, getPolicy, findFaq
    orders.json  products.json  policies.json  faqs.json
  ai/
    adapter.js  groq.js  gemini.js  nullAdapter.js  firewall.js  prompts.js
  ui/
    storefront.js           renders the product grid from products.json
    widget.js               messages, chips, cards, typing indicator
    render.js               safe text rendering, markdown-lite, link scheme checks
    a11y.js                 live regions, focus management
    analytics.js  debugPanel.js
  telemetry/events.js
api/
  llm.js                    serverless proxy, holds the key
tests/
  conversations/*.json      turn-by-turn expectations
  adversarial/*.json        scripted attacks
  run.mjs                   zero-dep runner; also generates the test-transcript docs
```

**The rule that makes this testable, unchanged from the spec:** the dialog engine never
touches the DOM, and the UI never holds business logic. Every flow is a pure function
`(session, nlu, store, ai) => ({ reply, chips, cards, nextState, events })`, where `ai` is
injectable and defaults to `nullAdapter` under test.

**Turn pipeline:**

```
raw text
  -> sanitize (normalize, strip, cap, rate limit) -> injection screen
  -> extract entities -> deterministic classify
  -> if ambiguous band: LLM classify, validated against the intent list
  -> engine routes  [an active flow's pending slot WINS over a new intent]
  -> flow queries store (async, API-shaped)
  -> optional LLM job (faq / reason_lines / naturalize) -> firewall
  -> output guardrails (PII mask, no-promise filter)
  -> UI renders via textContent / allowlist + screen reader announces
  -> telemetry + debug panel record
```

The slot-priority rule carries more weight than it looks. When a flow awaits an order number,
`"1234"` must fill that slot rather than being re-classified as a fresh intent. Getting this
wrong is the most common reason demo bots feel broken.

---

## 5. The storefront page

A facade, not a store. Roughly 2 hours.

- Header: brand name, wordmark, dummy nav
- Hero strip with a headline and one background image
- **Product grid of 8–12 cards read from `products.json`** — the same file the recommender
  scores on. One data source, two consumers, so a product the bot mentions is visibly on the
  page behind the chat window, with matching price and stock. This coherence is what makes it
  read as real.
- Footer
- Chat bubble docked bottom-right, **closed by default**, opening into the widget

**The opening message must not be a blank invitation.** Open with four chips — *Track my
order · Start a return · Help me choose a tent · Talk to a human* — so a visitor clicks and
sees the thing work in two seconds instead of wondering what to type.

Photos: free outdoor-gear images from Unsplash or Pexels, filenames matching SKUs, committed
to the repo. Compress them; page weight is a first-impression cost.

Brand: pick a plausible name, a wordmark, and a two-colour palette. Confine every brand
string to `config/brand.js`. An unbranded demo reads as a school project.

---

## 6. Build order

Phases are sequenced so that **there is a working, demoable artifact from Phase 4 onward**.
Do not start a later phase until the earlier one is genuinely done.

| Phase | Work | Hours |
|---|---|---|
| 0 | Repo scaffold, tokens, `brand.js`, empty data files, `tests/run.mjs` skeleton | 1.0 |
| 1 | NLU (entities, fuzzy, classify, sanitize) + engine + session, **headless, tested** | 2.5 |
| 2 | Author mock data: 12 orders, 24 products, policies, ~30 FAQs — per the spec's tables | 1.5 |
| 3 | The five flows with all unhappy paths, tested headlessly with `nullAdapter` | 3.5 |
| 4 | Storefront page + chat widget, cards, chips, a11y, light/dark, responsive | 3.0 |
| 5 | **Deploy to Vercel now**, while the surface is small and problems are cheap to find | 0.5 |
| 6 | `api/llm.js` + adapter + Groq + Gemini fallback + firewall + the five jobs | 3.0 |
| 7 | Handoff packet, out-of-hours branch, CSAT, analytics panel, debug panel | 2.0 |
| 8 | Adversarial suite (~30 attacks), `SECURITY.md`, generated test-transcript docs | 2.5 |
| 9 | README with screenshots, Mermaid flow diagrams, portability doc, CI on GitHub Actions | 1.5 |
| 10 | Second brand skin from the same codebase — config + data swap only | 0.5 |
| | **Total** | **21.5** |

**Deploy at Phase 5, not at the end.** Deployment problems found against a small surface cost
minutes; found at the end they cost the deadline.

**Phase 10 is deliberately cheap and worth doing.** A second live demo — say a coffee
subscription store — produced from the same code by swapping `brand.js` and the JSON says
"reusable system" far louder than any builder UI would, for half an hour of work.

**If time runs short, cut in this order:** Phase 10, then the analytics panel, then the
portability doc. **Never cut** the five flows, the deterministic fallback path, or the docs.
A hardened bot with a broken returns flow scores worse than the reverse.

---

## 7. Definition of done

The build is finished when all of these are true:

- [ ] A stranger can open the live URL, click one chip, and get a useful answer in under 10 seconds
- [ ] `node tests/run.mjs` passes with `nullAdapter` — **every flow completes with no LLM at all**
- [ ] With the LLM on, no reply ever contains a number, date, price or policy claim absent from `orders.json` / `products.json` / `policies.json`
- [ ] Removing the environment variable degrades silently; the user-visible experience stays coherent
- [ ] The adversarial suite passes: no leak, no state change, calm response, event logged
- [ ] An order-number typo produces a "did you mean" recovery, not a dead end
- [ ] An out-of-window return quotes **computed** dates, not pasted policy text
- [ ] A policy question mid-order-lookup is answered, then the bot resumes the order
- [ ] Email mismatch and order-not-found return the **same** message
- [ ] Handoff shows the customer the structured packet, and respects business hours
- [ ] The debug panel visibly shows a firewall rejection when fed an injection payload
- [ ] Keyboard-only operation works end to end; a screen reader announces new messages
- [ ] No API key anywhere in the repo, the client bundle, or the git history
- [ ] README opens with a screenshot and the live link, above any prose

---

## 8. Failure modes to avoid

- **Letting the LLM decide anything.** If a refund, an eligibility check, an amount, a date,
  or an escalation depends on a generation, it's wrong. Those are code paths reading config.
- **A demo that only works with the key set.** The deterministic path is the product; the LLM
  is an enhancement layer.
- **Client-side API keys.** Not once, not "just for local testing" in a committed file.
- **Building the config/admin UI.** Nobody clicking the portfolio link will find it.
- **Perfecting NLU on obscure phrasings** instead of making the four core flows excellent.
- **A grey box printing plain text.** Order cards with a shipment timeline and selectable
  product cards with images are most of the perceived quality, and they're mostly CSS.
- **Committing uncompressed hero images.** Slow first paint on a portfolio link is expensive.
- **Skipping the second skin.** It's 30 minutes and it changes how the work is read.

---

## 9. After the build

Record a 2–3 minute demo video following the shot list in §9 of the design spec. Then add the
live URL, repo link and 3–4 screenshots to the Upwork, Fiverr and Freelancer portfolio
sections — the live URL is the highest-value asset produced here, because it is the only
portfolio item that demonstrates itself.
