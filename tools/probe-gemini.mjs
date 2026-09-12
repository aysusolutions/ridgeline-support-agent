// Newer Gemini models spend part of the output budget on internal reasoning. If the cap
// is too low the whole budget goes to thinking and the reply comes back EMPTY with
// finishReason MAX_TOKENS — a silent failure that looks exactly like a bad prompt.
// This finds the floor for each job's cap.
import { readFile } from 'node:fs/promises'
import { models } from '../src/config/models.js'

const env = Object.fromEntries((await readFile(new URL('../.env.local', import.meta.url), 'utf8'))
  .split(/\r?\n/).map(l => /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(l)).filter(Boolean)
  .map(m => [m[1], m[2].trim()]))

const call = async (maxOutputTokens) => {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${models.fallback.id}:generateContent`
  const r = await fetch(`${url}?key=${env.GEMINI_API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: 'Return ONLY JSON: {"route":"<label>","reason":"<six words>","remember":{}}' }] },
      contents: [{ role: 'user', parts: [{ text: '{"message":"hi there"}' }] }],
      generationConfig: { maxOutputTokens, temperature: 0 },
    }),
  })
  const j = await r.json()
  const c = j.candidates?.[0]
  return {
    cap: maxOutputTokens,
    finish: c?.finishReason ?? '?',
    thinking: j.usageMetadata?.thoughtsTokenCount ?? 0,
    output: j.usageMetadata?.candidatesTokenCount ?? 0,
    text: (c?.content?.parts?.[0]?.text ?? '').trim().slice(0, 70),
  }
}

console.log(`model: ${models.fallback.id}\n`)
for (const cap of [80, 150, 300, 600, 1200]) {
  const r = await call(cap)
  console.log(
    `cap=${String(r.cap).padStart(4)}  finish=${r.finish.padEnd(12)}` +
    `thinking=${String(r.thinking).padStart(4)}  out=${String(r.output).padStart(4)}  ` +
    `text=${JSON.stringify(r.text)}`)
}
