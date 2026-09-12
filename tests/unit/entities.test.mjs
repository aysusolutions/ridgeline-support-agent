import { test, assert } from '../harness.mjs'
import { extractEntities } from '../../src/planner/entities.js'
import { bestMatch } from '../../src/planner/fuzzy.js'

const known = {
  orderIds: ['RO-10482', 'RO-10390', 'RO-10850'],
  skus: ['TNT-ASPN-2', 'BAG-SUMT-20'],
}

test('an order id is extracted in any casing and normalised', () => {
  assert.eq(extractEntities('where is ro-10482', known).orderIds, ['RO-10482'], 'upcased')
  assert.eq(extractEntities('RO 10482 please', known).orderIds, ['RO-10482'], 'space separator')
})

test('a bare order number is expanded only when it matches a known id', () => {
  assert.eq(extractEntities('order 10390 please', known).orderIds, ['RO-10390'], 'prefix inferred')
  assert.eq(extractEntities('order 99999 please', known).orderIds, [], 'unknown bare number ignored')
})

test('an email is extracted and lowercased', () => {
  assert.eq(extractEntities('it is Dana.Reyes@Example.com', known).emails,
    ['dana.reyes@example.com'], 'email')
})

test('an unknown but well-formed order id is still extracted so did-you-mean can run', () => {
  assert.eq(extractEntities('RO-10483', known).orderIds, ['RO-10483'], 'extracted even if unknown')
})

test('a known sku is extracted and an invented one is not', () => {
  assert.eq(extractEntities('do you have TNT-ASPN-2', known).skus, ['TNT-ASPN-2'], 'known')
  assert.eq(extractEntities('do you have ZZZ-FAKE-9', known).skus, [], 'unknown dropped')
})

test('dates and money are extracted in normalised form', () => {
  const e = extractEntities('deliver on 2026-08-06 and refund $18.95', known)
  assert.eq(e.dates, ['2026-08-06'], 'iso date')
  assert.eq(e.amounts, [1895], 'money in cents')
})

test('duplicates collapse', () => {
  assert.eq(extractEntities('RO-10482 and again RO-10482', known).orderIds, ['RO-10482'], 'once')
})

test('nothing is extracted from empty or unrelated text', () => {
  const e = extractEntities('hello there', known)
  assert.eq([e.orderIds, e.emails, e.skus, e.dates, e.amounts], [[], [], [], [], []], 'all empty')
})

test('bestMatch offers the nearest known id for a typo', () => {
  const m = bestMatch('RO-10483', known.orderIds)
  assert.eq(m.value, 'RO-10482', 'nearest')
  assert.ok(m.score > 0.8, 'confident')
})

test('bestMatch does not offer a suggestion for something unrelated', () => {
  assert.ok(bestMatch('ZZ-00001', known.orderIds).score < 0.6, 'no false suggestion')
})
