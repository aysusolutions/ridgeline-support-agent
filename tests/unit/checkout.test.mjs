import { test, assert } from '../harness.mjs'
import { createDb } from '../../src/backend/db.js'
import { createAgent } from '../../src/dialog/turn.js'
import { TOOLS } from '../../src/kernel/tools.js'
import { PRECONDITIONS, PreconditionFailed } from '../../src/kernel/preconditions.js'
import { parsePlan, PlanRejected } from '../../src/kernel/plan.js'
import { createKernel, createSession } from '../../src/kernel/kernel.js'
import { firewall } from '../../src/ai/firewall.js'
import { cartState, orderFrom } from '../../src/ui/cart.js'
import { brand, agentFacts } from '../../src/config/brand.js'

const NOW = Date.parse('2026-08-07T15:00:00Z')
const ctxFor = db => ({ db, policies: db.getPolicies(), now: NOW, seq: { n: 1000 }, sessionId: 'sess-test' })

// Runs a basket the way the agent does: through the kernel, never by calling execute.
function basket (db, items, now = NOW) {
  const session = createSession('sess-test', () => now)
  const kernel = createKernel({ db, tools: TOOLS, clock: () => now })
  const plan = parsePlan({ steps: [{ id: 's1', tool: 'create_checkout', args: { items: { lit: items } } }] },
    { tools: TOOLS, entitySet: session.entitySet, capabilityNames: [], trusted: true })
  return { out: kernel.execute(plan, session), session, kernel }
}

const purchaser = qty => ({
  async run (job) {
    return job === 'route'
      ? JSON.stringify({ route: 'purchase', reason: 'buying', remember: qty ? { quantity: qty } : {} })
      : null
  },
})

/* ------------------------------------------------------------------ the tool */

test('every price is computed from the product record, never taken from args', () => {
  const db = createDb()
  // A caller — or a compromised planner — offering its own price gets ignored entirely.
  const r = TOOLS.create_checkout.execute(ctxFor(db),
    { items: [{ sku: 'BOT-RIDG-M', qty: 2, unitPriceCents: 1, priceCents: 1 }] })
  assert.eq(r.items[0].unitPriceCents, 17900, 'price from the catalogue')
  assert.eq(r.items[0].lineTotalCents, 35800, 'line total computed')
  assert.eq(r.subtotalCents, 35800, 'subtotal computed')
})

test('the typed result carries the id, the link and the money — so prose can be checked', () => {
  const db = createDb()
  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  assert.eq(r.kind, 'checkout', 'kind')
  assert.ok(/^CART-\d+$/.test(r.cartId), `cart id: ${r.cartId}`)
  assert.eq(r.url, `${brand.checkout.path}?id=${r.cartId}`, 'link points at the cart page')
  assert.ok(Date.parse(r.expiresAt) > NOW, 'expires in the future')
})

test('the basket is a RECORD, which is what makes "your basket is ready" true', () => {
  const db = createDb()
  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  const cart = db.getCart(r.cartId)
  assert.eq(cart.status, 'open', 'written to the ledger')
  assert.eq(cart.subtotalCents, 17900, 'with the computed total')
})

test('a second basket supersedes the first, so an old link cannot also be paid', () => {
  const db = createDb()
  const first = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'TNT-ULTR-2', qty: 1 }] })
  assert.eq(db.getCart(first.cartId).status, 'superseded', 'the earlier one is closed')
})

test('the same request twice returns one basket, whatever order the lines arrive in', () => {
  const db = createDb()
  const { out, session, kernel } = basket(db, [{ sku: 'BOT-RIDG-M', qty: 2 }])
  const first = out.results.s1.cartId

  const again = parsePlan({ steps: [{ id: 's1', tool: 'create_checkout',
    args: { items: { lit: [{ sku: 'BOT-RIDG-M', qty: 2 }] } } }] },
  { tools: TOOLS, entitySet: session.entitySet, capabilityNames: [], trusted: true })
  assert.eq(kernel.execute(again, session).results.s1.cartId, first, 'idempotent')

  assert.eq(TOOLS.create_checkout.idemKey({ items: [{ sku: 'b', qty: 1 }, { sku: 'a', qty: 2 }] }),
    TOOLS.create_checkout.idemKey({ items: [{ sku: 'A', qty: 2 }, { sku: 'B', qty: 1 }] }),
    'argument order and case cannot mint a second basket')
})

/* -------------------------------------------------------------- what it refuses */

