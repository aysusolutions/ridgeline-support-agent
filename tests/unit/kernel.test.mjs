import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { TOOLS } from '../../src/kernel/tools.js'
import { createKernel, createSession } from '../../src/kernel/kernel.js'
import { verifyOwnership } from '../../src/kernel/capabilities.js'
import { events } from '../../src/telemetry/events.js'

const NOW = Date.parse('2026-08-01T15:00:00Z')

function setup (orderId = 'RO-10850', email = 'dana.reyes@example.com') {
  const db = createDb()
  const k = createKernel({ db, tools: TOOLS, clock: () => NOW })
  const s = createSession('sess-1', () => NOW)   // inject the clock or grants expire against wall time
  const v = verifyOwnership(db, orderId, email, NOW)
  if (v.ok) s.grants.mint(v.grant)
  s.entitySet.add(orderId)
  return { db, k, s }
}

const step = (id, tool, args) => ({ id, tool, args })

test('a read plan executes and returns typed results', () => {
  const { k, s } = setup()
  const r = k.execute({ steps: [step('s1', 'lookup_order', { orderId: { ref: '$cap.order' } })] }, s)
  assert.eq(r.status, 'OK', 'ok')
  assert.eq(r.results.s1.kind, 'order', 'typed result')
})

test('a consequential step halts at the confirmation gate without mutating', () => {
  const { db, k, s } = setup()
  const r = k.execute({ steps: [step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } })] }, s)
  assert.eq(r.status, 'PENDING_CONFIRMATION', 'halted')
  assert.eq(r.token.length, 32, 'token minted')
  assert.ok(r.preview.lines.join(' ').includes('284.50'), 'preview computed by code')
  assert.eq(db.getOrder('RO-10850').status, 'processing', 'no mutation before confirmation')
})

test('supplying the token executes the same step', () => {
  const { db, k, s } = setup()
  const plan = { steps: [step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } })] }
  const first = k.execute(plan, s)
  const second = k.execute(plan, s, { confirmations: { s1: first.token } })
  assert.eq(second.status, 'OK', 'executed')
  assert.eq(db.getOrder('RO-10850').status, 'cancelled', 'mutated')
  assert.eq(s.ledger.entries().length, 1, 'one ledger entry')
})

test('a replayed token is refused and does not mutate twice', () => {
  const { db, k, s } = setup()
  const plan = { steps: [step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } })] }
  const first = k.execute(plan, s)
  k.execute(plan, s, { confirmations: { s1: first.token } })
  db.mutate(st => { st.orders.find(o => o.id === 'RO-10850').status = 'processing' })
  const replay = k.execute(plan, s, { confirmations: { s1: first.token } })
  assert.eq(replay.status, 'REFUSED', 'refused')
  assert.eq(db.getOrder('RO-10850').status, 'processing', 'no second effect')
})

test('an idempotent replay returns the prior result rather than a second effect', () => {
  // Store credit leaves no mark on the order, so gate 7 is the ONLY thing standing
  // between a replayed plan and a second payout. Tools that stamp the record (RMAs)
  // are caught earlier, by their own precondition.
  const { k, s } = setup('RO-10908', 'tom.whitfield@example.com')
  s.grants.mint({ name: 'credit', subject: 'order:RO-10908', scope: ['credit'],
                  value: 'RO-10908', mintedAt: NOW, expiresAt: NOW + 60000 })
  const plan = { steps: [step('s1', 'issue_store_credit', {
    orderId: { ref: '$cap.credit' }, amountCents: { lit: 1995 } })] }
  s.entitySet.add('1995')

  const first = k.execute(plan, s)
  const done = k.execute(plan, s, { confirmations: { s1: first.token } })
  assert.eq(done.results.s1.amountCents, 1995, 'credit issued once')

  const again = k.execute(plan, s)
  const doneAgain = k.execute(plan, s, { confirmations: { s1: again.token } })
  assert.eq(doneAgain.results.s1.code, done.results.s1.code, 'same credit code, no second payout')
  assert.eq(doneAgain.trace[0].gates.idempotency, 'replayed', 'gate 7 caught it')
  assert.eq(s.ledger.entries().length, 1, 'ledger holds one effect')
})

test('a second RMA attempt surfaces the existing one instead of replaying silently', () => {
  const { k, s } = setup('RO-10390', 'mira.velasco@example.com')
  s.entitySet.add('L1')
  const plan = { steps: [step('s1', 'create_return_rma', {
    orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'defective' } })] }
  const first = k.execute(plan, s)
  const done = k.execute(plan, s, { confirmations: { s1: first.token } })

  const again = k.execute(plan, s)
  assert.eq(again.status, 'REFUSED', 'refused rather than reissued')
  assert.eq(again.reason.reason, 'RMA_EXISTS', 'the precondition catches it first')
  assert.eq(again.reason.detail.rmaId, done.results.s1.rmaId, 'and names the existing RMA')
  assert.eq(s.ledger.entries().length, 1, 'still one effect')
})

test('a missing capability refuses before any precondition runs', () => {
  const db = createDb()
  const k = createKernel({ db, tools: TOOLS, clock: () => NOW })
  const s = createSession('sess-2', () => NOW)          // no grant minted
  s.entitySet.add('RO-10850')
  const r = k.execute({ steps: [step('s1', 'cancel_order', { orderId: { lit: 'RO-10850' } })] }, s)
  assert.eq(r.status, 'REFUSED', 'refused')
  assert.eq(r.reason.name, 'CapabilityDenied', 'denied at the capability gate')
  assert.eq(db.getOrder('RO-10850').status, 'processing', 'untouched')
})

