const registry = []

export function test (name, fn) { registry.push({ name, fn }) }

// Conversational replies are now checked by a second `verify` call, and the checker fails
// CLOSED — unverified prose does not ship. A stub that only answers `converse` therefore
// gets its reply thrown away. Wrap it in this to say "the checker found nothing wrong",
// which is what almost every test means. Tests about the checker itself stub it directly.
export const passesVerify = (stub) => ({
  ...stub,
  async run (job, payload) {
    if (job === 'verify') return '{"action":false,"experience":false,"stalling":false}'
    return stub.run(job, payload)
  },
})

export function registered () { return registry }

function stable (v) {
  if (v === null || typeof v !== 'object') return v
  if (Array.isArray(v)) return v.map(stable)
  return Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])]))
}

const clip = (s, n = 700) => (s && s.length > n ? `${s.slice(0, n)}… (${s.length} chars)` : s)

export const assert = {
  eq (a, b, msg) {
    const sa = JSON.stringify(stable(a)); const sb = JSON.stringify(stable(b))
    if (sa !== sb) throw new Error(`${msg}\n  expected: ${clip(sb)}\n  actual:   ${clip(sa)}`)
  },
  ok (v, msg) { if (!v) throw new Error(`${msg}: expected truthy, got ${JSON.stringify(v)}`) },
  throwsWith (fn, Ctor, substring) {
    let threw = null
    try { fn() } catch (e) { threw = e }
    if (!threw) throw new Error(`expected ${Ctor.name}, nothing thrown`)
    if (!(threw instanceof Ctor)) {
      throw new Error(`expected ${Ctor.name}, got ${threw.constructor.name}: ${threw.message}`)
    }
    if (substring && !threw.message.includes(substring)) {
      throw new Error(`expected message containing "${substring}", got "${threw.message}"`)
    }
  },
}

export function snapshot (obj) { return structuredClone(obj) }

// Descends into arrays as well as objects, so a single changed field reports as
// `orders.0.status` rather than dumping the whole array. The adversarial suite asserts
// on these paths, so a blob diff would tell you nothing about WHAT changed.
export function diff (before, after) {
  const out = []
  const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v)

  const walk = (a, b, path) => {
    const join = k => (path === '' ? String(k) : `${path}.${k}`)

    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.max(a.length, b.length); i++) walk(a[i], b[i], join(i))
      return
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], join(k))
      return
    }
    if (JSON.stringify(stable(a)) !== JSON.stringify(stable(b))) out.push({ path, from: a, to: b })
  }

  walk(before, after, '')
  return out
}
