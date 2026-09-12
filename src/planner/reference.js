import { score } from './fuzzy.js'

// Resolves a product the shopper NAMES in free text — "I think ridgeline hiker is good",
// "the aspen one", "the cheaper of those".
//
// Without this the agent treats a settled choice as a fresh search and shows the
// catalogue again, which reads as not listening. What was last on screen is checked
// first, because that is what "it" and "that one" almost always mean.

const ORDINALS = [
  [/\bfirst\b|\btop\b|\bthis one\b/i, 0],
  [/\bsecond\b|\bmiddle\b/i, 1],
  [/\bthird\b|\blast\b|\bbottom\b/i, 2],
]

export function resolveProduct (text, { lastShown = [], db }) {
  const t = String(text ?? '')
  const shown = lastShown.map(s => db.getProduct(s)).filter(Boolean)

  // Ordinals and comparatives only make sense against what is on screen.
  if (shown.length) {
    for (const [re, idx] of ORDINALS) {
      if (re.test(t) && shown[idx]) return shown[idx].sku
    }
    if (/\bcheap|\bless\b|\bbudget|\baffordable/i.test(t)) {
      return shown.reduce((a, b) => (a.priceCents <= b.priceCents ? a : b)).sku
    }
    if (/\bexpensive|\bpricier|\bpremium|\bdearer/i.test(t)) {
      return shown.reduce((a, b) => (a.priceCents >= b.priceCents ? a : b)).sku
    }
  }

  const all = db.searchProducts({})

  // A DISTINCTIVE name word beats sentence-wide overlap. Dice compares whole strings, so
  // "what is aspen2p tent" against "Aspen 2P Tent" scored 0.29 — the question words
  // diluted it — and the agent answered about a different tent entirely. Even "tell me
  // about aspen" failed. But "aspen" appears in exactly one product name in the
  // catalogue, which is all the evidence anyone needs.
  //
  // "aspen2p" is split on the letter/digit boundary first, because shoppers type it glued.
  const words = new Set(
    String(t).toLowerCase()
      .replace(/([a-z])(\d)/g, '$1 $2').replace(/(\d)([a-z])/g, '$1 $2')
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3))

  const nameWords = (p) => new Set(
    p.name.toLowerCase().replace(/([a-z])(\d)/g, '$1 $2')
      .replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3))

  // How many products does each word appear in? A word in exactly one is a name.
  const owners = new Map()
  for (const p of all) for (const w of nameWords(p)) {
    owners.set(w, (owners.get(w) ?? new Set()).add(p.sku))
  }
  const distinctive = [...words]
    .filter(w => owners.get(w)?.size === 1)
    .map(w => [...owners.get(w)][0])
  // Only when they all point at ONE product: "aspen ultralight" is a comparison, not a pick.
  if (new Set(distinctive).size === 1) return distinctive[0]

  // By name — what was shown first, then the whole catalogue.
  const byName = (pool) => pool
    .map(p => ({ sku: p.sku, s: score(t, p.name) }))
    .sort((a, b) => b.s - a.s)[0]

  const inShown = shown.length ? byName(shown) : null
  if (inShown && inShown.s >= 0.5) return inShown.sku

  const anywhere = byName(all)
  // A higher bar off-screen: "boot" should not silently pick one of eighteen products.
  return anywhere && anywhere.s >= 0.75 ? anywhere.sku : null
}
