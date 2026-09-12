import { PRECONDITIONS } from './preconditions.js'
import { DIRECTION } from '../config/attributes.js'
import { brand } from '../config/brand.js'
import { score } from '../planner/fuzzy.js'

// Every tool is data plus one pure-ish execute. The kernel is the only caller.
// execute() returns a TYPED RESULT OBJECT, never prose — composing prose is the
// composer's job, and the provenance firewall checks it against these values.

const usd = cents => `$${(cents / 100).toFixed(2)}`
const day = iso => new Date(iso).toLocaleDateString('en-US', {
  month: 'long', day: 'numeric', timeZone: 'UTC',
})
const nextId = (ctx, prefix) => `${prefix}-${ctx.seq.n++}`

const stageOf = (order) => ({
  processing: 'Preparing',
  in_transit: 'On the way',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
}[order.status] ?? 'Unknown')

const lineOf = (order, lineItemId) => order.items.find(i => i.lineId === lineItemId)

export const TOOLS = {}

/* ---------------------------------------------------------------- read tools */

TOOLS.lookup_order = {
  args: { orderId: { type: 'string', required: true } },
  scope: 'read',
  subject: a => `order:${a.orderId}`,
  preconditions: [],
  consequential: false,
  idemKey: null,
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    return {
      kind: 'order',
      id: o.id,
      status: o.status,
      stage: stageOf(o),
      placedAt: o.placedAt,
      carrier: o.fulfillment.carrier,
      tracking: o.fulfillment.tracking,
      shippedAt: o.fulfillment.shippedAt,
      deliveredAt: o.fulfillment.deliveredAt,
      eta: o.fulfillment.eta,
      events: o.fulfillment.events,
      items: o.items.map(i => ({
        lineId: i.lineId, sku: i.sku, name: i.name, variant: i.variant, qty: i.qty,
        unitPriceCents: i.unitPriceCents, finalSale: i.finalSale,
        returnable: i.returnable, defective: i.defective, rmaId: i.rmaId,
      })),
      totals: o.totals,
      payment: o.payment,
      shipTo: o.shipTo,
      giftMessage: o.giftMessage,     // stays tainted — display only, never an argument
      customerNote: o.customerNote,
    }
  },
}

const valueOf = (p, key) =>
  key === 'category' ? p.category
    : key === 'tags' ? (p.tags ?? [])
      : key === 'maxPriceCents' || key === 'minPriceCents' ? p.priceCents
        : p.attrs?.[key]

function matches (p, key, want) {
  const have = valueOf(p, key)
  if (key === 'maxPriceCents') return have <= want
  if (key === 'minPriceCents') return have >= want
  const wanted = [].concat(want).map(v => String(v).toLowerCase())
  return [].concat(have ?? []).some(h => wanted.includes(String(h).toLowerCase()))
}

// Never dead-ends. If the filter set is too narrow, drop the least important constraint
// and retry, until three results exist or no constraints remain — then SAY what was
// relaxed rather than hiding it.
export function searchWithRelaxation (products, filters, weights = {}, minResults = 3) {
  const active = { ...filters }
  const relaxed = []
  // Category is never relaxed. Returning two sleeping bags is a better answer than
  // returning two sleeping bags and a jacket.
  const order = Object.keys(filters)
    .filter(k => k !== 'category')
    .sort((a, b) => (weights[a] ?? 0.5) - (weights[b] ?? 0.5))

  for (;;) {
    const hits = products.filter(p => Object.entries(active).every(([k, v]) => matches(p, k, v)))
    if (hits.length >= minResults || order.length === 0) {
      const ranked = hits
        .map(p => ({
          p,
          s: Object.entries(filters).reduce(
            (acc, [k, v]) => acc + (matches(p, k, v) ? (weights[k] ?? 0.5) : 0), 0),
        }))
        .sort((a, b) => b.s - a.s)
        .map(x => x.p)
      return { hits: ranked, relaxed }
    }
    const drop = order.shift()
    relaxed.push(drop)
    delete active[drop]
  }
}

