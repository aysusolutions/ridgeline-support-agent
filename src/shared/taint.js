// Provenance labelling. Lives in shared/ rather than kernel/ because both the trusted
// core and the untrusted AI layer legitimately need it — and src/ai may not import
// src/kernel. See the layering test in plan Task 20.

export const LABELS = Object.freeze({
  USER: 'USER',            // the human typed it, post-sanitisation
  SYSTEM: 'SYSTEM',        // our own config and policy files
  RECORD: 'RECORD',        // structured backend fields we author
  UNTRUSTED: 'UNTRUSTED',  // free text a third party could have written
  MODEL: 'MODEL',          // anything an LLM produced
})

// Only these three may reach a tool argument. UNTRUSTED and MODEL never can.
const SAFE_FOR_ARGS = new Set([LABELS.USER, LABELS.SYSTEM, LABELS.RECORD])

const BRAND = Symbol.for('ridgeline.taint')

export class TaintViolation extends Error {
  constructor (msg) { super(msg); this.name = 'TaintViolation' }
}

export function tainted (value, labels) {
  return Object.freeze({
    [BRAND]: true,
    value,
    labels: Object.freeze([...new Set(labels)].sort()),
  })
}

export function isTainted (x) {
  return !!(x && typeof x === 'object' && x[BRAND] === true)
}

export function labelsOf (x) {
  return isTainted(x) ? x.labels : [LABELS.SYSTEM]
}

export function unwrap (x) {
  return isTainted(x) ? x.value : x
}

// Taint is contagious: a derived value carries the union of its inputs' labels.
export function derive (inputs, value) {
  return tainted(value, inputs.flatMap(labelsOf))
}

export function assertUntainted (args) {
  for (const [key, v] of Object.entries(args)) {
    const bad = labelsOf(v).filter(l => !SAFE_FOR_ARGS.has(l))
    if (bad.length) {
      throw new TaintViolation(
        `argument "${key}" carries ${bad.join(', ')} and cannot reach a tool`)
    }
  }
}

// Declassification is LOOKUP, not inspection.
//
// The candidate is discarded and the trusted copy is returned in its place. There is
// deliberately no "this looks safe, let it through" path — you cannot sanitise your way
// out of taint, you can only match a value against data you already trusted.
export function declassify (candidate, trustedValues) {
  const raw = String(unwrap(candidate) ?? '').trim()
  if (!raw) return null
  const hit = trustedValues.find(t => String(t).toUpperCase() === raw.toUpperCase())
  return hit === undefined ? null : tainted(hit, [LABELS.RECORD])
}
