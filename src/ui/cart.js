import { el } from './render.js'
import { usd } from '../shared/format.js'
import { brand } from '../config/brand.js'

// The cart page is THE SHOP, not the agent.
//
// It writes to the ledger directly, and that is not a hole in the kernel: the invariant is
// that every *agent* write passes the gates, and this page is a stand-in for the
// storefront's own checkout. What the agent did was build the basket; paying was always
// going to happen somewhere it does not control.
//
// Expiry is checked against Date.now() here rather than an injected clock. The injectable
// clock belongs to a session, and a static page has no session to thread one through.

const NOTICE = {
  MISSING: ['No basket in that link', 'The link needs a basket id. Head back to the chat and I can make you a fresh one.'],
  UNKNOWN: ['Basket not found', "That basket isn't in this browser. Baskets live on the device they were made on."],
  EXPIRED: ['Basket expired', `Baskets are held for ${brand.checkout.ttlHours} hours. Ask in the chat and I'll build another.`],
  SUPERSEDED: ['Replaced by a newer basket', 'You asked for something else after this one, so this link is no longer live.'],
  ORDERED: ['Already paid', 'This basket became an order. Ask the chat to track it.'],
}

const shell = (...children) => el('main', { class: 'cart', id: 'main' }, ...children)

const notice = (title, body, extra) => shell(
  el('div', { class: 'card card--notice' },
    el('span', { class: 'eyebrow', text: 'Checkout' }),
    el('h1', { class: 'card__title', text: title }),
    el('p', { class: 'card__note', text: body }),
    extra))

const backLink = () => el('a', { class: 'btn btn--quiet', href: './index.html', text: 'Back to the shop' })

// A cart is payable only if it is open, unexpired, and not already an order. Everything
// else gets a plain notice — a dead link should explain itself, not throw.
export function cartState (cart, now) {
  if (!cart) return 'UNKNOWN'
  if (cart.status === 'ordered') return 'ORDERED'
  if (cart.status === 'superseded') return 'SUPERSEDED'
  if (Date.parse(cart.expiresAt) <= now) return 'EXPIRED'
  return 'OPEN'
}

// The order the shop writes when the shopper pays. Prices come from the CART, which got
// them from the product record — the page never recomputes a total of its own.
export function orderFrom (cart, variants, { db, now }) {
  const id = db.nextId('RO')
  const order = {
    id,
    email: brand.demoShopper.email,
    placedAt: new Date(now).toISOString(),
    status: 'processing',
    giftMessage: null,
    customerNote: null,
    fulfillment: { carrier: null, tracking: null, shippedAt: null, deliveredAt: null, eta: null, events: [] },
    items: cart.items.map((i, n) => ({
      lineId: `L${n + 1}`,
      sku: i.sku,
      name: i.name,
      variant: variants[i.sku] ?? { size: null, color: null },
      qty: i.qty,
      unitPriceCents: i.unitPriceCents,
      finalSale: false,
      returnable: true,
      defective: false,
      rmaId: null,
    })),
    totals: {
      subtotalCents: cart.subtotalCents,
      shippingCents: 0,
      taxCents: 0,
      discountCents: 0,
      totalCents: cart.subtotalCents,
      currency: 'USD',
    },
    payment: { method: 'Visa', last4: '4291' },
    shipTo: { ...brand.demoShopper.shipTo },
  }

  db.mutate((s) => {
    s.orders.push(order)
    const c = s.carts.find(x => x.id === cart.id)
    if (c) { c.status = 'ordered'; c.orderId = id }
    // Stock is consumed here, not when the basket was built — a basket nobody pays for
    // must not take gear off the shelf.
    for (const i of cart.items) s.stockDelta[i.sku] = (s.stockDelta[i.sku] ?? 0) - i.qty
  })

  return order
}

export function mountCart (root, db, { now = () => Date.now(), search = '' } = {}) {
  const id = new URLSearchParams(search).get('id')
  const render = (node) => { root.textContent = ''; root.append(header(), node) }

  const header = () => el('header', { class: 'top' },
    el('a', { class: 'wordmark', href: './index.html', text: brand.wordmark }),
    el('span', { class: 'eyebrow', text: 'Checkout' }))

  if (!id) { render(notice(...NOTICE.MISSING, backLink())); return { state: 'MISSING' } }

  const cart = db.getCart(id)
  const state = cartState(cart, now())
  if (state !== 'OPEN') {
    const extra = state === 'ORDERED' && cart.orderId
      ? el('p', { class: 'card__note spec', text: `Order ${cart.orderId}` })
      : backLink()
    render(notice(...NOTICE[state], extra))
    return { state }
  }

  // One <select> pair per line, defaulting to the first option the product actually has.
  const variants = {}
  const pickers = cart.items.map((line) => {
    const p = db.getProduct(line.sku)
    const sizes = p?.attrs?.sizes ?? []
    const colors = p?.attrs?.colors ?? []
    variants[line.sku] = { size: sizes[0] ?? null, color: colors[0] ?? null }

    const choose = (label, values, key) => {
      if (!values.length) return null
      const sel = el('select', { class: 'field__input', 'aria-label': `${label} for ${line.name}` },
        ...values.map(v => el('option', { value: v, text: String(v) })))
      sel.addEventListener('change', () => { variants[line.sku][key] = sel.value })
      return el('label', { class: 'field' }, el('span', { class: 'eyebrow', text: label }), sel)
    }

    return el('div', { class: 'cart__line' },
      el('div', { class: 'lines__item' },
        el('span', { class: 'lines__name', text: line.name }),
        el('span', { class: 'lines__meta spec', text: `× ${line.qty}` }),
        el('span', { class: 'lines__price spec', text: usd(line.lineTotalCents) })),
      el('div', { class: 'cart__variants' },
        choose('Size', sizes, 'size'),
        choose('Colour', colors, 'color')))
  })

  const pay = el('button', { class: 'btn btn--go', type: 'button', text: `Pay ${usd(cart.subtotalCents)}` })
  pay.addEventListener('click', () => {
    pay.disabled = true
    const order = orderFrom(cart, variants, { db, now: now() })
    render(notice('Order placed', `Ask the chat to track it and I can follow it from here.`,
      el('div', {},
        el('p', { class: 'card__title spec', text: order.id }),
        el('div', { class: 'card__actions' },
          el('a', { class: 'btn btn--go', href: './index.html', text: 'Back to the chat' })))))
  })

  render(shell(
    el('div', { class: 'card card--checkout' },
      el('div', { class: 'card__head' },
        el('span', { class: 'eyebrow', text: cart.id }),
        el('h1', { class: 'card__title', text: 'Your basket' })),
      el('div', { class: 'cart__lines' }, ...pickers),
      el('div', { class: 'kvs' },
        el('div', { class: 'kv kv--total' },
          el('span', { class: 'kv__k', text: 'Total' }),
          el('span', { class: 'kv__v spec', text: usd(cart.subtotalCents) }))),
      el('div', { class: 'card__actions' }, pay, backLink()),
      el('p', { class: 'card__note', text: 'Demo checkout — no card is taken and no money moves.' }))))

  return { state: 'OPEN' }
}
