import { test, assert } from '../harness.mjs'
import {
  createConfirmations, bindingOf, ConfirmationInvalid, CONFIRM_TTL_MS,
} from '../../src/kernel/confirm.js'

const B = (over = {}) => bindingOf('sess-1', 's2', 'cancel_order', { orderId: 'RO-10850', ...over })

test('a freshly minted token verifies once', () => {
  const c = createConfirmations(() => 1000)
  const nonce = c.mint(B())
  assert.eq(c.verify(nonce, B()), true, 'verified')
})

test('a token cannot be replayed', () => {
  const c = createConfirmations(() => 1000)
  const nonce = c.mint(B())
  c.verify(nonce, B())
  assert.throwsWith(() => c.verify(nonce, B()), ConfirmationInvalid, 'USED')
})

test('a token does not verify against different arguments', () => {
  const c = createConfirmations(() => 1000)
  const nonce = c.mint(B())
  assert.throwsWith(() => c.verify(nonce, B({ orderId: 'RO-10390' })),
    ConfirmationInvalid, 'BINDING_MISMATCH')
})

test('a token does not verify against a different tool or step', () => {
  const c = createConfirmations(() => 1000)
  const nonce = c.mint(B())
  assert.throwsWith(
    () => c.verify(nonce, bindingOf('sess-1', 's2', 'issue_store_credit', { orderId: 'RO-10850' })),
    ConfirmationInvalid, 'BINDING_MISMATCH')
  assert.throwsWith(
    () => c.verify(nonce, bindingOf('sess-1', 's3', 'cancel_order', { orderId: 'RO-10850' })),
    ConfirmationInvalid, 'BINDING_MISMATCH')
})

test('a token minted in one session does not verify in another', () => {
  const c = createConfirmations(() => 1000)
  const nonce = c.mint(B())
  assert.throwsWith(
    () => c.verify(nonce, bindingOf('sess-2', 's2', 'cancel_order', { orderId: 'RO-10850' })),
    ConfirmationInvalid, 'BINDING_MISMATCH')
})

test('an expired token is refused', () => {
  let t = 1000
  const c = createConfirmations(() => t)
  const nonce = c.mint(B())
  t = 1000 + CONFIRM_TTL_MS + 1
  assert.throwsWith(() => c.verify(nonce, B()), ConfirmationInvalid, 'EXPIRED')
})

test('an invented token is refused', () => {
  const c = createConfirmations(() => 1000)
  c.mint(B())
  assert.throwsWith(() => c.verify('deadbeefdeadbeefdeadbeefdeadbeef', B()),
    ConfirmationInvalid, 'UNKNOWN')
})

test('an empty or null token is refused rather than crashing', () => {
  const c = createConfirmations(() => 1000)
  assert.throwsWith(() => c.verify('', B()), ConfirmationInvalid, 'UNKNOWN')
  assert.throwsWith(() => c.verify(null, B()), ConfirmationInvalid, 'UNKNOWN')
})

test('nonces are unique across mints', () => {
  const c = createConfirmations(() => 1000)
  const set = new Set(Array.from({ length: 200 }, () => c.mint(B())))
  assert.eq(set.size, 200, 'no collisions')
})

test('a nonce is 32 hex characters — 128 bits, not guessable', () => {
  const nonce = createConfirmations(() => 1000).mint(B())
  assert.eq(/^[0-9a-f]{32}$/.test(nonce), true, 'shape')
})

test('argument order does not change the binding', () => {
  const a = bindingOf('s', 's1', 't', { x: 1, y: 2 })
  const b = bindingOf('s', 's1', 't', { y: 2, x: 1 })
  assert.eq(a, b, 'stable stringify')
})

test('pending lists only live, unused tokens', () => {
  let t = 1000
  const c = createConfirmations(() => t)
  const a = c.mint(B())
  c.mint(B({ orderId: 'RO-10390' }))
  assert.eq(c.pending().length, 2, 'two live')
  c.verify(a, B())
  assert.eq(c.pending().length, 1, 'used one drops out')
  t += CONFIRM_TTL_MS + 1
  assert.eq(c.pending().length, 0, 'expiry drops the rest')
})