test('an in-transit order has no cancel scope, so cancel is refused', () => {
  const { db, k, s } = setup('RO-10482', 'lee.tanaka@example.com')
  const r = k.execute({ steps: [step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } })] }, s)
  assert.eq(r.reason.name, 'CapabilityDenied', 'scope withheld by record state')
  assert.eq(db.getOrder('RO-10482').status, 'in_transit', 'untouched')
})

test('an out-of-window order has no return scope, so a return never reaches a precondition', () => {
  const { db, k, s } = setup('RO-10515', 'noor.haddad@example.com')
  s.entitySet.add('L1')
  const r = k.execute({ steps: [step('s1', 'create_return_rma', {
    orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'changedMind' } })] }, s)
  assert.eq(r.reason.name, 'CapabilityDenied', 'refused at the capability gate')
  assert.eq(db.getOrder('RO-10515').items[0].rmaId, null, 'no rma stamped')
})

test('a final-sale item is refused at the precondition gate with a stable reason', () => {
  const { db, k, s } = setup('RO-10733', 'jules.moreau@example.com')
  s.entitySet.add('L1')
  const r = k.execute({ steps: [step('s1', 'create_return_rma', {
    orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'changedMind' } })] }, s)
  assert.eq(r.status, 'REFUSED', 'refused')
  assert.eq(r.reason.reason, 'FINAL_SALE', 'stable reason code')
  assert.eq(db.getOrder('RO-10733').items[0].rmaId, null, 'no mutation')
})

test('a duplicate RMA is refused at the precondition gate, not silently reissued', () => {
  const { db, k, s } = setup('RO-10119', 'aiko.sato@example.com')
  s.entitySet.add('L1')
  const r = k.execute({ steps: [step('s1', 'create_return_rma', {
    orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'defective' } })] }, s)
  assert.eq(r.reason.reason, 'RMA_EXISTS', 'existing RMA surfaced')
  assert.eq(db.getOrder('RO-10119').items[0].rmaId, 'RMA-8842', 'original RMA untouched')
})

test('an UNTRUSTED value referenced from a prior step is blocked at the taint gate', () => {
  // The real indirect-injection path: the planner passes a poisoned record field as an
  // argument. It never reaches the capability gate, let alone the tool.
  const { db, k, s } = setup('RO-10221', 'sam.okafor@example.com')
  const r = k.execute({ steps: [
    step('s1', 'lookup_order', { orderId: { ref: '$cap.order' } }),
    step('s2', 'create_handoff_ticket', { reason: { ref: '$s1.giftMessage' } }),
  ] }, s)
  assert.eq(r.status, 'REFUSED', 'refused')
  assert.eq(r.reason.name, 'TaintViolation', 'blocked by taint')
  assert.eq(r.trace[1].gates.taint, undefined, 'taint gate never passed')
  assert.eq(s.ledger.entries().length, 0, 'nothing executed')
})

test('a step reference resolves a value the planner never saw', () => {
  const { k, s } = setup('RO-10390', 'mira.velasco@example.com')
  const plan = { steps: [
    step('s1', 'lookup_order', { orderId: { ref: '$cap.order' } }),
    step('s2', 'create_return_rma', { orderId: { ref: '$cap.order' },
                                      lineItemId: { ref: '$s1.items[0].lineId' },
                                      reason: { lit: 'defective' } }),
  ] }
  const first = k.execute(plan, s)
  assert.eq(first.status, 'PENDING_CONFIRMATION', 'halts on the RMA step')
  assert.eq(first.stepId, 's2', 'halted on the right step')
  const done = k.execute(plan, s, { confirmations: { s2: first.token } })
  assert.eq(done.results.s2.kind, 'rma', 'rma created from a resolved reference')
  assert.eq(done.results.s2.lineItemId, 'L1', 'resolved the line id from step 1')
})

test('a warranty return is allowed past the window on the warranty scope', () => {
  const { k, s } = setup('RO-10477', 'ravi.desai@example.com')
  s.entitySet.add('L1')
  const plan = { steps: [step('s1', 'create_return_rma', {
    orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'defective' } })] }
  const first = k.execute(plan, s)
  assert.eq(first.status, 'PENDING_CONFIRMATION', 'warranty path open past the window')
  const done = k.execute(plan, s, { confirmations: { s1: first.token } })
  assert.eq(done.results.s1.feeCents, 0, 'no restocking fee on a warranty claim')
})

test('the trace records every gate for every step', () => {
  const { k, s } = setup()
  const r = k.execute({ steps: [step('s1', 'lookup_order', { orderId: { ref: '$cap.order' } })] }, s)
  assert.eq(Object.keys(r.trace[0].gates).sort(),
    ['capability', 'execute', 'idempotency', 'precondition', 'resolve', 'taint'], 'gates recorded')
  assert.eq(r.trace[0].resolvedArgs.orderId, 'RO-10850', 'resolved args exposed for inspection')
})

test('a refusal emits a security event naming the gate', () => {
  events.reset()
  const { k, s } = setup('RO-10482', 'lee.tanaka@example.com')
  k.execute({ steps: [step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } })] }, s)
  assert.eq(events.count('security.capability_denied'), 1, 'event emitted')
})

test('a later step does not run once an earlier one is refused', () => {
  const { db, k, s } = setup('RO-10482', 'lee.tanaka@example.com')
  const r = k.execute({ steps: [
    step('s1', 'cancel_order', { orderId: { ref: '$cap.order' } }),
    step('s2', 'lookup_order', { orderId: { ref: '$cap.order' } }),
  ] }, s)
  assert.eq(r.status, 'REFUSED', 'refused')
  assert.eq(r.trace.length, 1, 'second step never attempted')
})
