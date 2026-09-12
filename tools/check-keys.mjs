// Verifies the keys in .env.local reach a live model, and that the IDs in
// config/models.js still exist. Prints shapes and outcomes only — never a key value.
//
//   node tools/check-keys.mjs
import { readFile } from 'node:fs/promises'
import { models } from '../src/config/models.js'

const ROOT = new URL('../', import.meta.url)

function parseEnv (text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m || line.trim().startsWith('#')) continue
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
  }
  return out
}

const shape = (k) => {
  if (!k) return 'missing'
  if (k.length < 12) return `too short (${k.length} chars)`
  return `${k.length} chars, starts "${k.slice(0, 4)}…"`
}

let env = {}
try {
  env = parseEnv(await readFile(new URL('.env.local', ROOT), 'utf8'))
  console.log('.env.local  found')
} catch {
  console.log('.env.local  NOT FOUND at project root')
  process.exit(1)
}

console.log(`GROQ_API_KEY    ${shape(env.GROQ_API_KEY)}`)
console.log(`GEMINI_API_KEY  ${shape(env.GEMINI_API_KEY)}`)
console.log('')

async function checkGroq (key) {
  if (!key) return 'skipped — no key'
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: models.primary.id, max_tokens: 8, temperature: 0,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    }),
  })
  if (!r.ok) return `HTTP ${r.status} — ${(await r.text()).slice(0, 160)}`
  return `ok — replied "${(await r.json()).choices[0].message.content.trim()}"`
}

async function checkGemini (key) {
  if (!key) return 'skipped — no key'
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${models.fallback.id}:generateContent`
  const r = await fetch(`${url}?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 8, temperature: 0 },
    }),
  })
  if (!r.ok) return `HTTP ${r.status} — ${(await r.text()).slice(0, 160)}`
  const j = await r.json()
  return `ok — replied "${(j.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim()}"`
}

console.log(`groq   ${models.primary.id}`)
console.log(`       ${await checkGroq(env.GROQ_API_KEY)}`)
console.log('')
console.log(`gemini ${models.fallback.id}`)
console.log(`       ${await checkGemini(env.GEMINI_API_KEY)}`)
