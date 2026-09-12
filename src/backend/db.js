import { LABELS, tainted } from '../shared/taint.js'
import ordersSeed from './orders.json' with { type: 'json' }
import productsSeed from './products.json' with { type: 'json' }
import policiesSeed from './policies.json' with { type: 'json' }
import faqsSeed from './faqs.json' with { type: 'json' }

// Free-text fields a third party could have authored. Everything read out of these
// is born UNTRUSTED and can never reach a tool argument — see shared/taint.js.
const UNTRUSTED_ORDER_FIELDS = ['giftMessage', 'customerNote']
const UNTRUSTED_PRODUCT_FIELDS = ['blurb', 'review']

const LEDGER_KEY = 'ridgeline:ledger:v1'
const LEDGER_VERSION = 1

function wrapUntrusted (obj, fields) {
  const out = structuredClone(obj)
  for (const f of fields) {
    if (out[f] !== null && out[f] !== undefined) out[f] = tainted(out[f], [LABELS.UNTRUSTED])
  }
  return out
}

// Only MUTABLE records live in the state that persists. Products and policies stay static
// config: persisting them would mean an edit to products.json silently stops taking
// effect, which is a worse trap than a demo that resets.
function freshState (base) {
  const s = structuredClone(base)
  s.carts ??= []
  s.stockDelta ??= {}          // { [sku]: negative integer } — stock CONSUMED, not stock
  s.seq ??= {}                 // durable per-prefix counters; session.seq resets, these do not
  return s
}

// A corrupt or stale key falls back to the seed rather than throwing. A demo that will
// not boot because of yesterday's localStorage is worse than one that starts over.
function rehydrate (base, storage) {
  let raw = null
  try { raw = storage.getItem(LEDGER_KEY) } catch { return null }
  if (!raw) return null
  try {
    const saved = JSON.parse(raw)
    if (!saved || saved.v !== LEDGER_VERSION || !Array.isArray(saved.orders)) return null
    const s = freshState(base)
    s.orders = saved.orders
    s.carts = Array.isArray(saved.carts) ? saved.carts : []
    s.stockDelta = saved.stockDelta && typeof saved.stockDelta === 'object' ? saved.stockDelta : {}
    s.seq = saved.seq && typeof saved.seq === 'object' ? saved.seq : {}
    return s
  } catch {
    return null
  }
}

// Session-scoped and mutable. With no `storage` each visitor gets a pristine sandbox
// seeded from JSON and writes are real within the session but never persisted — which is
// exactly how the whole test suite runs. With `storage` the mutable records survive a
// reload, which is what lets a basket built in the chat still exist on the cart page.
export function createDb (seed, { storage } = {}) {
  const base = seed ?? { orders: ordersSeed, products: productsSeed, faqs: faqsSeed }
  let state = (storage && rehydrate(base, storage)) || freshState(base)

  const save = () => {
    if (!storage) return
    try {
      storage.setItem(LEDGER_KEY, JSON.stringify({
        v: LEDGER_VERSION,
        orders: state.orders,
        carts: state.carts,
        stockDelta: state.stockDelta,
        seq: state.seq,
      }))
    } catch { /* a full or blocked store is not a reason to break the page */ }
  }
  if (storage) save()

  // Stock is seed minus consumed. Applying it in the READ paths means the storefront,
  // the recommender and every stock precondition see the same number with no changes of
  // their own — and a SKU bought down to zero becomes restock-subscribable for free.
  const withStock = (p) => {
    const used = state.stockDelta[p.sku] ?? 0
    return used ? { ...p, stock: Math.max(0, p.stock + used) } : p
  }

  return {
    getOrder (id) {
      const o = state.orders.find(x => x.id === String(id ?? '').toUpperCase())
      return o ? wrapUntrusted(o, UNTRUSTED_ORDER_FIELDS) : null
    },

    findOrderByEmail (email) {
      const needle = String(email ?? '').toLowerCase()
      return state.orders
        .filter(o => o.email.toLowerCase() === needle)
        .map(o => wrapUntrusted(o, UNTRUSTED_ORDER_FIELDS))
    },

    listOrderIds () { return state.orders.map(o => o.id) },

    getProduct (sku) {
      const p = state.products.find(x => x.sku === String(sku ?? '').toUpperCase())
      return p ? wrapUntrusted(withStock(p), UNTRUSTED_PRODUCT_FIELDS) : null
    },

    searchProducts (filters = {}) {
      return state.products
        .map(withStock)
        .filter(p => !filters.category || p.category === filters.category)
        .filter(p => filters.inStock === undefined || (p.stock > 0) === filters.inStock)
        .filter(p => filters.maxPriceCents === undefined || p.priceCents <= filters.maxPriceCents)
        .filter(p => filters.minPriceCents === undefined || p.priceCents >= filters.minPriceCents)
        .map(p => wrapUntrusted(p, UNTRUSTED_PRODUCT_FIELDS))
    },

    listSkus () { return state.products.map(p => p.sku) },

    getCart (id) {
      const c = state.carts.find(x => x.id === String(id ?? '').toUpperCase())
      return c ? structuredClone(c) : null
    },

    getPolicies () { return structuredClone(policiesSeed) },

    faqs () { return structuredClone(state.faqs) },

    // Ids for records that OUTLIVE the conversation. session.seq resets on reload, so a
    // cart minted from it could be handed out twice; RMA/TKT/CLAIM/CR ids are session
    // scoped by design and keep using it.
    nextId (prefix) {
      // The floor is DERIVED, so a new order id can never land on a fixture's. Reading it
      // from the records themselves means changing orders.json cannot silently create a
      // collision the way a hardcoded start number would.
      const floor = prefix === 'RO'
        ? state.orders.reduce((m, o) => Math.max(m, Number(String(o.id).split('-')[1]) || 0), 0) + 1
        : 1000
      const next = Math.max(state.seq[prefix] ?? 0, floor)
      state.seq[prefix] = next + 1
      save()
      return `${prefix}-${next}`
    },

    // The only write path. Everything that mutates goes through the kernel, which
    // calls this and appends to the ledger in the same step.
    mutate (fn) { fn(state); save(); return true },

    snapshot () { return structuredClone(state) },

    reset () { state = freshState(base); save() },
  }
}
