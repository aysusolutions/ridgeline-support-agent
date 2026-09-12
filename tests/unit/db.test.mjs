import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { LABELS, labelsOf, unwrap, isTainted } from '../../src/shared/taint.js'

const db = () => createDb()

test('getOrder returns a deep copy — mutating it does not affect the store', () => {
  const d = db()
  const a = d.getOrder('RO-10850')
  a.status = 'cancelled'
  assert.eq(d.getOrder('RO-10850').status, 'processing', 'store is isolated')
})

test('structured fields are plain, not tainted', () => {
  const o = db().getOrder('RO-10850')
  assert.eq(isTainted(o.status), false, 'status is plain')
  assert.eq(o.items[0].unitPriceCents, 24900, 'price is a plain number')
})

test('giftMessage comes back labelled UNTRUSTED', () => {
  const o = db().getOrder('RO-10221')
  assert.eq(labelsOf(o.giftMessage), [LABELS.UNTRUSTED], 'gift message is untrusted')
  assert.ok(unwrap(o.giftMessage).includes('ignore all previous instructions'), 'payload intact')
})

test('a null giftMessage stays null rather than becoming a tainted null', () => {
  assert.eq(db().getOrder('RO-10850').giftMessage, null, 'null passthrough')
})

test('product review and blurb come back labelled UNTRUSTED', () => {
  const p = db().getProduct('BAG-SUMT-20')
  assert.eq(labelsOf(p.review), [LABELS.UNTRUSTED], 'review is untrusted')
  assert.eq(labelsOf(p.blurb), [LABELS.UNTRUSTED], 'blurb is untrusted')
  assert.ok(unwrap(p.review).includes('im_start'), 'poisoned review intact')
})

test('mutate is the only write path and is visible in snapshot', () => {
  const d = db()
  const before = d.snapshot()
  d.mutate(s => { s.orders.find(o => o.id === 'RO-10850').status = 'cancelled' })
  assert.eq(before.orders.find(o => o.id === 'RO-10850').status, 'processing', 'snapshot frozen in time')
  assert.eq(d.getOrder('RO-10850').status, 'cancelled', 'mutation applied')
})

test('listOrderIds returns all ten seeded ids', () => {
  assert.eq(db().listOrderIds().length, 10, 'ten orders')
})

test('listSkus returns all eighteen seeded products', () => {
  assert.eq(db().listSkus().length, 18, 'eighteen products')
})

test('reset restores the seed', () => {
  const d = db()
  d.mutate(s => { s.orders.find(o => o.id === 'RO-10850').status = 'cancelled' })
  d.reset()
  assert.eq(d.getOrder('RO-10850').status, 'processing', 'reseeded')
})

test('findOrderByEmail is case insensitive and returns only that customer', () => {
  const found = db().findOrderByEmail('DANA.REYES@EXAMPLE.COM')
  assert.eq(found.length, 1, 'one order')
  assert.eq(found[0].id, 'RO-10850', 'right order')
})

test('searchProducts filters by category, price and stock', () => {
  const d = db()
  assert.eq(d.searchProducts({ category: 'boots' }).length, 3, 'three boots')
  assert.ok(d.searchProducts({ maxPriceCents: 5000 }).every(p => p.priceCents <= 5000), 'price filter')
  assert.ok(d.searchProducts({ inStock: false }).every(p => p.stock === 0), 'out of stock only')
})

test('an unknown order or sku returns null rather than throwing', () => {
  assert.eq(db().getOrder('RO-00000'), null, 'unknown order')
  assert.eq(db().getProduct('NOPE-1'), null, 'unknown sku')
})

test('every order item references a real sku with a matching price', () => {
  const d = db()
  for (const id of d.listOrderIds()) {
    for (const item of d.getOrder(id).items) {
      const p = d.getProduct(item.sku)
      assert.ok(p, `${id} ${item.lineId} references a real sku (${item.sku})`)
      assert.eq(item.unitPriceCents, p.priceCents, `${id} ${item.lineId} price matches the catalogue`)
    }
  }
})

test('every order total equals the sum of its line items plus shipping', () => {
  const d = db()
  for (const id of d.listOrderIds()) {
    const o = d.getOrder(id)
    const sum = o.items.reduce((a, i) => a + i.unitPriceCents * i.qty, 0)
    assert.eq(o.totals.subtotalCents, sum, `${id} subtotal`)
    assert.eq(o.totals.totalCents,
      o.totals.subtotalCents + o.totals.shippingCents + o.totals.taxCents - o.totals.discountCents,
      `${id} total`)
  }
})

test('every faq cites a policy key that exists, or none at all', () => {
  const d = db()
  const policies = d.getPolicies()
  for (const f of d.faqs()) {
    if (f.sourcePolicy === null) continue
    assert.ok(Object.prototype.hasOwnProperty.call(policies, f.sourcePolicy),
      `${f.id} cites a real policy key (${f.sourcePolicy})`)
  }
})

test('every faq related id points at a real entry', () => {
  const d = db()
  const ids = new Set(d.faqs().map(f => f.id))
  for (const f of d.faqs()) {
    for (const r of f.related) assert.ok(ids.has(r), `${f.id} -> ${r} exists`)
  }
})
