// Sweeps realistic phrasings to find messages the deterministic classifier grabs on
// weak evidence, bypassing the router. Run before and after changing the scorer.
import { classify, TIERS, INTENTS } from '../src/planner/intents.js'
import { score, normalize } from '../src/planner/fuzzy.js'

const READ_ONLY = new Set(['faq', 'recommend', 'compare'])

const CORPUS = [
  // about the shop — should reach the router, not the catalogue
  ['why should i buy from here', 'question'],
  ['what makes you different', 'question'],
  ['are you any good', 'question'],
  ['why buy from ridgeline', 'question'],
  ['is this shop legit', 'question'],
  ['can i trust you', 'question'],
  ['who owns this company', 'question'],
  // committing
  ['ok give me 2 aspen 2p tent', 'purchase'],
  ['i will take the aspen', 'purchase'],
  ['add two to my basket', 'purchase'],
  ['buy it for me', 'purchase'],
  // conversational
  ['hi', 'greeting'], ['yo yo yo whats good', 'greeting'],
  ['who are u', 'identity'], ['what do u do', 'capabilities'],
  ['cheers mate', 'thanks'], ['right im off', 'closing'],
  // genuinely product
  ['help me choose a tent', 'recommend'],
  ['what sleeping bag should i get', 'recommend'],
  ['i need a pack for backpacking', 'recommend'],
  ['something lightweight for a cold night', 'recommend'],
  // genuinely support
  ['where is my order', 'track_order'],
  ['please cancel my order', 'cancel_order'],
  ['i want to return this', 'start_return'],
  ['my package never arrived', 'report_missing'],
  // genuinely policy
  ['what is your return policy', 'faq'],
  ['how much is shipping', 'faq'],
  ['what does the warranty cover', 'faq'],
]

let grabbedWeakly = 0
const rows = []

for (const [q, want] of CORPUS) {
  const c = classify(q)
  const tokens = new Set(normalize(q).split(' '))
  // How many content tokens actually corroborated the winning utterance?
  const winner = INTENTS.find(i => i.name === c.intent)
  let bestHit = 0
  for (const u of winner?.utterances ?? []) {
    if (score(q, u) !== c.confidence) continue
    const ut = new Set(normalize(u).split(' '))
    bestHit = Math.max(bestHit, [...tokens].filter(t => ut.has(t) && t.length > 2).length)
  }
  const reachesRouter = c.confidence < TIERS.DISAMBIGUATE
  const readOnly = READ_ONLY.has(c.intent)
  const noSecondOpinion = !reachesRouter && (readOnly || c.confidence >= TIERS.ACT)
  const weak = noSecondOpinion && c.confidence < TIERS.ACT
  if (weak) grabbedWeakly++
  rows.push({ q, want, got: c.intent, conf: c.confidence.toFixed(2), reachesRouter, weak })
}

console.log('query'.padEnd(42), 'want'.padEnd(14), 'got'.padEnd(14), 'conf', ' router?', ' weak-grab?')
console.log('-'.repeat(100))
for (const r of rows) {
  console.log(
    r.q.padEnd(42), r.want.padEnd(14), r.got.padEnd(14), r.conf.padStart(4),
    String(r.reachesRouter).padStart(7), r.weak ? '   ← GRABBED' : '')
}
console.log(`\n${grabbedWeakly} of ${CORPUS.length} grabbed below the act threshold with no second opinion`)