TOOLS.search_products = {
  args: { filters: { type: 'object' }, weights: { type: 'object' } },
  scope: null,
  subject: () => null,
  preconditions: [],
  consequential: false,
  idemKey: null,
  execute (ctx, args) {
    const filters = args.filters ?? {}
    const all = ctx.db.searchProducts({})
    const { hits, relaxed } = searchWithRelaxation(all, filters, args.weights ?? {}, 3)
    return { kind: 'productList', items: hits.slice(0, 3), relaxed, filters }
  },
}

TOOLS.get_policy = {
  args: { key: { type: 'string', required: true } },
  scope: null,
  subject: () => null,
  preconditions: [],
  consequential: false,
  idemKey: null,
  execute (ctx, args) {
    // hasOwnProperty, not `in` — otherwise `constructor` and `__proto__` read through.
    const value = Object.prototype.hasOwnProperty.call(ctx.policies, args.key)
      ? ctx.policies[args.key]
      : null
    return { kind: 'policy', key: args.key, value }
  },
}

TOOLS.search_faq = {
  args: { query: { type: 'string', required: true } },
  scope: null,
  subject: () => null,
  preconditions: [],
  consequential: false,
  idemKey: null,
  execute (ctx, args) {
    const items = ctx.db.faqs()
      .map(f => ({
        ...f,
        score: Math.max(score(args.query, f.question), ...f.aliases.map(a => score(args.query, a))),
      }))
      .filter(f => f.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    return { kind: 'faqList', items }
  },
}

TOOLS.compare_products = {
  args: { skus: { type: 'array', required: true } },
  scope: null,
  subject: () => null,
  preconditions: [],
  consequential: false,
  idemKey: null,
  execute (ctx, args) {
    const skus = [].concat(args.skus).slice(0, 3)
    const products = skus.map(s => {
      const p = ctx.db.getProduct(s)
      if (!p) throw new Error(`unknown sku ${s}`)
      return p
    })

    const keys = [...new Set(products.flatMap(p => Object.keys(p.attrs)))]
    const differences = []
    const shared = []

    for (const attribute of keys) {
      const values = products.map(p => p.attrs[attribute])
      if (values.every(v => v === null || v === undefined)) continue
      if (values.every(v => JSON.stringify(v) === JSON.stringify(values[0]))) {
        shared.push(attribute)
        continue
      }

      const direction = DIRECTION[attribute] ?? null
      let winner = null
      let delta = null
      if (direction && values.every(v => typeof v === 'number')) {
        const best = direction === 'lower' ? Math.min(...values) : Math.max(...values)
        winner = products[values.indexOf(best)].sku
        delta = Math.abs(Math.max(...values) - Math.min(...values))
      }
      differences.push({ attribute, values, delta, winner, direction })
    }

    const cheapest = products.reduce((a, b) => (a.priceCents <= b.priceCents ? a : b)).sku
    return {
      kind: 'comparison',
      products: products.map(p => ({ sku: p.sku, name: p.name, priceCents: p.priceCents })),
      differences,
      shared,
      cheapest,
      whyNotCheaper: Object.fromEntries(products.map(p => [p.sku, p.whyNotCheaper])),
    }
  },
}

/* --------------------------------------------------------------- write tools */

TOOLS.cancel_order = {
  args: { orderId: { type: 'string', required: true } },
  scope: 'cancel',
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_unshipped'],
  consequential: true,
  idemKey: a => `cancel:${a.orderId}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    return {
      title: `Cancel order ${o.id}`,
      lines: [
        `Placed ${day(o.placedAt)} · ${o.items.length} item${o.items.length === 1 ? '' : 's'}`,
        `${usd(o.totals.totalCents)} back to ${o.payment.method} ...${o.payment.last4} in 3-5 business days`,
      ],
      irreversible: true,
    }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    ctx.db.mutate(s => { s.orders.find(x => x.id === o.id).status = 'cancelled' })
    // The refund is COMPUTED from the record. Any amount in args is ignored.
    return {
      kind: 'cancellation', orderId: o.id, refundCents: o.totals.totalCents,
      method: o.payment.method, last4: o.payment.last4, etaBusinessDays: '3-5',
    }
  },
}

TOOLS.change_shipping_address = {
  args: { orderId: { type: 'string', required: true }, address: { type: 'object', required: true } },
  scope: 'change_address',
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_unshipped', 'address_well_formed'],
  consequential: true,
  idemKey: a => `addr:${a.orderId}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    return {
      title: `Change the delivery address on ${o.id}`,
      lines: [
        `From ${o.shipTo.city}, ${o.shipTo.region} ${o.shipTo.postal}`,
        `To ${args.address.city}, ${args.address.region} ${args.address.postal}`,
      ],
      irreversible: true,
    }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    ctx.db.mutate(s => {
      s.orders.find(x => x.id === o.id).shipTo = { ...args.address }
    })
    return { kind: 'addressChange', orderId: o.id, address: { ...args.address } }
  },
}

