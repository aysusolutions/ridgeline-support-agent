// Calls one job against the provider and prints the RAW error. No swallowing.
import { readFile } from 'node:fs/promises'
import { PROMPTS } from '../src/ai/prompts.js'
import { models } from '../src/config/models.js'

const env = Object.fromEntries((await readFile(new URL('../.env.local', import.meta.url), 'utf8'))
  .split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean)
  .map(m => [m[1], m[2].trim()]))

const job = process.argv[2] ?? 'route'
const { system, user } = PROMPTS[job]({
  text: process.argv[3] ?? 'hi', recent: [], categories: ['boots'], facts: {}, results: [],
})
console.log(`job=${job}  systemChars=${system.length}  maxTokens=${models.maxTokens[job] ?? 250}`)

const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${env.GROQ_API_KEY}` },
  body: JSON.stringify({
    model: models.primary.id, max_tokens: models.maxTokens[job] ?? 250, temperature: 0.2,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  }),
})
console.log(`HTTP ${r.status}`)
console.log((await r.text()).slice(0, 600))
