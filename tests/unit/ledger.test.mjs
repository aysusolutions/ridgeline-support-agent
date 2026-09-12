import { test, assert } from '../harness.mjs'
import { createLedger } from '../../src/kernel/ledger.js'

const entry = (over = {}) => ({
  idemKey: 'rma:RO-10390:L1',
  tool: 'create_return_rma',
  args: { orderId: 'RO-10390', lineItemId: 'L1' },
  result: { rmaId: 'RMA-1001' },
  at: '2026-08-01T15:00:00Z',
  ...over,
})

test('append assigns a monotonic seq', () => {
  const l = createLedger()
  assert.eq(l.append(entry()).seq, 0, 'first is zero')
  assert.eq(l.append(entry({ idemKey: 'b' })).seq, 1, 'second is one')
})

test('appended entries are frozen', () => {
  const l = createLedger()
  const e = l.append(entry())
  assert.throwsWith(() => { e.result.rmaId = 'RMA-HACK' }, TypeError)
})

test('the caller cannot mutate an entry through the object it passed in', () => {
  const l = createLedger()
  const passed = entry()
  l.append(passed)
  passed.result.rmaId = 'RMA-HACK'
  assert.eq(l.findByKey('rma:RO-10390:L1').result.rmaId, 'RMA-1001', 'stored copy is independent')
})

test('findByKey returns the prior entry for a replayed key', () => {
  const l = createLedger()
  l.append(entry())
  assert.eq(l.findByKey('rma:RO-10390:L1').result, { rmaId: 'RMA-1001' }, 'replay hit')
})

test('findByKey returns null for an unseen key', () => {
  assert.eq(createLedger().findByKey('nope'), null, 'miss')
})

test('a replayed key keeps the FIRST entry, not the newest', () => {
  const l = createLedger()
  l.append(entry())
  l.append(entry({ result: { rmaId: 'RMA-SECOND' } }))
  assert.eq(l.findByKey('rma:RO-10390:L1').result.rmaId, 'RMA-1001', 'first wins')
})

test('since returns only entries after the given seq', () => {
  const l = createLedger()
  l.append(entry()); l.append(entry({ idemKey: 'b' })); l.append(entry({ idemKey: 'c' }))
  assert.eq(l.since(1).map(e => e.idemKey), ['c'], 'tail only')
})

test('entries returns a copy, so the log cannot be truncated from outside', () => {
  const l = createLedger()
  l.append(entry())
  l.entries().length = 0
  assert.eq(l.entries().length, 1, 'log intact')
})

test('an entry with no idempotency key is logged but not indexed', () => {
  const l = createLedger()
  l.append(entry({ idemKey: null }))
  assert.eq(l.entries().length, 1, 'logged')
  assert.eq(l.findByKey(null), null, 'not indexed')
})
