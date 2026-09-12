import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import {
  PRECONDITIONS, PreconditionFailed, evaluateGoodwill, daysPastWindow,
} from '../../src/kernel/preconditions.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')
const db = createDb()
const P = db.getPolicies()

const ctx = (orderId, over = {}) => ({
  order: db.getOrder(orderId), product: null, policies: P, now: NOW, args: {}, ...over,
})

test('order_unshipped passes for a processing order', () => {
  PRECONDITIONS.order_unshipped(ctx('RO-10850'))
})

test('order_unshipped fails once shipped, with a stable reason code', () => {
  let err = null
  try { PRECONDITIONS.order_unshipped(ctx('RO-10482')) } catch (e) { err = e }
  assert.ok(err instanceof PreconditionFailed, 'threw')
  assert.eq(err.reason, 'ALREADY_SHIPPED', 'reason code')
})

test('order_in_transit fails on an unshipped order', () => {
  assert.throwsWith(() => PRECONDITIONS.order_in_transit(ctx('RO-10850')),
    PreconditionFailed, 'NOT_IN_TRANSIT')
})

test('within_return_window passes 6 days after delivery', () => {
  PRECONDITIONS.within_return_window(ctx('RO-10390'))
})

test('within_return_window fails 46 days after delivery and reports computed dates', () => {
  let err = null
  try { PRECONDITIONS.within_return_window(ctx('RO-10515')) } catch (e) { err = e }
  assert.eq(err.reason, 'OUTSIDE_RETURN_WINDOW', 'reason')
  assert.eq(err.detail.daysPast, 16, 'days past computed, not pasted')
  assert.eq(err.detail.closedAt.slice(0, 10), '2026-07-16', 'window close date computed')
})

test('item_returnable rejects a final-sale line', () => {
  const c = ctx('RO-10733')
  c.args = { lineItemId: c.order.items.find(i => i.finalSale).lineId }
  assert.throwsWith(() => PRECONDITIONS.item_returnable(c), PreconditionFailed, 'FINAL_SALE')
})

test('item_returnable passes for the non-final-sale line on the same order', () => {
  const c = ctx('RO-10733')
  c.args = { lineItemId: 'L2' }
  PRECONDITIONS.item_returnable(c)
})

test('item_returnable rejects a line that does not exist', () => {
  const c = ctx('RO-10390')
  c.args = { lineItemId: 'L99' }
  assert.throwsWith(() => PRECONDITIONS.item_returnable(c), PreconditionFailed, 'NO_SUCH_LINE')
})

test('no_existing_rma rejects a line that already has one', () => {
  const c = ctx('RO-10119')
  c.args = { lineItemId: c.order.items.find(i => i.rmaId).lineId }
  assert.throwsWith(() => PRECONDITIONS.no_existing_rma(c), PreconditionFailed, 'RMA_EXISTS')
})

test('claim_wait_elapsed fails inside the 24-hour window', () => {
  const c = ctx('RO-10221', { now: Date.parse('2026-07-30T20:00:00Z') })
  assert.throwsWith(() => PRECONDITIONS.claim_wait_elapsed(c), PreconditionFailed, 'WAIT_NOT_ELAPSED')
})

test('claim_wait_elapsed passes after 24 hours', () => {
  PRECONDITIONS.claim_wait_elapsed(ctx('RO-10221'))
})

test('within_warranty passes for a defective item six months old', () => {
  const c = ctx('RO-10477')
  c.args = { lineItemId: 'L1' }
  PRECONDITIONS.within_warranty(c)
})

test('within_warranty rejects a line that is not flagged defective', () => {
  const c = ctx('RO-10390')
  c.args = { lineItemId: 'L1' }
  assert.throwsWith(() => PRECONDITIONS.within_warranty(c), PreconditionFailed, 'NOT_DEFECTIVE')
})

test('reschedule_date_valid rejects a past date and one beyond the carrier window', () => {
  assert.throwsWith(
    () => PRECONDITIONS.reschedule_date_valid(ctx('RO-10482', { args: { newDate: '2026-07-01' } })),
    PreconditionFailed, 'DATE_IN_PAST')
  assert.throwsWith(
    () => PRECONDITIONS.reschedule_date_valid(ctx('RO-10482', { args: { newDate: '2026-09-30' } })),
    PreconditionFailed, 'DATE_TOO_FAR')
  PRECONDITIONS.reschedule_date_valid(ctx('RO-10482', { args: { newDate: '2026-08-06' } }))
})

test('address_well_formed rejects an incomplete address and names the field', () => {
  let err = null
  try {
    PRECONDITIONS.address_well_formed(ctx('RO-10850', {
      args: { address: { name: 'Dana Reyes', city: '', region: 'CO', postal: '80301', country: 'US' } },
    }))
  } catch (e) { err = e }
  assert.eq(err.reason, 'INCOMPLETE_ADDRESS', 'reason')
  assert.eq(err.detail.field, 'city', 'names the missing field')
})

test('sku_out_of_stock passes only when stock is actually zero', () => {
  PRECONDITIONS.sku_out_of_stock({ product: db.getProduct('LIN-SILK-R') })
  assert.throwsWith(() => PRECONDITIONS.sku_out_of_stock({ product: db.getProduct('TNT-ASPN-2') }),
    PreconditionFailed, 'ALREADY_IN_STOCK')
})

test('variant_in_stock rejects an unknown size', () => {
  assert.throwsWith(
    () => PRECONDITIONS.variant_in_stock({ product: db.getProduct('JKT-STRM-M'), args: { size: 'XXXL' } }),
    PreconditionFailed, 'NO_SUCH_VARIANT')
  PRECONDITIONS.variant_in_stock({ product: db.getProduct('JKT-STRM-M'), args: { size: 'L' } })
})

test('daysPastWindow is negative inside the window and positive outside it', () => {
  assert.eq(daysPastWindow(db.getOrder('RO-10390'), P, NOW) < 0, true, 'inside')
  assert.eq(daysPastWindow(db.getOrder('RO-10908'), P, NOW), 8, 'eight days past')
  assert.eq(daysPastWindow(db.getOrder('RO-10515'), P, NOW), 16, 'sixteen days past')
})

test('goodwill auto-approves inside the band and computes the amount from the record', () => {
  const o = db.getOrder('RO-10908')
  const r = evaluateGoodwill(o, o.items[0], P, NOW)
  assert.eq(r.eligible, true, 'inside band')
  assert.eq(r.amountCents, o.items[0].unitPriceCents, 'amount from the record, not from input')
  assert.eq(r.reason, 'AUTO_APPROVED', 'reason')
})

test('goodwill refuses outside the day band', () => {
  const o = db.getOrder('RO-10515')
  const r = evaluateGoodwill(o, o.items[0], P, NOW)
  assert.eq(r.eligible, false, 'too many days past window')
  assert.eq(r.reason, 'TOO_LONG_PAST_WINDOW', 'reason')
})

test('goodwill refuses above the value cap even inside the day band', () => {
  const o = db.getOrder('RO-10908')
  const pricey = { ...o.items[0], unitPriceCents: 9900 }
  const r = evaluateGoodwill(o, pricey, P, NOW)
  assert.eq(r.eligible, false, 'over the cap')
  assert.eq(r.reason, 'ABOVE_CAP', 'reason')
})

test('goodwill refuses while the order is still inside the return window', () => {
  const o = db.getOrder('RO-10390')
  assert.eq(evaluateGoodwill(o, o.items[0], P, NOW).reason, 'STILL_IN_WINDOW', 'use a return instead')
})