TOOLS.create_return_rma = {
  args: {
    orderId: { type: 'string', required: true },
    lineItemId: { type: 'string', required: true },
    reason: {
      type: 'string', required: true,
      enum: ['defective', 'wrongItem', 'notAsDescribed', 'wrongSize', 'changedMind'],
    },
  },
  scope: ['return', 'warranty_return'],
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_delivered', 'item_returnable', 'no_existing_rma'],
  consequential: true,
  idemKey: a => `rma:${a.orderId}:${a.lineItemId}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const item = lineOf(o, args.lineItemId)
    const fee = ctx.policies.returnShippingPaidBy[args.reason] === 'customer'
      ? ctx.policies.changedMindReturnShippingFeeCents
      : 0
    const lines = [`${item.name} · ${item.variant.size} · ${item.variant.color}`]
    if (fee) {
      lines.push(`${usd(item.unitPriceCents * item.qty)} less ${usd(fee)} return shipping`)
      lines.push(`You get back ${usd(item.unitPriceCents * item.qty - fee)}`)
    } else {
      lines.push(`You get back ${usd(item.unitPriceCents * item.qty)} — we cover the shipping`)
    }
    return { title: `Start a return on ${o.id}`, lines, irreversible: true }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const item = lineOf(o, args.lineItemId)
    const fee = ctx.policies.returnShippingPaidBy[args.reason] === 'customer'
      ? ctx.policies.changedMindReturnShippingFeeCents
      : 0
    const rmaId = nextId(ctx, 'RMA')
    ctx.db.mutate(s => {
      const line = s.orders.find(x => x.id === o.id).items.find(i => i.lineId === args.lineItemId)
      line.rmaId = rmaId
    })
    return {
      kind: 'rma', rmaId, orderId: o.id, lineItemId: args.lineItemId,
      itemName: item.name, reason: args.reason,
      refundCents: item.unitPriceCents * item.qty - fee,
      feeCents: fee,
      labelUrl: `https://labels.ridgeline.example/${rmaId}`,
    }
  },
}

