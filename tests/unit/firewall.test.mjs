import { test, assert } from '../harness.mjs'
import { firewall } from '../../src/ai/firewall.js'

const results = [{
  kind: 'rma', rmaId: 'RMA-1001', refundCents: 18005, feeCents: 895,
  orderId: 'RO-10390', labelUrl: 'https://ups.com/label/abc',
}]

test('a faithful rephrasing passes', () => {
  assert.eq(firewall('Your return RMA-1001 is set up. You will get $180.05 back.', results).ok,
    true, 'ok')
})

test('an invented amount is rejected and named', () => {
  const r = firewall('You will get $500.00 back.', results)
  assert.eq(r.ok, false, 'rejected')
  assert.ok(r.rejected.includes('$500.00'), 'names the atom')
})

test('an invented date is rejected', () => {
  assert.eq(firewall('It will arrive on 2026-09-14.', results).ok, false, 'rejected')
})

test('an invented order id is rejected', () => {
  assert.eq(firewall('I also refunded RO-99999.', results).ok, false, 'rejected')
})

test('an invented url is rejected', () => {
  assert.eq(firewall('Print it at https://evil.example/label', results).ok, false, 'exfil blocked')
})

test('a promise word is rejected even when every number is real', () => {
  assert.eq(firewall('Your $180.05 refund is guaranteed.', results).ok, false, 'rejected')
})

test('numbers written differently but present in the source are accepted', () => {
  assert.eq(firewall('That is 180.05 dollars, minus the 8.95 fee.', results).ok, true,
    'normalised match')
})

test('an empty or non-string generation is rejected rather than shipped', () => {
  assert.eq(firewall('', results).ok, false, 'empty')
  assert.eq(firewall(null, results).ok, false, 'null')
  assert.eq(firewall('   ', results).ok, false, 'whitespace')
})

test('a date rendered in long form from an ISO stamp is accepted', () => {
  const order = [{ kind: 'order', id: 'RO-10221', deliveredAt: '2026-07-30T14:22:00Z' }]
  assert.eq(firewall('RO-10221 was delivered July 30.', order).ok, true, 'long form matched')
  assert.eq(firewall('RO-10221 was delivered July 31.', order).ok, false, 'off by one caught')
})

test('a tracking number cannot be invented', () => {
  const order = [{ kind: 'order', id: 'RO-10482', tracking: '1Z999AA10482037411' }]
  assert.eq(firewall('Tracking is 1Z999AA10482037411.', order).ok, true, 'real one passes')
  assert.eq(firewall('Tracking is 1Z999AA99999999999.', order).ok, false, 'invented one blocked')
})

test('facts inside a tainted field still count as source, since they came from the record', () => {
  const order = [{ kind: 'order', id: 'RO-10221',
    giftMessage: Object.freeze({ value: 'see order RO-10221', labels: ['UNTRUSTED'] }) }]
  assert.eq(firewall('That is order RO-10221.', order).ok, true, 'record id recognised')
})

test('prose with no facts at all passes', () => {
  assert.eq(firewall('All sorted — anything else I can help with?', results).ok, true, 'no atoms')
})

/* ------------------------------------------------- claimed but untaken actions */

test('a claim that something happened is rejected when nothing was written', async () => {
  const { verifyNoFalseAction } = await import('../../src/ai/firewall.js')
  for (const lie of ['Your purchase of 2 tents is being processed.',
                     'Your order has been placed.',
                     "I've cancelled that for you.",
                     'The refund has been issued.',
                     'Your order is on its way.']) {
    assert.eq(verifyNoFalseAction(lie, false).ok, false, `caught: ${lie}`)
  }
})

test('the same sentence is allowed when the ledger really did change', async () => {
  const { verifyNoFalseAction } = await import('../../src/ai/firewall.js')
  assert.eq(verifyNoFalseAction('Your order has been cancelled.', true).ok, true, 'it did happen')
})

test('ordinary prose is not mistaken for an action claim', async () => {
  const { verifyNoFalseAction } = await import('../../src/ai/firewall.js')
  for (const fine of ['Checkout lives on the site, not in here.',
                      'The Aspen is rated to 3000mm.',
                      'You have 30 days to return most items.',
                      'Would you like me to set that up?']) {
    assert.eq(verifyNoFalseAction(fine, false).ok, true, `not a claim: ${fine}`)
  }
})
