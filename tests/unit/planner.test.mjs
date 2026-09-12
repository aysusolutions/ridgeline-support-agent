import { test, assert } from '../harness.mjs'
import { classify, TIERS, INTENTS } from '../../src/planner/intents.js'
import { score } from '../../src/planner/fuzzy.js'
import { planFor } from '../../src/planner/deterministic.js'
import { isHarmFramed, declineFor } from '../../src/planner/scope.js'
import { createDb } from '../../src/backend/db.js'
import { createSession } from '../../src/kernel/kernel.js'
import { verifyOwnership } from '../../src/kernel/capabilities.js'
import { parsePlan } from '../../src/kernel/plan.js'
import { TOOLS } from '../../src/kernel/tools.js'
import { brand } from '../../src/config/brand.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')

test('a clear tracking utterance classifies above the act threshold', () => {
  const r = classify('where is my order')
  assert.eq(r.intent, 'track_order', 'intent')
  assert.ok(r.confidence >= TIERS.ACT, `act tier, got ${r.confidence}`)
})

test('a clear cancel utterance classifies as cancel and clears the act threshold', () => {
  const r = classify('please cancel my order')
  assert.eq(r.intent, 'cancel_order', 'cancel')
  assert.ok(r.confidence >= TIERS.ACT, `act tier, got ${r.confidence}`)
})

test('a policy question routes to faq, not to start_return', () => {
  assert.eq(classify('what is your return policy').intent, 'faq', 'faq')
})

test('an ambiguous utterance lands in the disambiguate band', () => {
  const r = classify('my tent')
  assert.ok(r.confidence < TIERS.ACT, `below act, got ${r.confidence}`)
})

test('gibberish lands below the disambiguate threshold', () => {
  assert.ok(classify('asdkjhasd qwe zzz').confidence < TIERS.DISAMBIGUATE, 'fallback tier')
})

test('a free-text product need scores below disambiguate so the rescue path can fire', () => {
  assert.ok(classify('something flowy for a beach wedding').confidence < TIERS.DISAMBIGUATE,
    'falls through to interpret_need')
})

test('planFor asks for the missing slot instead of guessing', () => {
  const s = createSession('s1', () => NOW)
  assert.eq(planFor('cancel_order', s, {}).ask, 'orderId', 'asks for the order number first')
})

test('planFor emits a valid Plan once slots are filled and the grant exists', () => {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, 'RO-10850', 'dana.reyes@example.com', NOW).grant)
  s.entitySet.add('RO-10850')
  const out = planFor('cancel_order', s, { orderId: 'RO-10850' })
  const parsed = parsePlan(out.plan, {
    tools: TOOLS, entitySet: s.entitySet, capabilityNames: s.grants.names(), trusted: true,
  })
  assert.eq(parsed.steps[0].tool, 'cancel_order', 'valid plan')
})

test('a verified grant satisfies the identity slots so the agent stops re-asking', () => {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, 'RO-10482', 'lee.tanaka@example.com', NOW).grant)
  assert.ok(planFor('track_order', s, {}).plan, 'goes straight to the plan')
})

test('every intent produces a plan, an ask, or chips — never nothing', () => {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, 'RO-10390', 'mira.velasco@example.com', NOW).grant)
  for (const intent of INTENTS) {
    const out = planFor(intent.name, s, { lineItemId: 'L1', reason: 'defective',
      address: {}, newDate: '2026-08-06' })
    assert.ok(out.plan || out.ask || out.chips, `${intent.name} yields something actionable`)
  }
})

test('an unknown intent falls back to the capability chips', () => {
  const s = createSession('s1', () => NOW)
  assert.eq(planFor('nonsense', s, {}).chips, brand.chips, 'chips')
})

test('every deterministic plan parses against the real tool registry', () => {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, 'RO-10390', 'mira.velasco@example.com', NOW).grant)
  s.entitySet.add('L1')
  const filled = { lineItemId: 'L1', reason: 'defective', newDate: '2026-08-06',
    address: { name: 'D', city: 'Golden', region: 'CO', postal: '80401', country: 'US' },
    filters: {}, weights: {}, skus: [], query: 'returns' }
  for (const intent of INTENTS) {
    const out = planFor(intent.name, s, filled)
    if (!out.plan) continue
    parsePlan(out.plan, {
      tools: TOOLS, entitySet: s.entitySet, capabilityNames: s.grants.names(), trusted: true,
    })
  }
})

test('an LLM plan cannot smuggle a value inside an object literal', () => {
  const db = createDb()
  const s = createSession('s1', () => NOW)
  s.grants.mint(verifyOwnership(db, 'RO-10390', 'mira.velasco@example.com', NOW).grant)
  const smuggled = { steps: [{ id: 's1', tool: 'search_products',
    args: { filters: { lit: { category: 'tents' } } } }] }
  // Trusted (code-authored) is fine...
  parsePlan(smuggled, { tools: TOOLS, entitySet: s.entitySet,
    capabilityNames: s.grants.names(), trusted: true })
  // ...untrusted (model-authored) is not.
  assert.throwsWith(
    () => parsePlan(smuggled, { tools: TOOLS, entitySet: s.entitySet,
      capabilityNames: s.grants.names() }),
    Error, 'may not be an object')
})