TOOLS.create_exchange = {
  args: {
    orderId: { type: 'string', required: true },
    lineItemId: { type: 'string', required: true },
    sku: { type: 'string', required: true },
    size: { type: 'string' },
  },
  scope: 'exchange',
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_delivered', 'item_returnable', 'no_existing_rma',
                  'within_return_window', 'variant_in_stock'],
  consequential: true,
  idemKey: a => `exch:${a.orderId}:${a.lineItemId}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const item = lineOf(o, args.lineItemId)
    return {
      title: `Exchange on ${o.id}`,
      lines: [
        `${item.name} · ${item.variant.size} → ${args.size ?? item.variant.size}`,
        'We hold the replacement while the original is on its way back. No charge either way.',
      ],
      irreversible: true,
    }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const item = lineOf(o, args.lineItemId)
    const rmaId = nextId(ctx, 'RMA')
    ctx.db.mutate(s => {
      s.orders.find(x => x.id === o.id).items.find(i => i.lineId === args.lineItemId).rmaId = rmaId
      const p = s.products.find(x => x.sku === args.sku)
      if (p) p.stock -= 1                       // reserve the replacement
    })
    return {
      kind: 'exchange', rmaId, orderId: o.id, lineItemId: args.lineItemId,
      itemName: item.name, newVariant: `${args.size ?? item.variant.size}`,
      labelUrl: `https://labels.ridgeline.example/${rmaId}`,
    }
  },
}

TOOLS.issue_store_credit = {
  args: { orderId: { type: 'string', required: true }, amountCents: { type: 'number', required: true } },
  scope: 'credit',
  subject: a => `order:${a.orderId}`,
  preconditions: ['credit_within_cap'],
  consequential: true,
  idemKey: a => `credit:${a.orderId}`,
  preview (ctx, args) {
    const capped = Math.min(args.amountCents ?? 0, ctx.policies.goodwill.autoApproveMaxCents)
    return {
      title: 'Issue store credit',
      lines: [
        `${usd(capped)} as a one-off, outside the normal return window`,
        'Valid for 12 months on anything we stock.',
      ],
      irreversible: true,
    }
  },
  execute (ctx, args) {
    // Clamped, never trusted. The cap is policy, and no argument can raise it.
    const amountCents = Math.min(args.amountCents ?? 0, ctx.policies.goodwill.autoApproveMaxCents)
    const code = nextId(ctx, 'CR')
    return {
      kind: 'storeCredit', orderId: args.orderId, code, amountCents,
      expiresAt: new Date(ctx.now + 365 * 86400000).toISOString(),
    }
  },
}

