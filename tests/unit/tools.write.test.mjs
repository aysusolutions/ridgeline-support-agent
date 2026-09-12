import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { TOOLS } from '../../src/kernel/tools.js'
import { PRECONDITIONS } from '../../src/kernel/preconditions.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')
const fresh = () => {
  const db = createDb()
  return { db, policies: db.getPolicies(), now: NOW, seq: { n: 1000 }, sessionId: 'sess-test' }
}

test('cancel_order sets status and is marked irreversible', () => {
  const ctx = fresh()
  const r = TOOLS.cancel_order.execute(ctx, { orderId: 'RO-10850' })
  assert.eq(r.kind, 'cancellation', 'typed kind')
  assert.eq(ctx.db.getOrder('RO-10850').status, 'cancelled', 'state changed')
  assert.eq(TOOLS.cancel_order.preview(ctx, { orderId: 'RO-10850' }).irreversible, true, 'irreversible')
})

test('cancel_order refunds the exact order total, computed not supplied', () => {
  const ctx = fresh()
  const r = TOOLS.cancel_order.execute(ctx, { orderId: 'RO-10850', refundCents: 999999 })
  assert.eq(r.refundCents, 28450, 'ignores any supplied amount')
})

test('preview lines are computed from the record and mention the real total', () => {
  const ctx = fresh()
  const p = TOOLS.cancel_order.preview(ctx, { orderId: 'RO-10850' })
  const text = p.lines.join(' ')
  assert.ok(text.includes('284.50'), 'formatted total present')
  assert.ok(text.includes('4291'), 'payment last4 present')
})

test('change_shipping_address updates the record and reports the new city', () => {
  const ctx = fresh()
  const address = { name: 'Dana Reyes', city: 'Golden', region: 'CO', postal: '80401', country: 'US' }
  const r = TOOLS.change_shipping_address.execute(ctx, { orderId: 'RO-10850', address })
  assert.eq(r.kind, 'addressChange', 'typed kind')
  assert.eq(ctx.db.getOrder('RO-10850').shipTo.city, 'Golden', 'record updated')
})

test('create_return_rma stamps the line and deducts the changed-mind fee', () => {
  const ctx = fresh()
  const r = TOOLS.create_return_rma.execute(ctx,
    { orderId: 'RO-10390', lineItemId: 'L1', reason: 'changedMind' })
  assert.eq(r.kind, 'rma', 'typed kind')
  assert.eq(r.feeCents, 895, 'return shipping deducted for a changed mind')
  assert.eq(r.refundCents, 18005, 'refund is price minus fee, computed')
  assert.eq(ctx.db.getOrder('RO-10390').items.find(i => i.lineId === 'L1').rmaId, r.rmaId, 'line stamped')
})

test('create_return_rma charges no fee for a defective item', () => {
  const ctx = fresh()
  const r = TOOLS.create_return_rma.execute(ctx,
    { orderId: 'RO-10390', lineItemId: 'L1', reason: 'defective' })
  assert.eq(r.feeCents, 0, 'merchant pays')
  assert.eq(r.refundCents, 18900, 'full price back')
})

test('create_return_rma declares the gates that protect it', () => {
  // execute() deliberately does NOT run its own preconditions — the kernel does, once,
  // for every tool. Enforcing them here too would put policy in two places. The
  // behavioural test ("a duplicate RMA is refused") lives in kernel.test.mjs.
  assert.eq(TOOLS.create_return_rma.preconditions,
    ['order_delivered', 'item_returnable', 'no_existing_rma'], 'gates declared')
  assert.eq(TOOLS.create_return_rma.scope, ['return', 'warranty_return'], 'either scope opens it')
})

test('every declared precondition names a predicate that actually exists', () => {
  for (const [name, tool] of Object.entries(TOOLS)) {
    for (const p of tool.preconditions) {
      assert.ok(typeof PRECONDITIONS[p] === 'function', `${name} -> ${p} is a real predicate`)
    }
  }
})

test('create_exchange decrements stock for the reserved variant', () => {
  const ctx = fresh()
  const before = ctx.db.getProduct('JKT-STRM-M').stock
  const r = TOOLS.create_exchange.execute(ctx,
    { orderId: 'RO-10390', lineItemId: 'L1', sku: 'JKT-STRM-M', size: 'L' })
  assert.eq(r.kind, 'exchange', 'typed kind')
  assert.eq(ctx.db.getProduct('JKT-STRM-M').stock, before - 1, 'stock reserved')
})

