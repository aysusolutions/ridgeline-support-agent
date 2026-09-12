import { test, assert } from '../harness.mjs'
import {
  LABELS, tainted, isTainted, labelsOf, unwrap, derive,
  assertUntainted, declassify, TaintViolation,
} from '../../src/shared/taint.js'

test('plain values default to SYSTEM', () => {
  assert.eq(labelsOf('RO-10390'), [LABELS.SYSTEM], 'default label')
})

test('derive unions the labels of every input', () => {
  const a = tainted('x', [LABELS.USER])
  const b = tainted('y', [LABELS.UNTRUSTED])
  assert.eq(labelsOf(derive([a, b], 'xy')), [LABELS.UNTRUSTED, LABELS.USER], 'union sorted')
})

test('assertUntainted allows USER, SYSTEM and RECORD', () => {
  assertUntainted({
    a: tainted('1', [LABELS.USER]),
    b: tainted('2', [LABELS.RECORD]),
    c: 'plain',
  })
})

test('assertUntainted rejects UNTRUSTED and names the argument', () => {
  assert.throwsWith(
    () => assertUntainted({ orderId: tainted('RO-1', [LABELS.UNTRUSTED]) }),
    TaintViolation, 'orderId')
})

test('assertUntainted rejects MODEL output', () => {
  assert.throwsWith(
    () => assertUntainted({ amount: tainted(500, [LABELS.MODEL]) }),
    TaintViolation, 'MODEL')
})

test('declassify returns the trusted copy, not the candidate', () => {
  const candidate = tainted('ro-10390', [LABELS.MODEL, LABELS.UNTRUSTED])
  const out = declassify(candidate, ['RO-10390', 'RO-10482'])
  assert.eq(unwrap(out), 'RO-10390', 'canonical casing from the trusted set')
  assert.eq(labelsOf(out), [LABELS.RECORD], 'relabelled RECORD')
})

test('declassify returns null for a value not in the trusted set', () => {
  const candidate = tainted('RO-99999', [LABELS.MODEL])
  assert.eq(declassify(candidate, ['RO-10390']), null, 'no match, no laundering')
})

test('a declassified value is accepted as a tool argument', () => {
  const out = declassify(tainted('RO-10390', [LABELS.MODEL]), ['RO-10390'])
  assertUntainted({ orderId: out })
})

test('taint records are frozen so a label cannot be edited after the fact', () => {
  const t = tainted('x', [LABELS.UNTRUSTED])
  assert.throwsWith(() => { t.labels = [LABELS.RECORD] }, TypeError)
})

test('isTainted distinguishes wrapped values from lookalike objects', () => {
  assert.eq(isTainted(tainted('x', [LABELS.USER])), true, 'wrapped')
  assert.eq(isTainted({ value: 'x', labels: ['USER'] }), false, 'lookalike without the brand')
  assert.eq(isTainted(null), false, 'null')
  assert.eq(isTainted('plain'), false, 'string')
})

test('declassify handles an empty or null candidate without throwing', () => {
  assert.eq(declassify(tainted('', [LABELS.MODEL]), ['RO-10390']), null, 'empty')
  assert.eq(declassify(null, ['RO-10390']), null, 'null')
  assert.eq(declassify(tainted('   ', [LABELS.MODEL]), ['RO-10390']), null, 'whitespace')
})

test('derive on plain inputs stays SYSTEM and is usable as an argument', () => {
  assertUntainted({ x: derive(['a', 'b'], 'ab') })
})
