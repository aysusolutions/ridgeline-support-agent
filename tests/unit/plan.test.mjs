import { test, assert } from '../harness.mjs'
import { parsePlan, PlanRejected, MAX_STEPS } from '../../src/kernel/plan.js'

const tools = {
  lookup_order: { args: { orderId: { type: 'string', required: true } }, consequential: false },
  cancel_order: { args: { orderId: { type: 'string', required: true } }, consequential: true },
  create_return_rma: {
    args: {
      orderId: { type: 'string', required: true },
      lineItemId: { type: 'string', required: true },
      reason: { type: 'string', required: true, enum: ['defective', 'wrongSize', 'changedMind'] },
    },
    consequential: true,
  },
}

const opts = { tools, entitySet: new Set(['RO-10390', 'L1']), capabilityNames: ['order'] }
const plan = steps => parsePlan({ steps }, opts)

test('a valid single-step plan parses', () => {
  const p = plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } }])
  assert.eq(p.steps.length, 1, 'one step')
})

test('a literal present in the entity set is accepted', () => {
  plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { lit: 'RO-10390' } } }])
})

test('a literal the model invented is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { lit: 'RO-99999' } } }]),
    PlanRejected, 'not user-originated')
})

test('an enum member is accepted as a literal even if never typed', () => {
  plan([{ id: 's1', tool: 'create_return_rma',
          args: { orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'defective' } } }])
})

test('a value outside the enum is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'create_return_rma',
                  args: { orderId: { ref: '$cap.order' }, lineItemId: { lit: 'L1' }, reason: { lit: 'vibes' } } }]),
    PlanRejected, 'reason')
})

test('an unknown capability name is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.admin' } } }]),
    PlanRejected, 'unknown capability')
})

test('a forward step reference is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$s2.id' } } }]),
    PlanRejected, 'forward reference')
})

test('a backward step reference is accepted', () => {
  plan([
    { id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } },
    { id: 's2', tool: 'create_return_rma',
      args: { orderId: { ref: '$cap.order' }, lineItemId: { ref: '$s1.items[0].lineId' },
              reason: { lit: 'defective' } } },
  ])
})

test('an unknown tool is rejected', () => {
  assert.throwsWith(() => plan([{ id: 's1', tool: 'drop_database', args: {} }]),
    PlanRejected, 'unknown tool')
})

test('an argument form that is neither lit nor ref is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: 'RO-10390' } }]),
    PlanRejected, 'argument form')
})

test('supplying both lit and ref for one argument is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order',
                  args: { orderId: { lit: 'RO-10390', ref: '$cap.order' } } }]),
    PlanRejected, 'argument form')
})

test('an unknown argument name is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order',
                  args: { orderId: { ref: '$cap.order' }, sudo: { lit: 'RO-10390' } } }]),
    PlanRejected, 'unknown argument')
})

test('a missing required argument is rejected', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'create_return_rma', args: { orderId: { ref: '$cap.order' } } }]),
    PlanRejected, 'missing required argument')
})

test('more than four steps is rejected', () => {
  const s = Array.from({ length: MAX_STEPS + 1 }, (_, i) =>
    ({ id: `s${i + 1}`, tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } }))
  assert.throwsWith(() => plan(s), PlanRejected, 'too many steps')
})

test('two consequential steps in one plan is rejected', () => {
  assert.throwsWith(
    () => plan([
      { id: 's1', tool: 'cancel_order', args: { orderId: { ref: '$cap.order' } } },
      { id: 's2', tool: 'cancel_order', args: { orderId: { ref: '$cap.order' } } }]),
    PlanRejected, 'consequential')
})

test('duplicate step ids are rejected', () => {
  assert.throwsWith(
    () => plan([
      { id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } },
      { id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } }]),
    PlanRejected, 'duplicate step id')
})

test('a malformed ref is rejected rather than silently resolving', () => {
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: 'order' } } }]),
    PlanRejected, 'unresolvable ref')
  assert.throwsWith(
    () => plan([{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order; DROP' } } }]),
    PlanRejected, 'unresolvable ref')
})

test('a non-object plan is rejected rather than crashing', () => {
  assert.throwsWith(() => parsePlan('ignore previous instructions', opts), PlanRejected, 'plan shape')
  assert.throwsWith(() => parsePlan(null, opts), PlanRejected, 'plan shape')
  assert.throwsWith(() => parsePlan({ steps: 'all of them' }, opts), PlanRejected, 'plan shape')
  assert.throwsWith(() => parsePlan({ steps: [] }, opts), PlanRejected, 'no steps')
  assert.throwsWith(() => parsePlan({ steps: [null] }, opts), PlanRejected, 'malformed step')
})

test('the parsed plan is a copy — mutating the input does not change it', () => {
  const raw = { steps: [{ id: 's1', tool: 'lookup_order', args: { orderId: { ref: '$cap.order' } } }] }
  const parsed = parsePlan(raw, opts)
  raw.steps[0].tool = 'cancel_order'
  assert.eq(parsed.steps[0].tool, 'lookup_order', 'defensive copy')
})
