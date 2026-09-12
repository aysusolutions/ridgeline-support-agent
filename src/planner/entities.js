const ORDER_FULL = /\b(RO)[-\s]?(\d{5})\b/gi
const BARE_NUM = /\b(\d{5})\b/g
const EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/g
const SKU = /\b[A-Z]{3}-[A-Z]{4}-[A-Z0-9]{1,3}\b/gi
const MONEY = /\$\s?(\d+(?:\.\d{2})?)/g
const DATE = /\b(\d{4}-\d{2}-\d{2})\b/g

// Everything extracted here is USER-originated, and it is what the Plan AST checks a
// {lit:} value against. A literal the model invents is not in this set and is rejected.
export function extractEntities (text, known = { orderIds: [], skus: [] }) {
  const s = String(text ?? '')
  const orderIds = new Set()

  for (const m of s.matchAll(ORDER_FULL)) orderIds.add(`RO-${m[2]}`)
  for (const m of s.matchAll(BARE_NUM)) {
    // A bare five-digit number only becomes an order id if one actually exists.
    const candidate = `RO-${m[1]}`
    if (known.orderIds.includes(candidate)) orderIds.add(candidate)
  }

  return {
    orderIds: [...orderIds],
    emails: [...new Set([...s.matchAll(EMAIL)].map(m => m[0].toLowerCase()))],
    skus: [...new Set([...s.matchAll(SKU)]
      .map(m => m[0].toUpperCase())
      .filter(k => known.skus.includes(k)))],
    dates: [...new Set([...s.matchAll(DATE)].map(m => m[1]))],
    amounts: [...new Set([...s.matchAll(MONEY)].map(m => Math.round(parseFloat(m[1]) * 100)))],
  }
}