TOOLS.reschedule_delivery = {
  args: { orderId: { type: 'string', required: true }, newDate: { type: 'string', required: true } },
  scope: 'reschedule',
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_in_transit', 'reschedule_date_valid'],
  consequential: true,
  idemKey: a => `resched:${a.orderId}:${a.newDate}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    return {
      title: `Move the delivery on ${o.id}`,
      lines: [`${o.carrier ?? o.fulfillment.carrier} will hold it until ${day(args.newDate)}`],
      irreversible: false,
    }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const iso = new Date(args.newDate).toISOString()
    ctx.db.mutate(s => { s.orders.find(x => x.id === o.id).fulfillment.eta = iso })
    return { kind: 'reschedule', orderId: o.id, newDate: iso, carrier: o.fulfillment.carrier }
  },
}

TOOLS.file_package_claim = {
  args: { orderId: { type: 'string', required: true } },
  scope: 'claim',
  subject: a => `order:${a.orderId}`,
  preconditions: ['order_delivered', 'claim_wait_elapsed'],
  consequential: true,
  idemKey: a => `claim:${a.orderId}`,
  preview (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    return {
      title: `Open a lost-package claim on ${o.id}`,
      lines: [
        `${o.fulfillment.carrier} scanned it as delivered on ${day(o.fulfillment.deliveredAt)}`,
        'We chase the carrier and replace or refund within 5 business days.',
      ],
      irreversible: true,
    }
  },
  execute (ctx, args) {
    const o = ctx.db.getOrder(args.orderId)
    const claimId = nextId(ctx, 'CLAIM')
    ctx.db.mutate(s => { s.orders.find(x => x.id === o.id).claimId = claimId })
    return {
      kind: 'claim', claimId, orderId: o.id,
      carrier: o.fulfillment.carrier, openedAt: new Date(ctx.now).toISOString(),
    }
  },
}

TOOLS.subscribe_restock = {
  args: { sku: { type: 'string', required: true }, email: { type: 'string', required: true } },
  scope: null,
  subject: () => null,
  preconditions: ['sku_out_of_stock'],
  consequential: false,
  idemKey: a => `restock:${a.sku}:${a.email}`,
  preview (ctx, args) {
    return { title: 'Notify me when back in stock', lines: [args.sku], irreversible: false }
  },
  execute (ctx, args) {
    return { kind: 'restockSub', sku: args.sku, email: args.email }
  },
}

/* --------------------------------------------------------------------- checkout */

// A stable signature, so argument order cannot mint two baskets for one request:
// [{B,1},{A,2}] and [{A,2},{B,1}] share a key and the second returns the first's cart.
const sig = items => [...items]
  .map(i => `${String(i.sku).toUpperCase()}:${i.qty}`)
  .sort()
  .join(',')

// The agent builds the basket; it never takes payment. `consequential` is false because in
// this kernel that flag means "halt for a confirm tap", and a basket is reversible — the
// link can simply be ignored. It still writes, which is the point: "your basket is ready"
// is only sayable because a CART record exists to back it.
TOOLS.create_checkout = {
  args: { items: { type: 'array', required: true } },
  scope: null,
  subject: () => null,
  preconditions: ['stock_available'],
  consequential: false,
  idemKey: a => `checkout:${sig(a.items)}`,
  preview (ctx, args) {
    return { title: 'Build a basket', lines: args.items.map(i => `${i.qty} × ${i.sku}`), irreversible: false }
  },
  execute (ctx, args) {
    // Every price is COMPUTED from the product record. A price in args is ignored — the
    // same rule that makes cancel_order compute its own refund.
    const items = args.items.map((line) => {
      const p = ctx.db.getProduct(line.sku)
      return {
        sku: p.sku,
        name: p.name,
        qty: line.qty,
        unitPriceCents: p.priceCents,
        lineTotalCents: p.priceCents * line.qty,
      }
    })
    const subtotalCents = items.reduce((n, i) => n + i.lineTotalCents, 0)
    const cartId = ctx.db.nextId('CART')
    const expiresAt = new Date(ctx.now + brand.checkout.ttlHours * 3600000).toISOString()

    ctx.db.mutate((s) => {
      // One live basket at a time, so an older link cannot be paid after a newer one.
      for (const c of s.carts) if (c.status === 'open') c.status = 'superseded'
      s.carts.push({
        id: cartId, status: 'open', items, subtotalCents, currency: 'USD',
        createdAt: new Date(ctx.now).toISOString(), expiresAt, orderId: null,
      })
    })

    return {
      kind: 'checkout',
      cartId,
      url: `${brand.checkout.path}?id=${cartId}`,
      items,
      subtotalCents,
      currency: 'USD',
      expiresAt,
    }
  },
}

const TICKET_ROUTING = {
  safety: { priority: 'high', queue: 'Gear Safety' },
  billing: { priority: 'high', queue: 'Support' },
  goodwill: { priority: 'normal', queue: 'Returns' },
  fallback_exhausted: { priority: 'normal', queue: 'Support' },
  requested: { priority: 'normal', queue: 'Support' },
}

TOOLS.create_handoff_ticket = {
  args: { reason: { type: 'string', required: true }, summary: { type: 'string' } },
  scope: null,
  subject: () => null,
  preconditions: [],
  consequential: false,
  idemKey: a => `ticket:${a.reason}`,
  preview () {
    return { title: 'Pass this to a person', lines: [], irreversible: false }
  },
  execute (ctx, args) {
    const routing = TICKET_ROUTING[args.reason] ?? TICKET_ROUTING.requested
    return {
      kind: 'ticket',
      ticketId: nextId(ctx, 'TKT'),
      reason: args.reason,
      priority: routing.priority,
      queue: routing.queue,
      tags: [args.reason],
      summary: args.summary ?? null,
      openedAt: new Date(ctx.now).toISOString(),
    }
  },
}
