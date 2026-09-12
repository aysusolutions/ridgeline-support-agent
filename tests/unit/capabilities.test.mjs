import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { scopeForOrder, verifyOwnership, createGrantSet } from '../../src/kernel/capabilities.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')
const clock = () => NOW
const db = createDb()
const P = db.getPolicies()

test('an unshipped order grants cancel and change_address', () => {
  assert.eq(scopeForOrder(db.getOrder('RO-10850'), P, NOW).sort(),
    ['cancel', 'change_address', 'read'], 'processing scopes')
})

test('an in-transit order grants reschedule but never cancel', () => {
  const s = scopeForOrder(db.getOrder('RO-10482'), P, NOW)
  assert.eq(s.includes('reschedule'), true, 'reschedule granted')
  assert.eq(s.includes('cancel'), false, 'cancel withheld once shipped')
})

test('delivered inside the window grants return and exchange', () => {
  const s = scopeForOrder(db.getOrder('RO-10390'), P, NOW)
  assert.eq(s.includes('return'), true, 'return granted')
  assert.eq(s.includes('exchange'), true, 'exchange granted')
})

test('delivered past the window withholds return but keeps claim', () => {
  const s = scopeForOrder(db.getOrder('RO-10515'), P, NOW)
  assert.eq(s.includes('return'), false, 'no return past window')
  assert.eq(s.includes('claim'), true, 'claim still available')
})

test('a defective item inside warranty grants warranty_return even past the window', () => {
  const s = scopeForOrder(db.getOrder('RO-10477'), P, NOW)
  assert.eq(s.includes('warranty_return'), true, 'warranty path open')
  assert.eq(s.includes('return'), false, 'ordinary return still closed')
})

test('credit is never minted by scopeForOrder, for any order', () => {
  for (const id of db.listOrderIds()) {
    assert.eq(scopeForOrder(db.getOrder(id), P, NOW).includes('credit'), false, `no credit for ${id}`)
  }
})

test('scopeForOrder on a null order returns no scopes rather than throwing', () => {
  assert.eq(scopeForOrder(null, P, NOW), [], 'empty')
})

test('verifyOwnership succeeds on an exact email match', () => {
  const r = verifyOwnership(db, 'RO-10850', 'dana.reyes@example.com', NOW)
  assert.eq(r.ok, true, 'verified')
  assert.eq(r.grant.subject, 'order:RO-10850', 'subject bound')
  assert.eq(r.grant.value, 'RO-10850', 'kernel holds the value, not the model')
})

test('verifyOwnership is case insensitive on both the id and the email', () => {
  assert.eq(verifyOwnership(db, 'ro-10850', 'DANA.REYES@example.com', NOW).ok, true, 'normalised')
})

test('mismatch and not-found are indistinguishable', () => {
  const mismatch = verifyOwnership(db, 'RO-10850', 'attacker@example.com', NOW)
  const missing = verifyOwnership(db, 'RO-00000', 'attacker@example.com', NOW)
  assert.eq(mismatch, missing, 'identical result, no enumeration oracle')
  assert.eq(mismatch.ok, false, 'both refused')
  assert.eq(Object.keys(mismatch), ['ok'], 'no reason field to leak which it was')
})

test('a grant set answers has() only for the exact subject and scope', () => {
  const g = createGrantSet(clock)
  g.mint({ name: 'order', subject: 'order:RO-10850', scope: ['read', 'cancel'],
           value: 'RO-10850', mintedAt: NOW, expiresAt: NOW + 60000 })
  assert.eq(g.has('order:RO-10850', 'cancel'), true, 'granted')
  assert.eq(g.has('order:RO-10850', 'return'), false, 'scope not granted')
  assert.eq(g.has('order:RO-10390', 'cancel'), false, 'other subject not granted')
})

test('an expired grant is not honoured', () => {
  const g = createGrantSet(clock)
  g.mint({ name: 'order', subject: 'order:RO-10850', scope: ['cancel'],
           value: 'RO-10850', mintedAt: NOW, expiresAt: NOW - 1 })
  assert.eq(g.has('order:RO-10850', 'cancel'), false, 'expired')
  assert.eq(g.get('order'), null, 'expired grants do not resolve either')
})

test('narrow removes a scope and can never add one', () => {
  const g = createGrantSet(clock)
  g.mint({ name: 'order', subject: 'order:RO-10850', scope: ['read', 'cancel'],
           value: 'RO-10850', mintedAt: NOW, expiresAt: NOW + 60000 })
  g.narrow('order:RO-10850', 'cancel')
  assert.eq(g.has('order:RO-10850', 'cancel'), false, 'narrowed away')
  assert.eq(g.has('order:RO-10850', 'read'), true, 'read survives')
})

test('the manifest exposes names and scopes but never the value', () => {
  const g = createGrantSet(clock)
  g.mint(verifyOwnership(db, 'RO-10850', 'dana.reyes@example.com', NOW).grant)
  const manifest = g.manifest()
  assert.eq(JSON.stringify(manifest).includes('RO-10850'), false, 'no order id in the manifest')
  assert.eq(manifest[0].name, 'order', 'name present')
  assert.ok(manifest[0].scope.includes('cancel'), 'scope present')
})

test('minting a second grant under the same name replaces the first', () => {
  const g = createGrantSet(clock)
  g.mint(verifyOwnership(db, 'RO-10850', 'dana.reyes@example.com', NOW).grant)
  g.mint(verifyOwnership(db, 'RO-10390', 'mira.velasco@example.com', NOW).grant)
  assert.eq(g.has('order:RO-10850', 'cancel'), false, 'old grant gone, not accumulated')
  assert.eq(g.has('order:RO-10390', 'return'), true, 'new grant active')
})
