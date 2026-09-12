import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { TOOLS } from '../../src/kernel/tools.js'
import { isTainted, labelsOf, LABELS } from '../../src/shared/taint.js'

const db = createDb()
const ctx = { db, policies: db.getPolicies(), now: Date.parse('2026-08-01T15:00:00Z'), seq: { n: 1000 } }

test('lookup_order returns a typed result, not prose', () => {
  const r = TOOLS.lookup_order.execute(ctx, { orderId: 'RO-10482' })
  assert.eq(r.kind, 'order', 'typed kind')
  assert.eq(r.id, 'RO-10482', 'id present')
  assert.eq(r.stage, 'On the way', 'derived stage')
})

test('lookup_order keeps untrusted free text flagged inside the typed result', () => {
  const r = TOOLS.lookup_order.execute(ctx, { orderId: 'RO-10221' })
  assert.eq(isTainted(r.giftMessage), true, 'still tainted')
  assert.eq(labelsOf(r.giftMessage), [LABELS.UNTRUSTED], 'label preserved through the tool')
})

test('lookup_order declares subject and read scope', () => {
  assert.eq(TOOLS.lookup_order.subject({ orderId: 'RO-10482' }), 'order:RO-10482', 'subject')
  assert.eq(TOOLS.lookup_order.scope, 'read', 'scope')
  assert.eq(TOOLS.lookup_order.consequential, false, 'read tools never confirm')
})

test('search_products needs no capability and keeps blurbs tainted', () => {
  const r = TOOLS.search_products.execute(ctx, { filters: { category: 'sleeping-bags' } })
  assert.eq(TOOLS.search_products.subject({}), null, 'no subject')
  assert.eq(r.kind, 'productList', 'typed kind')
  assert.eq(r.items.length, 3, 'top three, not the whole category')
  assert.ok(r.items.every(p => p.category === 'sleeping-bags'), 'filter applied')
  assert.eq(isTainted(r.items[0].blurb), true, 'blurb stays tainted')
})

test('search_products never dead-ends, and says what it relaxed', () => {
  const r = TOOLS.search_products.execute(ctx, {
    filters: { category: 'tents', colors: 'Ember' },     // no Ember tent exists
    weights: { category: 1, colors: 0.2 },
  })
  assert.ok(r.items.length > 0, 'still returns products')
  assert.ok(r.relaxed.includes('colors'), 'and reports the dropped constraint')
})

test('get_policy rejects a key that is not in policies.json', () => {
  assert.eq(TOOLS.get_policy.execute(ctx, { key: 'returnWindowDays' }).value, 30, 'known key')
  assert.eq(TOOLS.get_policy.execute(ctx, { key: 'refundEverything' }).value, null, 'unknown key is null')
})

test('get_policy cannot be used to read arbitrary object properties', () => {
  assert.eq(TOOLS.get_policy.execute(ctx, { key: 'constructor' }).value, null, 'no prototype walk')
  assert.eq(TOOLS.get_policy.execute(ctx, { key: '__proto__' }).value, null, 'no proto access')
})

test('search_faq returns scored entries with ids for citation', () => {
  const r = TOOLS.search_faq.execute(ctx, { query: 'how long do I have to return something' })
  assert.eq(r.kind, 'faqList', 'typed kind')
  assert.eq(r.items[0].id, 'faq-return-window', 'right entry first')
  assert.ok(r.items[0].score > 0.3, 'entry is scored')
})

test('search_faq matches on an alias, not just the question', () => {
  const r = TOOLS.search_faq.execute(ctx, { query: 'notify me when available' })
  assert.eq(r.items[0].id, 'faq-restock', 'alias hit')
})

test('search_faq returns nothing rather than a bad match for an unrelated query', () => {
  assert.eq(TOOLS.search_faq.execute(ctx, { query: 'kayak paddle rental' }).items.length, 0, 'no match')
})

test('compare_products computes which product wins each differing attribute', () => {
  const r = TOOLS.compare_products.execute(ctx, { skus: ['BAG-SUMT-20', 'BAG-RDGE-30'] })
  assert.eq(r.kind, 'comparison', 'typed kind')
  const temp = r.differences.find(d => d.attribute === 'tempRatingC')
  assert.eq(temp.winner, 'BAG-SUMT-20', 'lower temp rating is the warmer bag and wins')
  assert.eq(temp.delta, 6, 'delta computed, not described')
})

test('compare_products reads direction from config, not from the model', () => {
  const r = TOOLS.compare_products.execute(ctx, { skus: ['JKT-STRM-M', 'JKT-LITE-M'] })
  assert.eq(r.differences.find(d => d.attribute === 'weightGrams').direction, 'lower', 'lighter wins')
  assert.eq(r.differences.find(d => d.attribute === 'waterproofRating').direction, 'higher', 'drier wins')
  assert.eq(r.differences.find(d => d.attribute === 'weightGrams').winner, 'JKT-LITE-M', 'lighter jacket')
})

test('compare_products names the cheapest so the agent can recommend downward', () => {
  const r = TOOLS.compare_products.execute(ctx, { skus: ['BAG-SUMT-20', 'BAG-RDGE-30'] })
  assert.eq(r.cheapest, 'BAG-RDGE-30', 'cheapest identified')
  assert.ok(r.whyNotCheaper['BAG-SUMT-20'], 'honest note carried through')
})

test('compare_products refuses an unknown sku rather than comparing against nothing', () => {
  assert.throwsWith(() => TOOLS.compare_products.execute(ctx, { skus: ['BAG-SUMT-20', 'NOPE-1'] }),
    Error, 'NOPE-1')
})

test('identical attributes land in shared, not in differences', () => {
  const r = TOOLS.compare_products.execute(ctx, { skus: ['BAG-SUMT-20', 'BAG-RDGE-30'] })
  const overlap = r.differences.filter(d => r.shared.includes(d.attribute))
  assert.eq(overlap, [], 'disjoint sets')
  assert.ok(r.shared.includes('seasons'), 'both are 3-season')
})
