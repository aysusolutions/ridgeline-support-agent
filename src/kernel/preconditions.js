import { brand } from '../config/brand.js'

const DAY = 86400000
const HOUR = 3600000
const MONTH = 30.44 * DAY

// Every predicate is pure over (record, args, policies, now). Reason codes are stable
// and user-safe: templates in dialog/templates.js key off them, so they must not change
// casually.
export class PreconditionFailed extends Error {
  constructor (reason, detail = {}) {
    super(reason)
    this.name = 'PreconditionFailed'
    this.reason = reason
    this.detail = detail
  }
}

const lineOf = ({ order, args }) => order?.items.find(i => i.lineId === args.lineItemId)

export function daysPastWindow (order, policies, now) {
  const age = Math.floor((now - Date.parse(order.fulfillment.deliveredAt)) / DAY)
  return age - policies.returnWindowDays
}

export const PRECONDITIONS = {
  order_unshipped ({ order }) {
    if (order.fulfillment.shippedAt) throw new PreconditionFailed('ALREADY_SHIPPED')
  },

  order_in_transit ({ order }) {
    if (order.status !== 'in_transit') throw new PreconditionFailed('NOT_IN_TRANSIT')
  },

  order_delivered ({ order }) {
    if (order.status !== 'delivered') throw new PreconditionFailed('NOT_DELIVERED')
  },

  // Dates are COMPUTED and handed to the template, never pasted from policy prose.
  within_return_window ({ order, policies, now }) {
    const past = daysPastWindow(order, policies, now)
    if (past > 0) {
      throw new PreconditionFailed('OUTSIDE_RETURN_WINDOW', {
        deliveredAt: order.fulfillment.deliveredAt,
        closedAt: new Date(
          Date.parse(order.fulfillment.deliveredAt) + policies.returnWindowDays * DAY).toISOString(),
        daysPast: past,
      })
    }
  },

  item_returnable (c) {
    const item = lineOf(c)
    if (!item) throw new PreconditionFailed('NO_SUCH_LINE')
    if (item.finalSale) throw new PreconditionFailed('FINAL_SALE')
    if (!item.returnable) throw new PreconditionFailed('NOT_RETURNABLE')
  },

  no_existing_rma (c) {
    const item = lineOf(c)
    if (item?.rmaId) throw new PreconditionFailed('RMA_EXISTS', { rmaId: item.rmaId })
  },

  within_warranty (c) {
    const item = lineOf(c)
    if (!item) throw new PreconditionFailed('NO_SUCH_LINE')
    if (!item.defective) throw new PreconditionFailed('NOT_DEFECTIVE')
    const months = (c.now - Date.parse(c.order.fulfillment.deliveredAt)) / MONTH
    if (months > c.policies.warrantyMonths) {
      throw new PreconditionFailed('OUTSIDE_WARRANTY', { monthsOld: Math.floor(months) })
    }
  },

  claim_wait_elapsed ({ order, policies, now }) {
    const waited = now - Date.parse(order.fulfillment.deliveredAt)
    const required = policies.missingPackageWaitHours * HOUR
    if (waited < required) {
      throw new PreconditionFailed('WAIT_NOT_ELAPSED', {
        hoursRemaining: Math.ceil((required - waited) / HOUR),
      })
    }
  },

  reschedule_date_valid ({ args, policies, now }) {
    const target = Date.parse(args.newDate)
    if (Number.isNaN(target)) throw new PreconditionFailed('BAD_DATE')
    if (target < now) throw new PreconditionFailed('DATE_IN_PAST')
    if (target > now + policies.rescheduleMaxDaysAhead * DAY) {
      throw new PreconditionFailed('DATE_TOO_FAR', { maxDays: policies.rescheduleMaxDaysAhead })
    }
  },

  variant_in_stock ({ product, args }) {
    if (!product) throw new PreconditionFailed('NO_SUCH_SKU')
    if (product.stock <= 0) throw new PreconditionFailed('OUT_OF_STOCK')
    if (args?.size && !product.attrs.sizes.includes(args.size)) {
      throw new PreconditionFailed('NO_SUCH_VARIANT', { available: product.attrs.sizes })
    }
  },

  // Basket lines. The kernel resolves a single `sku` argument for us; this tool carries a
  // LIST, so the lines are resolved here. Every figure in the refusal comes from the
  // record — the model is never the source of "there are only 4 left".
  stock_available ({ db, args }) {
    const lines = Array.isArray(args.items) ? args.items : []
    if (!lines.length) throw new PreconditionFailed('EMPTY_BASKET')
    const cap = brand.checkout.maxQtyPerLine

    for (const line of lines) {
      const product = db.getProduct(line?.sku)
      if (!product) throw new PreconditionFailed('NO_SUCH_SKU')

      const qty = Number(line.qty)
      if (!Number.isInteger(qty) || qty < 1) throw new PreconditionFailed('BAD_QUANTITY')

      // Zero stock is its own answer BEFORE the over-stock one. "There are only 0 left"
      // is not a reply — out of stock is, and it comes with a restock offer.
      if (product.stock <= 0) throw new PreconditionFailed('OUT_OF_STOCK', { sku: product.sku })
      if (qty > cap) throw new PreconditionFailed('OVER_LINE_CAP', { max: cap })
      if (qty > product.stock) {
        throw new PreconditionFailed('OVER_STOCK', { available: product.stock, name: product.name })
      }
    }
  },

  sku_out_of_stock ({ product }) {
    if (!product) throw new PreconditionFailed('NO_SUCH_SKU')
    if (product.stock > 0) throw new PreconditionFailed('ALREADY_IN_STOCK')
  },

  credit_within_cap ({ args, policies }) {
    if (args.amountCents > policies.goodwill.autoApproveMaxCents) {
      throw new PreconditionFailed('ABOVE_GOODWILL_CAP', {
        capCents: policies.goodwill.autoApproveMaxCents,
      })
    }
  },

  address_well_formed ({ args }) {
    const a = args.address ?? {}
    for (const f of ['name', 'city', 'region', 'postal', 'country']) {
      if (!a[f] || String(a[f]).trim().length < 2) {
        throw new PreconditionFailed('INCOMPLETE_ADDRESS', { field: f })
      }
    }
    if (!/^[A-Za-z0-9 -]{3,10}$/.test(a.postal)) throw new PreconditionFailed('BAD_POSTAL')
  },
}

// Bounded authority. The `credit` scope is minted ONLY here — never by scopeForOrder —
// and only when both the value and the age fall inside the band. Outside it there is no
// code path that grants it, which is why no amount of persuasion moves the boundary.
export function evaluateGoodwill (order, item, policies, now) {
  const past = daysPastWindow(order, policies, now)
  if (past <= 0) return { eligible: false, amountCents: 0, reason: 'STILL_IN_WINDOW' }
  if (past > policies.goodwill.autoApproveMaxDaysPastWindow) {
    return { eligible: false, amountCents: 0, reason: 'TOO_LONG_PAST_WINDOW', daysPast: past }
  }
  if (item.unitPriceCents > policies.goodwill.autoApproveMaxCents) {
    return { eligible: false, amountCents: 0, reason: 'ABOVE_CAP' }
  }
  return { eligible: true, amountCents: item.unitPriceCents, reason: 'AUTO_APPROVED', daysPast: past }
}
