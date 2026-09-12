// Shared provider calls for the dev tools.
//
// This exists because check-keys.mjs and demo-live.mjs each hardcoded Groq's endpoint
// against `models.primary.id`. That was correct until the roles were swapped in config
// and primary became Gemini — after which both tools sent a Gemini model id to Groq and
// reported HTTP 404 model_not_found, making a healthy agent look broken.
//
// api/llm.js already dispatches BY cfg.provider for exactly this reason. The tools now
// do the same, so role is config's to decide and nothing here has an opinion about it.
//
// Deliberately mirrors api/llm.js rather than importing it: that file is a Vercel
// handler reading process.env, and these tools read .env.local. Keep them in step.

async function callGroq ({ system, user, maxTokens, cfg, key }) {
  if (!key) throw new Error('no groq key')
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: cfg.id,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  })
  if (!r.ok) throw new Error(`groq ${r.status} — ${(await r.text()).slice(0, 120)}`)
  const choice = (await r.json()).choices?.[0]
  const text = choice?.message?.content ?? ''
  if (choice?.finish_reason === 'length' && text.trim().length < 2) {
    throw new Error('groq truncated: reasoning consumed the output budget')
  }
  if (!text.trim()) throw new Error('groq returned nothing')
  return text
}

async function callGemini ({ system, user, maxTokens, cfg, key }) {
  if (!key) throw new Error('no gemini key')
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${cfg.id}:generateContent`
  const r = await fetch(`${url}?key=${key}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: {
        maxOutputTokens: maxTokens,
        temperature: 0.2,
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  })
  if (!r.ok) throw new Error(`gemini ${r.status} — ${(await r.text()).slice(0, 120)}`)
  const body = await r.json()
  const text = body.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text?.trim()) throw new Error('gemini returned nothing')
  return text
}

const CALL = { groq: callGroq, gemini: callGemini }
const KEY_FOR = { groq: 'GROQ_API_KEY', gemini: 'GEMINI_API_KEY' }

export function keyNameFor (provider) { return KEY_FOR[provider] }

// One attempt against one configured entry, using that entry's OWN provider.
export function callOne (cfg, { system, user, maxTokens, env }) {
  const call = CALL[cfg.provider]
  if (!call) throw new Error(`unknown provider ${cfg.provider}`)
  return call({
    system, user, cfg, key: env[KEY_FOR[cfg.provider]],
    maxTokens: Math.max(maxTokens, cfg.capFloor ?? 0),
  })
}

// Primary then fallback, by role — the same order api/llm.js uses.
export async function callChain (chain, opts) {
  const errors = []
  for (const cfg of chain) {
    try {
      return { text: await callOne(cfg, opts), used: cfg, errors }
    } catch (e) {
      errors.push(`${cfg.provider}(${cfg.id}): ${e.message}`)
    }
  }
  return { text: null, used: null, errors }
}
