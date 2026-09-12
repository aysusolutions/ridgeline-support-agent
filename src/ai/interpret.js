// SOFT fail by design.
//
// The Plan AST hard-fails on a bad value because a bad plan could ACT. A bad filter
// cannot act — it can only return the wrong shirts. Dropping one unrecognised field and
// searching anyway beats the dead end that rejecting the whole thing would produce, and
// avoiding that dead end is the entire point of spec §7.1.
export function validateAgainstVocabulary (parsed, vocab) {
  const filters = {}
  const dropped = []
  const raw = parsed?.filters

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { filters, dropped, weights: {}, rationale: '' }
  }

  for (const [key, value] of Object.entries(raw)) {
    if (key === 'maxPriceCents' || key === 'minPriceCents') {
      const n = Number(value)
      if (!Number.isFinite(n)) { dropped.push(key); continue }
      filters[key] = Math.min(Math.max(n, vocab.priceCents.min), vocab.priceCents.max)
      continue
    }

    const allowed = key === 'category' ? vocab.category
      : key === 'tags' ? vocab.tags
      : vocab.attrs[key]
    if (!allowed) { dropped.push(key); continue }

    // Substitute the catalogue's own casing — the same discipline as declassification:
    // match against trusted data, then use the trusted copy.
    const matched = [].concat(value)
      .map(v => allowed.find(a => String(a).toLowerCase() === String(v).toLowerCase()))
      .filter(v => v !== undefined)

    if (!matched.length) { dropped.push(key); continue }
    filters[key] = matched.length === 1 ? matched[0] : matched
  }

  const weights = {}
  for (const k of Object.keys(filters)) {
    const w = Number(parsed?.weights?.[k])
    weights[k] = Number.isFinite(w) ? Math.min(Math.max(w, 0), 1) : 0.5
  }
  // Category is STRUCTURAL, not a preference. The model rated it low once and relaxation
  // dropped it first, which put a jacket in a list of sleeping bags. Someone asking for
  // sleeping bags would rather see none than see a jacket, so it is never negotiable.
  if ('category' in filters) weights.category = 1

  return { filters, weights, dropped, rationale: String(parsed?.rationale ?? '').slice(0, 200) }
}

export async function interpretNeed (adapter, text, vocabulary) {
  const raw = await adapter.run('interpret_need', { text, vocabulary })
  if (!raw) return null

  let parsed
  try {
    const cleaned = String(raw).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
    parsed = JSON.parse(cleaned)
  } catch { return null }

  const out = validateAgainstVocabulary(parsed, vocabulary)
  // `partial` is returned even when the message was not a product request, so the scope
  // fence has something honest to pivot to.
  return Object.keys(out.filters).length ? out : { ...out, partial: out.filters, empty: true }
}
