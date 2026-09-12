// Builds the closed vocabulary the interpreter is allowed to choose from.
//
// Only RECORD-labelled structured fields. `blurb` and `review` are UNTRUSTED and must
// never enter a prompt payload — a poisoned review would otherwise travel straight into
// the interpreter's context. See spec §7.1.
const EXCLUDED = new Set(['blurb', 'review', 'whyNotCheaper'])

export function buildVocabulary (db) {
  const products = db.searchProducts({})
  const category = new Set()
  const tags = new Set()
  const attrs = {}
  let min = Infinity
  let max = 0

  for (const p of products) {
    category.add(p.category)
    for (const t of p.tags ?? []) tags.add(t)
    min = Math.min(min, p.priceCents)
    max = Math.max(max, p.priceCents)

    for (const [k, v] of Object.entries(p.attrs ?? {})) {
      if (EXCLUDED.has(k) || v === null || v === undefined) continue
      attrs[k] ??= new Set()
      for (const one of [].concat(v)) attrs[k].add(one)
    }
  }

  return {
    category: [...category],
    tags: [...tags],
    attrs: Object.fromEntries(Object.entries(attrs).map(([k, s]) => [k, [...s]])),
    priceCents: { min: Number.isFinite(min) ? min : 0, max },
  }
}