test('a pending slot wins over a fresh intent classification', () => {
  const s = createSession('s1', () => NOW)
  s.pending = { intent: 'cancel_order', ask: 'orderId' }
  const out = planFor(null, s, {}, { rawText: '10850', knownOrderIds: ['RO-10850'] })
  assert.eq(out.filled, 'orderId', 'slot filled, not reclassified')
  assert.eq(out.value, 'RO-10850', 'normalised')
})

test('a pending slot that cannot be filled falls through to a digression', () => {
  const s = createSession('s1', () => NOW)
  s.pending = { intent: 'cancel_order', ask: 'orderId' }
  const out = planFor(null, s, {}, { rawText: 'what is your return policy', knownOrderIds: [] })
  assert.eq(out.filled, undefined, 'not treated as a slot value')
})

test('a reason chip maps to the policy enum, not to free text', () => {
  const s = createSession('s1', () => NOW)
  s.pending = { intent: 'start_return', ask: 'reason' }
  const out = planFor(null, s, {}, { rawText: 'Changed my mind' })
  assert.eq(out.value, 'changedMind', 'mapped to the enum the tool accepts')
})

/* ------------------------------------------------------------- the scope fence */

test('harm framing fires on questions that DO match the catalogue', () => {
  for (const p of ['will this bag keep me alive at minus 20',
                   'is this jacket safe for -30c',
                   'is the stream water safe to drink with this filter',
                   'what do i do in an avalanche']) {
    assert.eq(isHarmFramed(p), true, `harm framed: ${p}`)
  }
})

test('ordinary product questions are not harm framed', () => {
  for (const p of ['which bag is warmer', 'what is this rated to',
                   'is this jacket waterproof', 'how light is the ultra tent',
                   'where is my order', 'i want to return this']) {
    assert.eq(isHarmFramed(p), false, `not harm framed: ${p}`)
  }
})

test('declineFor offers products when something partially matched', () => {
  const r = declineFor({ category: 'packs' }, brand.chips)
  assert.eq(r.reply, brand.voice.decline.withOffer, 'offer copy')
  assert.eq(r.pivot, { category: 'packs' }, 'pivot carried')
})

test('declineFor falls back to chips when nothing matched', () => {
  const r = declineFor(null, brand.chips)
  assert.eq(r.reply, brand.voice.decline.bare, 'bare copy')
  assert.eq(r.chips, brand.chips, 'chips offered')
})

test('no decline template hedges or apologises for being software', () => {
  for (const [key, copy] of Object.entries(brand.voice.decline)) {
    assert.ok(copy.length > 0, `${key} has copy`)
    assert.eq(/as an ai|language model|i am just|i'm just a|unable to/i.test(copy), false,
      `${key} does not hedge`)
  }
})

test('no decline template names a forbidden topic category', () => {
  for (const [key, copy] of Object.entries(brand.voice.decline)) {
    assert.eq(/doctor|medical|physio|legal|lawyer|financial|tax/i.test(copy), false,
      `${key} does not name a category, so the fence is not an oracle`)
  }
})

/* ------------------------------------------- evidence, not just ratio */

test('a single shared word never clears the disambiguate threshold', () => {
  // "buy it for me" and "what should i buy" both reduce to {buy}. Dice scores that a
  // perfect 1.0, which sent a purchase request into product search with full confidence
  // and no second opinion. One word is not evidence.
  assert.ok(score('buy it for me', 'what should i buy') <= 0.44, 'capped')
  assert.ok(score('why should i buy from here', 'what should i buy') <= 0.44, 'capped')
  assert.ok(classify('buy it for me').confidence < TIERS.DISAMBIGUATE, 'reaches the router')
  assert.ok(classify('why should i buy from here').confidence < TIERS.DISAMBIGUATE, 'reaches the router')
})

test('two or more corroborating words are scored exactly as before', () => {
  assert.eq(score('where is my order', 'where is my order'), 1, 'unchanged')
  assert.eq(score('please cancel my order', 'cancel my order'), 1, 'unchanged')
  assert.eq(score('i want to return this', 'i want to return this'), 1, 'unchanged')
})

test('want and need are content words here, not filler', () => {
  // Stopping them left "i want to return this" with one token, which the cap then
  // rightly distrusted — a correct rule tripping over a wrong vocabulary.
  assert.ok(classify('i want to return this').confidence >= TIERS.ACT, 'acts directly')
  assert.ok(classify('i need to cancel my order').confidence >= TIERS.DISAMBIGUATE, 'recognised')
})

test('every intent that can ACT still clears the act threshold on its own utterances', () => {
  for (const intent of INTENTS) {
    for (const u of intent.utterances) {
      const c = classify(u)
      assert.ok(c.confidence >= TIERS.ACT,
        `"${u}" should act directly, got ${c.intent} @ ${c.confidence.toFixed(2)}`)
    }
  }
})
