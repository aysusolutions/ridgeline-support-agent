// Every prompt costs INPUT tokens on every call, and input dominates: the system
// prompts are long, the replies are twenty tokens. On a 100,000-token daily cap that is
// what decides how many conversations a day the free tier buys.
//
//   node tools/prompt-budget.mjs
import { PROMPTS, JOB_NAMES } from '../src/ai/prompts.js'
import { models } from '../src/config/models.js'

// ~4 chars per token is close enough for budgeting.
const tok = s => Math.ceil(String(s).length / 4)

const SAMPLE = {
  text: 'why are you showing me that again',
  recent: [{ role: 'user', said: 'help me choose a tent' }, { role: 'agent', routed: 'product' }],
  categories: ['tents', 'sleeping-bags', 'jackets', 'packs', 'boots'],
  notes: { name: 'Ayush' },
  facts: {},
  results: [],
  schema: {},
  fenced: '',
  vocabulary: {},
  entries: [],
  comparison: {},
}

const rows = JOB_NAMES.map((job) => {
  const { system, user } = PROMPTS[job](SAMPLE)
  const input = tok(system) + tok(user)
  return { job, system: tok(system), user: tok(user), input, out: models.maxTokens[job] ?? 250 }
}).sort((a, b) => b.input - a.input)

console.log('job'.padEnd(20), 'system'.padStart(7), 'user'.padStart(6), 'input'.padStart(7), 'outCap'.padStart(7))
console.log('-'.repeat(52))
for (const r of rows) {
  console.log(r.job.padEnd(20), String(r.system).padStart(7), String(r.user).padStart(6),
    String(r.input).padStart(7), String(r.out).padStart(7))
}

// A typical turn: route always, then one of converse / compose / interpret_need.
const route = rows.find(r => r.job === 'route')
const converse = rows.find(r => r.job === 'converse')
const perTurn = route.input + route.out + converse.input + converse.out
const cap = models.budget.freeTierTokensPerDay

console.log(`\ntypical turn  = route (${route.input}+${route.out}) + converse (${converse.input}+${converse.out}) = ${perTurn} tokens`)
console.log(`free tier     = ${cap.toLocaleString()} tokens/day`)
console.log(`turns per day = ~${Math.floor(cap / perTurn)}`)
