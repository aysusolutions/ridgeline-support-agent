// Why did a message end up where it did? Prints the deterministic classifier's view and
// whether the router ever gets consulted.
//
//   node tools/diag-classify.mjs "why should i buy from here"
import { classify, TIERS, INTENTS } from '../src/planner/intents.js'
import { score } from '../src/planner/fuzzy.js'

const READ_ONLY = ['faq', 'recommend', 'compare']

export function explain (q) {
  const c = classify(q)
  const all = []
  for (const i of INTENTS) for (const u of i.utterances) all.push({ intent: i.name, u, s: score(q, u) })
  all.sort((a, b) => b.s - a.s)

  const reachesRouter = c.confidence < TIERS.DISAMBIGUATE
  const skipsDisambiguation = READ_ONLY.includes(c.intent)
  return { c, top: all.slice(0, 4), reachesRouter, skipsDisambiguation }
}

const queries = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['why should i buy from here']

for (const q of queries) {
  const { c, top, reachesRouter, skipsDisambiguation } = explain(q)
  console.log(`\nquery: "${q}"`)
  console.log(`  classify → ${c.intent} @ ${c.confidence.toFixed(3)}   (act ${TIERS.ACT}, disambiguate ${TIERS.DISAMBIGUATE})`)
  console.log('  top utterance matches:')
  for (const m of top) console.log(`    ${m.s.toFixed(3)}  ${m.intent.padEnd(14)} "${m.u}"`)
  console.log(`  reaches the router?        ${reachesRouter}`)
  console.log(`  read-only, so no disambig? ${skipsDisambiguation}`)
  console.log(`  → ${reachesRouter ? 'router decides' : `straight to '${c.intent}' with no second opinion`}`)
}
