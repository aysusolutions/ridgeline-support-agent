import { models } from '../src/config/models.js'
import { PROMPTS } from '../src/ai/prompts.js'

const MAX_PAYLOAD_BYTES = 8192
const RATE = { windowMs: 60_000, max: 30 }
const hits = new Map()   // ip -> { count, resetAt }. Best effort, per instance.

function rateLimited (ip, now) {
  const rec = hits.get(ip)
  if (!rec || now > rec.resetAt) {
    hits.set(ip, { count: 1, resetAt: now + RATE.windowMs })
    return false
  }
  rec.count++
  return rec.count > RATE.max
}

export default async function handler (req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' })

  const ip = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() || 'unknown'
  if (rateLimited(ip, Date.now())) return res.status(429).json({ error: 'rate' })

  const { job, payload } = req.body ?? {}

  // Allowlist first. An unknown job never reaches a provider.
  if (!Object.prototype.hasOwnProperty.call(PROMPTS, job)) {
    return res.status(400).json({ error: 'unknown job' })
  }
  if (JSON.stringify(payload ?? {}).length > MAX_PAYLOAD_BYTES) {
    return res.status(413).json({ error: 'payload too large' })
  }

  // The client sent a job name and structured data. The PROMPT is built here.
  const { system, user } = PROMPTS[job](payload ?? {})
  const maxTokens = models.maxTokens[job] ?? 250

  // A hung provider is not an error — the socket stays open and nothing ever rejects. So
  // the fallback needs a clock, not just a catch: without one, a silent Groq holds the
  // request until the platform kills it and Gemini is never tried at all.
  const deadline = Date.now() + models.timeouts.serverMs
  const budget = () => Math.max(1_000, deadline - Date.now())

  // Try primary, then fallback, BY ROLE. These used to be hardcoded groq-then-gemini,
  // with callGroq reading models.primary and callGemini reading models.fallback — so
  // swapping the roles in config would have silently kept the old order while each call
  // read the wrong model id. Role is config's to decide; this only obeys it.
  const CALL = { groq: callGroq, gemini: callGemini }
  const chain = [models.primary, models.fallback]
  const errors = []
  for (const [i, cfg] of chain.entries()) {
    const ms = i === 0 ? Math.min(models.timeouts.providerMs, budget()) : budget()
    try {
      const text = await CALL[cfg.provider]({
        system, user, cfg, ms, maxTokens: Math.max(maxTokens, cfg.capFloor ?? 0),
      })
      return res.status(200).json({ text })
    } catch (e) {
      errors.push(`${cfg.provider}(${cfg.id}): ${e.message}`)
    }
  }
  // Degrade to the client, but never silently to the operator. Swallowing these
  // made a broken prompt look identical to a missing key for an hour.
  console.error(`[llm] ${job} failed — ${errors.join(' · ')}`)
  return res.status(200).json({ text: null })
}

// AbortSignal.timeout rejects with a TimeoutError, so a hang arrives at the same catch
// as a 500 and takes the same fallback. Naming it keeps the operator log readable.
const deadlineSignal = (ms, label) => {
  const c = new AbortController()
  const id = setTimeout(() => c.abort(new Error(`${label} timed out after ${ms}ms`)), ms)
  // Do not hold the process open on a timer that has already done its job.
  if (typeof id?.unref === 'function') id.unref()
  return { signal: c.signal, done: () => clearTimeout(id) }
}

async function callGroq ({ system, user, maxTokens, ms, cfg }) {
  if (!process.env.GROQ_API_KEY) throw new Error('no groq key')
  const clock = deadlineSignal(ms, 'groq')
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    signal: clock.signal,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: cfg.id,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  }).finally(clock.done)
  if (!r.ok) throw new Error(`groq ${r.status}`)

  const choice = (await r.json()).choices?.[0]
  const text = choice?.message?.content ?? ''
  // A reasoning model that spends the whole output budget thinking returns
  // finish_reason "length" with content of `{"` — truncated JSON. Returning that as a
  // success is worse than failing: it fails validation downstream AND stops the fallback
  // from ever running, so the agent silently degrades with no error anywhere.
  if (choice?.finish_reason === 'length' && text.trim().length < 2) {
    throw new Error('groq truncated: reasoning consumed the output budget')
  }
  if (!text.trim()) throw new Error('groq returned nothing')
  return text
}

async function callGemini ({ system, user, maxTokens, ms, cfg }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('no gemini key')
  const clock = deadlineSignal(ms, 'gemini')
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.id}:generateContent`
  const r = await fetch(`${url}?key=${process.env.GEMINI_API_KEY}`, {
    method: 'POST',
    signal: clock.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        // Newer Gemini models spend the OUTPUT budget on internal reasoning first.
        // Measured on gemini-3.5-flash: ~297 thinking tokens before 18 of reply. At an
        // 80-token cap that returns `{"route":"chat` — truncated JSON that fails
        // validation, so the fallback silently never worked. None of these jobs need
        // reasoning: they classify against a closed list or rephrase given facts.
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  }).finally(clock.done)
  if (!r.ok) throw new Error(`gemini ${r.status}`)

  const body = await r.json()
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text
  // An empty reply with MAX_TOKENS means the cap was eaten before any output. Say so
  // rather than handing back an empty string that reads as a bad prompt.
  if (!text) throw new Error(`gemini empty (${body.candidates?.[0]?.finishReason ?? 'no candidate'})`)
  return text
}
