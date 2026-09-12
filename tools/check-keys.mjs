// Verifies the keys in .env.local reach a live model, and that the IDs in
// config/models.js still exist. Prints shapes and outcomes only — never a key value.
//
//   node tools/check-keys.mjs
import { readFile } from 'node:fs/promises'
import { models } from '../src/config/models.js'
import { callOne, keyNameFor } from './providers.mjs'

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

// Probe each CONFIGURED entry against its own provider. Reading the provider off the
// entry, rather than assuming primary means Groq, is what keeps this honest when the
// roles are swapped in config.
async function probe (cfg, env) {
  const keyName = keyNameFor(cfg.provider)
  if (!env[keyName]) return `skipped — no ${keyName}`
  try {
    const text = await callOne(cfg, {
      system: 'Reply with the single word: ok',
      user: 'ok',
      maxTokens: 8,
      env,
    })
    return `ok — replied "${text.trim()}"`
  } catch (e) {
    return e.message
  }
}

for (const [role, cfg] of [['primary', models.primary], ['fallback', models.fallback]]) {
  console.log(`${role.padEnd(8)} ${cfg.provider} ${cfg.id}`)
  console.log(`         ${await probe(cfg, env)}`)
  console.log('')
}