test('a basket refuses on whichever limit actually binds, and names the real figure', () => {
  const db = createDb()
  const refused = (items) => {
    try { PRECONDITIONS.stock_available({ db, args: { items } }); return null } catch (e) { return e }
  }
  // 13 in stock, cap of 10 — the CAP binds here.
  const cap = refused([{ sku: 'BOT-RIDG-M', qty: 50 }])
  assert.eq(cap.reason, 'OVER_LINE_CAP', 'cap binds first when stock is plentiful')
  assert.eq(cap.detail.max, brand.checkout.maxQtyPerLine, 'and names the cap')

  // 4 in stock, asking for 5 — STOCK binds, and 5 is under the cap.
  const stock = refused([{ sku: 'TNT-ULTR-2', qty: 5 }])
  assert.eq(stock.reason, 'OVER_STOCK', 'stock binds when it is the smaller limit')
  assert.eq(stock.detail.available, 4, 'and names the real figure')
})

test('a product with no stock is refused as out of stock, never as "only 0 left"', () => {
  const db = createDb()
  assert.eq(db.getProduct('LIN-SILK-R').stock, 0, 'the fixture really is empty')
  try {
    PRECONDITIONS.stock_available({ db, args: { items: [{ sku: 'LIN-SILK-R', qty: 1 }] } })
    assert.ok(false, 'should have refused')
  } catch (e) {
    assert.eq(e.reason, 'OUT_OF_STOCK', 'the honest reason')
    assert.eq(e.detail.available, undefined, 'and no "0 available" to offer')
  }
})

test('an unknown sku and a nonsense quantity are both refused', () => {
  const db = createDb()
  const reason = (items) => {
    try { PRECONDITIONS.stock_available({ db, args: { items } }); return null } catch (e) { return e.reason }
  }
  assert.eq(reason([{ sku: 'NOPE-1', qty: 1 }]), 'NO_SUCH_SKU', 'unknown sku')
  assert.eq(reason([{ sku: 'BOT-RIDG-M', qty: 0 }]), 'BAD_QUANTITY', 'zero')
  assert.eq(reason([{ sku: 'BOT-RIDG-M', qty: -2 }]), 'BAD_QUANTITY', 'negative')
  assert.eq(reason([{ sku: 'BOT-RIDG-M', qty: 1.5 }]), 'BAD_QUANTITY', 'fractional')
  assert.eq(reason([]), 'EMPTY_BASKET', 'nothing at all')
})

test('a refused basket writes nothing — no cart, no id burned', () => {
  const db = createDb()
  const { out } = basket(db, [{ sku: 'TNT-ULTR-2', qty: 5 }])
  assert.eq(out.status, 'REFUSED', 'refused')
  assert.eq(db.snapshot().carts.length, 0, 'and left no half-built basket behind')
})

/* ------------------------------------------------------ who can reach this tool */

test('a model-authored plan cannot build a basket', () => {
  // `items` is a list of objects, and parsePlan refuses structured literals from an
  // untrusted author. So the only route to this tool is the code path in turn.js — which
  // is a property of the plan grammar, not a rule anyone has to remember.
  const session = createSession('sess-test', () => NOW)
  try {
    parsePlan({ steps: [{ id: 's1', tool: 'create_checkout',
      args: { items: { lit: [{ sku: 'BOT-RIDG-M', qty: 99 }] } } }] },
    { tools: TOOLS, entitySet: session.entitySet, capabilityNames: [] })
    assert.ok(false, 'an untrusted plan should not be able to construct a basket')
  } catch (e) {
    assert.ok(e instanceof PlanRejected, `rejected: ${e.message}`)
  }
})

test('building a basket needs no capability grant, and grants no authority over orders', () => {
  assert.eq(TOOLS.create_checkout.scope, null, 'nothing to verify ownership of')
  assert.eq(TOOLS.create_checkout.subject({}), null, 'and no subject to hold authority over')
  // `consequential` in this kernel means "halt for a confirm tap". A basket is reversible.
  assert.eq(TOOLS.create_checkout.consequential, false, 'no confirm tap for something reversible')
})

/* -------------------------------------------------------------------- the prose */

test('the firewall accepts the real figures and rejects an invented one', () => {
  const db = createDb()
  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 2 }] })
  assert.eq(firewall(`Basket ${r.cartId} is ready — 2 × Ridgeline Hiker, $358.00.`, [r]).ok,
    true, 'real id and real total pass')
  assert.eq(firewall(`Basket ${r.cartId} is ready — that comes to $99.00.`, [r]).ok,
    false, 'an invented total does not')
  assert.eq(firewall('Basket CART-9999 is ready.', [r]).ok, false, 'nor an invented id')
})

