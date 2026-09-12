export function normalize (s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim()
}

// Generic question and filler words. Without this list they dominate the overlap:
// "what does the gift message say" scored 0.55 against "What does the warranty cover?"
// purely on what/does/the, and answered a warranty question. Deliberately does NOT
// include words that carry intent here — `where`, `long`, `cancel`, `return`.
const STOP = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'its',
  'was', 'her', 'his', 'him', 'she', 'they', 'them', 'their', 'there', 'been',
  'what', 'does', 'did', 'this', 'that', 'these', 'those', 'have', 'with',
  'your', 'from', 'some', 'any', 'will', 'would', 'could', 'should', 'about',
  // NOT stopped: `want` and `need`. They look like filler but they carry the intent in
  // "I want to return this" and "I need to cancel" — stopping them left those phrases
  // with a single content token, which the single-token cap then rightly distrusted.
  'just', 'like', 'please', 'thanks', 'thank', 'hello', 'hey',
  'when', 'why', 'who', 'now', 'get', 'got', 'let', 'say', 'says', 'tell',
  'know', 'think', 'really', 'very', 'much', 'many', 'more', 'most', 'also',
])

const tokens = s => new Set(normalize(s).split(' ').filter(w => w.length > 2 && !STOP.has(w)))

// Dice coefficient over content tokens. At the corpus sizes here — 9 intents, 22 FAQ
// entries with hand-written aliases — this matches or beats dense retrieval, and it is
// deterministic, which is what lets the fixture suite assert on it.
//
// Dice rather than overlap/max: the max() denominator punishes a longer query for the
// words it adds, so "please cancel my order" would score below "cancel my order" and
// fall out of the act band. Dice normalises against both sides.
export function score (a, b) {
  // An identical phrase is maximal evidence however few content words survive. Without
  // this, "when will it arrive" reduces to {arrive} and fails to match itself.
  if (normalize(a) === normalize(b)) return 1

  const ta = tokens(a)
  const tb = tokens(b)
  if (!ta.size || !tb.size) return 0

  let hit = 0
  for (const t of ta) if (tb.has(t)) hit++
  if (!hit) return 0

  const dice = (2 * hit) / (ta.size + tb.size)

  // One shared word is weak evidence however flattering the ratio. "buy it for me"
  // against "what should i buy" both reduce to {buy}, scoring a perfect 1.0 — and that
  // sent a purchase request straight into product search with no second opinion.
  // Cap a single-token match below the disambiguate threshold so it always gets one.
  // Two or more corroborating tokens are left exactly as they were.
  return hit === 1 ? Math.min(dice, 0.44) : dice
}

export function editDistance (a, b) {
  const m = a.length; const n = b.length
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}

// Powers the "did you mean RO-10482?" recovery on a mistyped order number.
export function bestMatch (needle, haystack) {
  let best = { value: null, score: 0 }
  const n = String(needle).toUpperCase()
  for (const h of haystack) {
    const s = 1 - editDistance(n, String(h).toUpperCase()) / Math.max(n.length, String(h).length)
    if (s > best.score) best = { value: h, score: s }
  }
  return best
}
