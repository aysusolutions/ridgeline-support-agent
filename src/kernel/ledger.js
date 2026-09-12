// Append-only audit log. Every state change in the system passes through here, and
// the adversarial suite asserts on its contents rather than on reply text.
export function createLedger () {
  const entries = []
  const byKey = new Map()

  return {
    append (entry) {
      const stored = { ...structuredClone(entry), seq: entries.length }
      // Object.freeze is shallow, so freeze the payloads explicitly.
      Object.freeze(stored.result)
      Object.freeze(stored.args)
      Object.freeze(stored)
      entries.push(stored)
      // First write wins: a replayed idempotency key must resolve to the original effect.
      if (stored.idemKey && !byKey.has(stored.idemKey)) byKey.set(stored.idemKey, stored)
      return stored
    },

    findByKey (idemKey) {
      return idemKey ? (byKey.get(idemKey) ?? null) : null
    },

    entries () { return entries.slice() },
    since (seq) { return entries.filter(e => e.seq > seq) },
    reset () { entries.length = 0; byKey.clear() },
  }
}