test('the fact sheet no longer claims it cannot build a basket', () => {
  const cannot = agentFacts.cannotDo.join(' ')
  assert.eq(/add anything to a basket/i.test(cannot), false, 'that statement was true, and now is not')
  assert.ok(/take payment/i.test(cannot), 'it still cannot take money')
  assert.ok(agentFacts.canActuallyDo.some(x => /basket/i.test(x)), 'and it says what it CAN do')
})

/* ------------------------------------------------------------------ the turn */

test('"give me two of those" builds a basket for the product in focus', async () => {
  const a = createAgent({ db: createDb(), clock: () => NOW, ai: purchaser(2) })
  a.session.focus = 'BOT-RIDG-M'
  const out = await a.turn('ok give me 2 of those')
  const card = out.cards.find(c => c.kind === 'checkout')
  assert.ok(card, `a checkout card: ${out.reply}`)
  assert.eq(card.items[0].sku, 'BOT-RIDG-M', 'the right product')
  assert.eq(card.items[0].qty, 2, 'the right quantity')
  assert.ok(out.reply.includes(card.cartId), 'and the reply names the real basket')
})

test('a quantity from an earlier turn does not carry into a later basket', async () => {
  // "I want 5 sleeping bags" two turns ago must not silently become five boots.
  const a = createAgent({ db: createDb(), clock: () => NOW, ai: purchaser(null) })
  a.session.notes = { quantity: 5 }
  a.session.focus = 'BOT-RIDG-M'
  const out = await a.turn('ok get me that one')
  assert.eq(out.cards.find(c => c.kind === 'checkout').items[0].qty, 1, 'defaults to one')
})

test('with no product resolvable it asks which one rather than guessing', async () => {
  const db = createDb()
  const a = createAgent({ db, clock: () => NOW, ai: purchaser(2) })
  const out = await a.turn('ok give me two')
  assert.eq(out.cards.length, 0, 'nothing built')
  assert.eq(db.snapshot().carts.length, 0, 'and nothing written')
  assert.ok(/which/i.test(out.reply), `asks which: ${out.reply}`)
})

test('too many, and the reply states the real limit instead of a checkout link', async () => {
  const a = createAgent({ db: createDb(), clock: () => NOW, ai: purchaser(5) })
  a.session.focus = 'TNT-ULTR-2'
  const out = await a.turn('give me five of those')
  assert.eq(out.status, 'REFUSED', 'refused')
  assert.ok(out.reply.includes('4'), `names the real stock: ${out.reply}`)
})

/* ------------------------------------------------------------------ the cart page */

test('a basket is payable only while it is open and unexpired', () => {
  const open = { status: 'open', expiresAt: new Date(NOW + 3600000).toISOString() }
  assert.eq(cartState(open, NOW), 'OPEN', 'open')
  assert.eq(cartState(null, NOW), 'UNKNOWN', 'a link to nothing')
  assert.eq(cartState({ ...open, status: 'ordered' }, NOW), 'ORDERED', 'already paid')
  assert.eq(cartState({ ...open, status: 'superseded' }, NOW), 'SUPERSEDED', 'replaced')
  assert.eq(cartState({ ...open, expiresAt: new Date(NOW - 1).toISOString() }, NOW), 'EXPIRED', 'stale')
})

test('paying turns the basket into an order the agent can then act on', () => {
  const db = createDb()
  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 2 }] })
  const order = orderFrom(db.getCart(r.cartId), { 'BOT-RIDG-M': { size: 10, color: 'Clay' } }, { db, now: NOW })

  assert.ok(/^RO-\d+$/.test(order.id), `order id: ${order.id}`)
  assert.eq(db.getOrder(order.id).status, 'processing', 'in the ledger, unshipped')
  assert.eq(order.totals.totalCents, 35800, 'total came from the basket')
  assert.eq(order.items[0].variant.size, 10, 'the size chosen at checkout')
  assert.eq(db.getCart(r.cartId).status, 'ordered', 'the basket is spent')
  assert.eq(db.getCart(r.cartId).orderId, order.id, 'and points at what it became')
})

test('a new order id can never collide with one already in the fixtures', () => {
  const db = createDb()
  const existing = new Set(db.listOrderIds())
  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  const order = orderFrom(db.getCart(r.cartId), {}, { db, now: NOW })
  assert.eq(existing.has(order.id), false, `${order.id} is new`)
})

