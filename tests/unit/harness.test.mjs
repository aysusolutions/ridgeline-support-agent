import { test, assert, snapshot, diff } from '../harness.mjs'

test('assert.eq passes on deep equality', () => {
  assert.eq({ a: [1, 2] }, { a: [1, 2] }, 'deep equal')
})

test('assert.throwsWith catches the named error class', () => {
  class Boom extends Error {}
  assert.throwsWith(() => { throw new Boom('x') }, Boom, 'x')
})

test('diff reports added, removed and changed paths', () => {
  const before = snapshot({ a: 1, b: 2, c: { d: 3 } })
  const after = { a: 1, b: 9, c: { d: 3 }, e: 5 }
  assert.eq(diff(before, after), [
    { path: 'b', from: 2, to: 9 },
    { path: 'e', from: undefined, to: 5 },
  ], 'diff paths')
})

test('diff of an unchanged object is empty', () => {
  const before = snapshot({ a: 1, c: { d: 3 } })
  assert.eq(diff(before, { a: 1, c: { d: 3 } }), [], 'no drift')
})
