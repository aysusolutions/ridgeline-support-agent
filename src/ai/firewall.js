// The provenance firewall.
//
// Every fact-shaped atom in a generation must trace back to a value in this turn's typed
// results. The model may rephrase; it can never introduce a fact. A rejected generation
// is discarded whole and the deterministic template ships instead.

// Software does not have experiences. The persona tells the model it knows this gear in
// detail, and an early wording ("you have slept in this gear") came straight back out as
// "I've slept in it" to a shopper. A persona is a voice, never a licence to invent a life,
// so the claim is caught here rather than merely discouraged in a prompt.
const LIVED_EXPERIENCE =
  /\b(?:i|we)(?:['’]ve|\s+have)?\s+(?:personally\s+)?(?:slept|camped|hiked|climbed|worn|wore|used|owned|tested|tried)\b|\bmy\s+(?:own|favourite|favorite)\b|\bin my experience\b/i

export function verifyNoLivedExperience (text) {
  const m = LIVED_EXPERIENCE.exec(String(text ?? ''))
  return m ? { ok: false, rejected: [m[0].trim()] } : { ok: true, rejected: [] }
}

// Pleading ignorance while holding the answer. It replied "I need more details on the tent
// models we carry" with three tents on screen beside it — a non-answer that reads as
// broken, and strictly worse than the deterministic template it displaced. Whether we
// actually handed over results is code's knowledge, not the model's, so code checks it.
// Enumerating the words that can sit between the verb and the noun was whack-a-mole:
// "the specs" slipped past, then "the full specs", then "the tent specs". Match the SHAPE
// instead — a first-person claim of not having enough, with up to three words of anything
// in between. Bounded, so it cannot run away across a whole paragraph.
const STALLING = new RegExp(
  String.raw`\b(?:i|we)\s+(?:need|require|would need|don['’]?t have|do not have|am missing|lack)\s+`
  + String.raw`(?:\w+\s+){0,3}(?:details?|info(?:rmation)?|specs?|specifications?|data)\b`
  + String.raw`|(?:\bnot|n['’]t)\s+(?:have\s+|got\s+)?enough\s+(?:detail|info)`,
  'i')

export function verifyNotStalling (text, hasResults) {
  if (!hasResults) return { ok: true, rejected: [] }
  const m = STALLING.exec(String(text ?? ''))
  return m ? { ok: false, rejected: [m[0].trim()] } : { ok: true, rejected: [] }
}

const PROMISE_WORDS =
  /\b(guarantee[ds]?|free of charge|we will definitely|no charge at all|i promise|rest assured)\b/i

const ATOM_PATTERNS = [
  /\$\s?\d[\d,]*(?:\.\d{2})?/g,                              // currency
  /\b\d[\d,]*\.\d{2}\b/g,                                    // bare two-decimal amounts
  /\b\d{4}-\d{2}-\d{2}\b/g,                                  // ISO dates
  /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/g,
  /\b(?:RO|RMA|CLAIM|TKT|CR|CART)-[A-Z0-9]+\b/g,             // record identifiers
  /\b1Z[0-9A-Z]{16}\b/g,                                     // UPS tracking
  /\b\d{15,}\b/g,                                            // long tracking numbers
  /\bhttps?:\/\/[^\s)]+/g,                                   // urls
]

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                'July', 'August', 'September', 'October', 'November', 'December']

const normNumber = s => String(s).replace(/[$,\s]/g, '').replace(/[.,;:!?]+$/, '')

// Index every scalar reachable in the typed results, PLUS the renderings a composer
// would legitimately produce from it — cents as dollars, ISO stamps as "July 30".
function buildIndex (typedResults) {
  const index = new Set()
  const add = v => {
    if (v === null || v === undefined || v === '') return
    index.add(String(v))
    index.add(normNumber(v))
  }

  const walk = (node, key = '') => {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(n => walk(n, key)); return }
    if (typeof node === 'object') {
      // Unwrap tainted values so their contents are still recognised as source facts.
      if (node.value !== undefined && Object.isFrozen(node)) { walk(node.value, key); return }
      for (const [k, v] of Object.entries(node)) walk(v, k)
      return
    }

    add(node)

    // Facts EMBEDDED in a source string are still source facts. Without this, prose
    // fields like whyNotCheaper ("The Aspen is $140 less…") index only as a whole
    // string, and a composer quoting "$140" from it gets wrongly rejected.
    if (typeof node === 'string' && node.length > 8) {
      for (const pattern of ATOM_PATTERNS) {
        for (const m of node.matchAll(pattern)) add(m[0])
      }
    }

    if (typeof node === 'number' && /Cents$/.test(key)) {
      add((node / 100).toFixed(2))
      add(String(node / 100))
    }
    if (typeof node === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(node)) {
      const d = new Date(node)
      add(node.slice(0, 10))
      add(`${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`)
    }
  }

  walk(typedResults)
  return index
}

// Language that asserts something HAPPENED. The provenance firewall checks facts, not
// deeds — so "your purchase is being processed" sailed through while the ledger was
// empty. An agent that can act must never claim to have acted when it did not.
const CLAIMED_ACTION =
  /\b(?:has|have|is|are|was|were)\s+been\s+(?:placed|processed|cancelled|canceled|issued|created|refunded|booked|reserved|added|confirmed|completed|submitted)\b|\b(?:is|are)\s+being\s+(?:processed|placed|prepared|arranged|shipped)\b|\bi(?:'ve| have)\s+(?:placed|processed|cancelled|canceled|issued|created|refunded|booked|reserved|added|ordered|arranged)\b|\byour\s+order\s+(?:is|has)\b/i

export function claimsAction (text) {
  return CLAIMED_ACTION.test(String(text ?? ''))
}

// `didAct` is whether this turn actually wrote to the ledger.
export function verifyNoFalseAction (generated, didAct) {
  if (didAct) return { ok: true, rejected: [] }
  const m = String(generated ?? '').match(CLAIMED_ACTION)
  return m ? { ok: false, rejected: [m[0]] } : { ok: true, rejected: [] }
}

export function firewall (generated, typedResults) {
  if (typeof generated !== 'string' || !generated.trim()) {
    return { ok: false, rejected: ['<empty generation>'] }
  }

  const promise = generated.match(PROMISE_WORDS)
  if (promise) return { ok: false, rejected: [promise[0]] }

  const index = buildIndex(typedResults)
  const rejected = []

  for (const pattern of ATOM_PATTERNS) {
    for (const match of generated.matchAll(pattern)) {
      const atom = match[0]
      const candidates = [atom, normNumber(atom), atom.replace(/[.,;:!?]+$/, '')]
      if (!candidates.some(c => index.has(c))) rejected.push(atom)
    }
  }

  return { ok: rejected.length === 0, rejected: [...new Set(rejected)] }
}
