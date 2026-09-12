import { tainted, LABELS } from '../shared/taint.js'

// The quarantined reader. Sees untrusted text; holds no tools, no session, no memory
// across calls. Its output is born tainted and is only usable after a declassifier
// matches it against a closed set of values we already trust.
export async function extractWith (adapter, blob, schema, nonce) {
  // Strip the nonce from the content first, so the fence cannot be forged or closed early.
  const clean = String(blob ?? '').split(nonce).join('')

  const raw = await adapter.run('extract', {
    nonce,
    schema,
    fenced: `<untrusted id="${nonce}">${clean}</untrusted>`,
  })
  if (raw === null || raw === undefined) return null

  const value = String(raw).trim()
  if (!value || value.toLowerCase() === 'null') return null

  if (schema.enum && !schema.enum.includes(value)) return null
  if (schema.pattern && !new RegExp(schema.pattern).test(value)) return null
  if (schema.maxLength && value.length > schema.maxLength) return null

  if (schema.type === 'number') {
    const n = Number(value)
    if (!Number.isFinite(n)) return null
    if (n < (schema.min ?? -Infinity) || n > (schema.max ?? Infinity)) return null
    return tainted(n, [LABELS.MODEL, LABELS.UNTRUSTED])
  }

  return tainted(value, [LABELS.MODEL, LABELS.UNTRUSTED])
}

export function newNonce () {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
}
