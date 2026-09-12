export const CONFIRM_TTL_MS = 120_000

export class ConfirmationInvalid extends Error {
  constructor (reason) { super(reason); this.name = 'ConfirmationInvalid'; this.reason = reason }
}

function stableStringify (v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

// FNV-1a. This binds the token to a specific effect so it cannot be reused for a
// different one. The NONCE carries the unguessability; this hash deliberately does not
// need to be cryptographic, because an attacker who could forge a binding would still
// need the nonce, which is never written to the DOM or sent to a model.
function fnv1a (str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function bindingOf (sessionId, stepId, tool, args) {
  return fnv1a([sessionId, stepId, tool, stableStringify(args)].join('|'))
}

function randomNonce () {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}

export function createConfirmations (clock = () => Date.now()) {
  const store = new Map()   // nonce -> { binding, expiresAt, used }

  return {
    mint (binding) {
      const nonce = randomNonce()
      store.set(nonce, { binding, expiresAt: clock() + CONFIRM_TTL_MS, used: false })
      return nonce
    },

    verify (nonce, binding) {
      const rec = nonce ? store.get(nonce) : undefined
      if (!rec) throw new ConfirmationInvalid('UNKNOWN')
      if (rec.used) throw new ConfirmationInvalid('USED')
      if (clock() > rec.expiresAt) throw new ConfirmationInvalid('EXPIRED')
      if (rec.binding !== binding) throw new ConfirmationInvalid('BINDING_MISMATCH')
      rec.used = true
      return true
    },

    pending () {
      const now = clock()
      return [...store.entries()]
        .filter(([, r]) => !r.used && now <= r.expiresAt)
        .map(([n]) => n)
    },

    expireAll () { store.clear() },
  }
}
