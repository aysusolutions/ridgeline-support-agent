// Claim-level attribution for grounded answers.
//
// This is token overlap plus exact number and date matching — NOT an NLI entailment
// model. It is described that way in the README rather than overclaimed. It catches the
// failure that matters here: an answer that quietly states a policy figure the cited
// passage does not contain.

const STOP = new Set(['the', 'and', 'for', 'are', 'you', 'your', 'with', 'that', 'this',
  'from', 'have', 'will', 'can', 'our', 'not', 'but', 'any', 'all', 'within', 'were'])

const tokens = s => new Set(String(s).toLowerCase().match(/[a-z0-9]+/g)?.filter(
  t => t.length > 2 && !STOP.has(t)) ?? [])

const FIGURES = /\b\d+(?:\.\d+)?\b|\$\s?\d[\d,]*(?:\.\d{2})?|\b\d{4}-\d{2}-\d{2}\b/g

const sentences = s => String(s).split(/(?<=[.!?])\s+/).map(x => x.trim()).filter(Boolean)

export const OVERLAP_THRESHOLD = 0.4

// citedPassages: the FAQ entries the answer claimed to use, already resolved to text.
export function attribute (answer, citedPassages, threshold = OVERLAP_THRESHOLD) {
  if (!citedPassages.length) return { ok: false, unattributed: ['<no citation>'] }

  const corpus = citedPassages.join(' ')
  const corpusTokens = tokens(corpus)
  const corpusFigures = new Set((corpus.match(FIGURES) ?? []).map(f => f.replace(/[$,\s]/g, '')))

  const unattributed = []

  for (const sentence of sentences(answer)) {
    const st = tokens(sentence)
    if (!st.size) continue

    let hit = 0
    for (const t of st) if (corpusTokens.has(t)) hit++
    if (hit / st.size < threshold) { unattributed.push(sentence); continue }

    // A figure the cited passage does not contain is a fabrication, however well the
    // rest of the sentence overlaps.
    const figures = (sentence.match(FIGURES) ?? []).map(f => f.replace(/[$,\s]/g, ''))
    if (figures.some(f => !corpusFigures.has(f))) unattributed.push(sentence)
  }

  return { ok: unattributed.length === 0, unattributed }
}

export function citedIdsFrom (answer, availableIds) {
  const cited = [...String(answer).matchAll(/\[([a-z0-9-]+)\]/gi)].map(m => m[1])
  return cited.filter(id => availableIds.includes(id))
}