/* -------------------------------------------------------------- the stock overlay */

test('paying consumes stock, and the next basket sees the smaller number', () => {
  const db = createDb()
  assert.eq(db.getProduct('TNT-ULTR-2').stock, 4, 'four to start')

  const r = TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'TNT-ULTR-2', qty: 4 }] })
  orderFrom(db.getCart(r.cartId), {}, { db, now: NOW })

  assert.eq(db.getProduct('TNT-ULTR-2').stock, 0, 'and none after')
  assert.eq(db.searchProducts({ category: 'tents' }).find(p => p.sku === 'TNT-ULTR-2').stock, 0,
    'the storefront sees it too')
  try {
    PRECONDITIONS.stock_available({ db, args: { items: [{ sku: 'TNT-ULTR-2', qty: 1 }] } })
    assert.ok(false, 'a fifth should be refused')
  } catch (e) {
    assert.eq(e.reason, 'OUT_OF_STOCK', 'sold out, honestly')
  }
})

test('a basket alone does not consume stock — only paying does', () => {
  const db = createDb()
  TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'TNT-ULTR-2', qty: 4 }] })
  assert.eq(db.getProduct('TNT-ULTR-2').stock, 4, 'gear a shopper never paid for stays on the shelf')
})

/* ------------------------------------------------------------------- persistence */

test('with no storage nothing is written anywhere — which is how the suite runs', () => {
  const db = createDb()
  assert.eq(typeof db.snapshot().carts, 'object', 'carts exist in memory')
  assert.eq(db.getProduct('BOT-RIDG-M').stock, 13, 'and stock is the seed')
})

test('orders, baskets and consumed stock survive a reload', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }

  const first = createDb(null, { storage })
  const r = TOOLS.create_checkout.execute(ctxFor(first), { items: [{ sku: 'TNT-ULTR-2', qty: 2 }] })
  const order = orderFrom(first.getCart(r.cartId), {}, { db: first, now: NOW })

  const reloaded = createDb(null, { storage })
  assert.eq(reloaded.getCart(r.cartId).status, 'ordered', 'the basket came back')
  assert.eq(reloaded.getOrder(order.id).id, order.id, 'so did the order')
  assert.eq(reloaded.getProduct('TNT-ULTR-2').stock, 2, 'and the stock it consumed')
})

test('a reload cannot mint an id that was already handed out', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }

  const first = createDb(null, { storage })
  const a = TOOLS.create_checkout.execute(ctxFor(first), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  // session.seq would restart at 1000 here; the durable counter must not.
  const second = createDb(null, { storage })
  const b = TOOLS.create_checkout.execute(ctxFor(second), { items: [{ sku: 'TNT-ULTR-2', qty: 1 }] })
  assert.eq(a.cartId === b.cartId, false, `${a.cartId} vs ${b.cartId}`)
})

test('a corrupt or stale key falls back to the seed rather than refusing to boot', () => {
  const bad = v => createDb(null, { storage: { getItem: () => v, setItem: () => {} } })
  assert.eq(bad('not json at all').listOrderIds().length > 0, true, 'garbage')
  assert.eq(bad('{"v":99,"orders":[]}').listOrderIds().length > 0, true, 'a version we do not know')
  assert.eq(bad('{"v":1}').listOrderIds().length > 0, true, 'missing records')
  assert.eq(bad(null).getProduct('BOT-RIDG-M').stock, 13, 'nothing stored yet')
})

test('a storage that throws does not take the page down with it', () => {
  const hostile = { getItem () { throw new Error('blocked') }, setItem () { throw new Error('full') } }
  const db = createDb(null, { storage: hostile })
  assert.eq(db.getProduct('BOT-RIDG-M').stock, 13, 'still readable')
  TOOLS.create_checkout.execute(ctxFor(db), { items: [{ sku: 'BOT-RIDG-M', qty: 1 }] })
  assert.eq(db.snapshot().carts.length, 1, 'and still writable in memory')
})

test('products are not persisted, so editing the catalogue still takes effect', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  createDb(null, { storage })
  const saved = JSON.parse(store.get('ridgeline:ledger:v1'))
  assert.eq(saved.products, undefined, 'the catalogue is config, not state')
  assert.eq(Array.isArray(saved.orders), true, 'orders are state')
  assert.eq(Array.isArray(saved.carts), true, 'so are baskets')
})