test('issue_store_credit caps the amount at the policy maximum', () => {
  const ctx = fresh()
  const r = TOOLS.issue_store_credit.execute(ctx, { orderId: 'RO-10908', amountCents: 500000 })
  assert.eq(r.amountCents, 2500, 'clamped to the cap, not trusted from input')
  assert.ok(r.code.startsWith('CR-'), 'credit code issued')
})

test('reschedule_delivery records the new date against the carrier', () => {
  const ctx = fresh()
  const r = TOOLS.reschedule_delivery.execute(ctx, { orderId: 'RO-10482', newDate: '2026-08-06' })
  assert.eq(r.kind, 'reschedule', 'typed kind')
  assert.eq(r.carrier, 'UPS', 'carrier from the record')
  assert.eq(ctx.db.getOrder('RO-10482').fulfillment.eta.slice(0, 10), '2026-08-06', 'eta moved')
})

test('file_package_claim opens a claim against the carrier', () => {
  const ctx = fresh()
  const r = TOOLS.file_package_claim.execute(ctx, { orderId: 'RO-10221' })
  assert.eq(r.kind, 'claim', 'typed kind')
  assert.ok(r.claimId.startsWith('CLAIM-'), 'claim id issued')
})

test('subscribe_restock only applies to an out-of-stock sku', () => {
  const ctx = fresh()
  const r = TOOLS.subscribe_restock.execute(ctx, { sku: 'LIN-SILK-R', email: 'a@b.com' })
  assert.eq(r.kind, 'restockSub', 'typed kind')
  assert.eq(TOOLS.subscribe_restock.consequential, false, 'reversible, no confirmation')
})

test('create_handoff_ticket sets priority and queue from the reason', () => {
  const ctx = fresh()
  const r = TOOLS.create_handoff_ticket.execute(ctx, { reason: 'safety' })
  assert.eq(r.kind, 'ticket', 'typed kind')
  assert.eq(r.priority, 'high', 'safety escalates')
  assert.ok(r.ticketId.startsWith('TKT-'), 'ticket id issued')
})

test('every write tool declares an idempotency key template', () => {
  const writes = ['cancel_order', 'change_shipping_address', 'create_return_rma', 'create_exchange',
                  'issue_store_credit', 'reschedule_delivery', 'file_package_claim',
                  'subscribe_restock', 'create_handoff_ticket']
  for (const name of writes) assert.ok(TOOLS[name].idemKey, `${name} has an idem key`)
})

test('the consequential flag matches the spec exactly', () => {
  const expected = {
    cancel_order: true, change_shipping_address: true, create_return_rma: true, create_exchange: true,
    issue_store_credit: true, reschedule_delivery: true, file_package_claim: true,
    subscribe_restock: false, create_handoff_ticket: false,
    lookup_order: false, search_products: false, get_policy: false, search_faq: false,
    compare_products: false,
  }
  for (const [name, flag] of Object.entries(expected)) {
    assert.eq(TOOLS[name].consequential, flag, `${name} consequential`)
  }
})

test('the registry holds exactly the fifteen specced tools', () => {
  assert.eq(Object.keys(TOOLS).sort(), [
    'cancel_order', 'change_shipping_address', 'compare_products', 'create_checkout',
    'create_exchange', 'create_handoff_ticket', 'create_return_rma', 'file_package_claim',
    'get_policy', 'issue_store_credit', 'lookup_order', 'reschedule_delivery', 'search_faq',
    'search_products', 'subscribe_restock',
  ], 'tool catalogue')
})

test('every consequential tool has a preview that names its irreversibility', () => {
  const ctx = fresh()
  const cases = {
    cancel_order: { orderId: 'RO-10850' },
    change_shipping_address: { orderId: 'RO-10850',
      address: { name: 'D', city: 'Golden', region: 'CO', postal: '80401', country: 'US' } },
    create_return_rma: { orderId: 'RO-10390', lineItemId: 'L1', reason: 'changedMind' },
    create_exchange: { orderId: 'RO-10390', lineItemId: 'L1', sku: 'JKT-STRM-M', size: 'L' },
    issue_store_credit: { orderId: 'RO-10908', amountCents: 1995 },
    reschedule_delivery: { orderId: 'RO-10482', newDate: '2026-08-06' },
    file_package_claim: { orderId: 'RO-10221' },
  }
  for (const [name, args] of Object.entries(cases)) {
    const p = TOOLS[name].preview(ctx, args)
    assert.ok(p.title.length > 0, `${name} preview has a title`)
    assert.ok(p.lines.length > 0, `${name} preview has lines`)
    assert.eq(typeof p.irreversible, 'boolean', `${name} declares reversibility`)
  }
})
