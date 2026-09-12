import { el, mdLite } from './render.js'
import { usd, day } from '../shared/format.js'
import { unwrap, isTainted } from '../shared/taint.js'

// The signature. Outdoor buyers compare numbers, the recommender scores on these exact
// attributes, and the comparison card highlights the winner. Surfacing them is the data
// model made visible, not decoration.
export function specStrip (product) {
  const a = product.attrs ?? {}
  const bits = []
  if (a.tempRatingC !== null && a.tempRatingC !== undefined) bits.push(`${a.tempRatingC}°C`)
  if (a.weightGrams) bits.push(`${a.weightGrams} g`)
  // `capacity` means sleeping places on a tent and litres on a pack. Rendering "2 L"
  // for a two-person tent is the kind of thing a gear buyer spots immediately.
  if (a.capacity) bits.push(product.category === 'tents' ? `${a.capacity}P` : `${a.capacity} L`)
  if (a.waterproofRating) bits.push(`${a.waterproofRating} mm`)
  if (a.seasons) bits.push(`${a.seasons}-season`)
  return bits.join(' · ')
}

const STAGES = ['placed', 'shipped', 'in_transit', 'delivered']
const STAGE_LABEL = { placed: 'Placed', shipped: 'Shipped', in_transit: 'In transit', delivered: 'Delivered' }

const card = (kind, ...children) =>
  el('div', { class: `card card--${kind}`, 'data-kind': kind }, ...children)

const head = (eyebrow, title) => el('div', { class: 'card__head' },
  el('span', { class: 'eyebrow', text: eyebrow }),
  el('h4', { class: 'card__title', text: title }))

const row = (label, value, cls = '') => el('div', { class: `kv ${cls}` },
  el('span', { class: 'kv__k', text: label }),
  el('span', { class: 'kv__v spec', text: value }))

/* --------------------------------------------------------------------- orders */

function orderCard (r) {
  const reached = STAGES.indexOf(
    r.status === 'cancelled' ? 'placed' : (r.events?.at(-1)?.stage ?? 'placed'))

  const rail = el('ol', { class: 'rail', 'aria-label': 'Shipment progress' },
    ...STAGES.map((s, i) => el('li', {
      class: `rail__step${i <= reached ? ' is-done' : ''}${i === reached ? ' is-now' : ''}`,
    },
    el('span', { class: 'rail__dot', 'aria-hidden': 'true' }),
    el('span', { class: 'rail__label', text: STAGE_LABEL[s] }))))

  const items = el('ul', { class: 'lines' }, ...r.items.map(i =>
    el('li', { class: 'lines__item' },
      el('span', { class: 'lines__name', text: i.name }),
      el('span', { class: 'lines__meta spec', text: `${i.variant.size} · ${i.variant.color}` }),
      el('span', { class: 'lines__price spec', text: usd(i.unitPriceCents * i.qty) }),
      i.rmaId && el('span', { class: 'tag tag--muted', text: `Return ${i.rmaId}` }),
      i.finalSale && el('span', { class: 'tag tag--muted', text: 'Final sale' }))))

  return card('order',
    head(r.id, r.stage),
    rail,
    r.tracking && row(r.carrier ?? 'Carrier', r.tracking),
    r.eta && !r.deliveredAt && row('Estimated', day(r.eta)),
    r.deliveredAt && row('Delivered', day(r.deliveredAt)),
    items,
    row('Total', usd(r.totals.totalCents), 'kv--total'),
    // Untrusted third-party text. Rendered as escaped text, clearly marked, and it can
    // never become a tool argument — the taint gate refuses it upstream.
    r.giftMessage && el('div', { class: 'untrusted' },
      el('span', { class: 'eyebrow', text: 'Gift message · from the sender' }),
      el('p', { class: 'untrusted__body', text: unwrap(r.giftMessage) })))
}

/* ------------------------------------------------------------------- outcomes */

const outcome = (kind, eyebrow, title, rows, note) =>
  card(kind, head(eyebrow, title), el('div', { class: 'kvs' }, ...rows),
    note && el('p', { class: 'card__note', text: note }))

/* -------------------------------------------------------------------- product */

function productCard (p, onPick) {
  const out = p.stock === 0
  const node = el('article', { class: `product${out ? ' is-out' : ''}` },
    el('div', { class: `product__thumb product__thumb--${p.category}`, 'aria-hidden': 'true' }),
    el('div', { class: 'product__body' },
      el('h5', { class: 'product__name', text: p.name }),
      el('p', { class: 'product__spec spec', text: specStrip(p) }),
      el('div', { class: 'product__foot' },
        el('span', { class: 'product__price spec', text: usd(p.priceCents) }),
        el('span', {
          class: `product__stock spec${out ? ' is-out' : ''}`,
          text: out ? 'Out of stock' : `${p.stock} in stock`,
        }))))

  if (onPick && !out) {
    node.append(el('button', {
      class: 'btn btn--ghost product__pick', type: 'button',
      text: 'Choose this', onclick: () => onPick(p),
    }))
  }
  return node
}

/* ----------------------------------------------------------------- comparison */

function comparisonCard (r) {
  const header = el('div', { class: 'cmp__row cmp__row--head' },
    el('span', { class: 'cmp__label' }),
    ...r.products.map(p => el('span', { class: 'cmp__cell cmp__cell--name', text: p.name })))

  const rows = r.differences.filter(d => d.winner).map(d =>
    el('div', { class: 'cmp__row' },
      el('span', { class: 'cmp__label', text: d.attribute }),
      ...r.products.map((p, i) => el('span', {
        class: `cmp__cell spec${d.winner === p.sku ? ' is-winner' : ''}`,
        text: String(d.values[i] ?? '—'),
      }))))

  const price = el('div', { class: 'cmp__row' },
    el('span', { class: 'cmp__label', text: 'price' }),
    ...r.products.map(p => el('span', {
      class: `cmp__cell spec${r.cheapest === p.sku ? ' is-winner' : ''}`,
      text: usd(p.priceCents),
    })))

  // The honest-downward note belongs to the PRICIER product — it is that product
  // arguing against itself. Showing the cheapest one's note would be backwards.
  const pricier = r.products.find(p => p.sku !== r.cheapest) ?? r.products[0]
  const note = unwrap(r.whyNotCheaper?.[pricier.sku] ?? '')

  return card('comparison',
    head('Side by side', 'What actually differs'),
    el('div', { class: 'cmp' }, header, ...rows, price),
    note && el('p', { class: 'card__note', text: note }))
}

/* ------------------------------------------------------------------- the gate */

// The confirmation card. The token lives in this closure and NOWHERE else — not in an
// attribute, not in textContent, not in the transcript. A click is a channel no injected
// text and no model output can reach; a typed "yes" would be a string, and strings arrive
// through the same door as the attack.
export function confirmCard (c, onConfirm) {
  const go = el('button', {
    class: 'btn btn--go', type: 'button',
    text: c.irreversible ? 'Yes, do it' : 'Confirm',
  })
  go.addEventListener('click', () => {
    go.disabled = true
    // Collapse to a settled state. Leaving a live-looking button after the action is
    // both confusing and an invitation to click again.
    node.classList?.add?.('is-settled')
    actions.textContent = ''
    actions.append(el('span', { class: 'eyebrow', text: 'Confirmed' }))
    onConfirm({ [c.stepId]: c.token })
  })

  const actions = el('div', { class: 'card__actions' }, go,
    el('button', {
      class: 'btn btn--quiet', type: 'button', text: 'Not now',
      onclick: () => node.remove(),
    }))

  const node = card('confirm',
    el('span', { class: 'eyebrow', text: 'Confirm before I act' }),
    el('h4', { class: 'card__title', text: c.title }),
    ...c.lines.map(l => el('p', { class: 'confirm__line spec', text: l })),
    c.irreversible && el('p', { class: 'confirm__warn', text: 'This cannot be undone.' }),
    actions)

  node.setAttribute('role', 'group')
  node.setAttribute('aria-label', c.title)
  queueMicrotask(() => go.focus())
  return node
}

/* ------------------------------------------------------------------ the table */

export function renderCard (r, handlers = {}) {
  switch (r.kind) {
    case 'confirm': return confirmCard(r, handlers.onConfirm)
    case 'order': return orderCard(r)
    case 'comparison': return comparisonCard(r)

    case 'productList':
      return card('products',
        r.relaxed?.length
          // Was `Relaxed: tempRatingC, tags` — internal filter keys, shown to a shopper.
          // What they need to know is that this is the closest match, not which column
          // the search gave up on.
          ? el('p', { class: 'card__note', text: 'Closest matches — nothing fit exactly.' })
          : null,
        // Focusable and labelled: a horizontal scroller that is only reachable by
        // trackpad shuts out anyone using a keyboard.
        el('div', {
          class: 'products',
          tabindex: '0',
          role: 'group',
          'aria-label': `${r.items.length} results — scroll sideways for more`,
        }, ...r.items.map(p => productCard(p, handlers.onPickProduct))))

    case 'faqList':
      return card('faq', ...r.items.slice(0, 1).map(f => el('div', {},
        el('span', { class: 'eyebrow', text: 'From our help pages' }),
        el('p', { class: 'faq__answer' }, mdLite(f.answer)),
        el('span', { class: 'faq__src spec', text: f.id }))))

    case 'cancellation':
      return outcome('done', 'Cancelled', r.orderId, [
        row('Refund', usd(r.refundCents)),
        row('To', `${r.method} ••${r.last4}`),
        row('Arrives', `${r.etaBusinessDays} business days`),
      ])

    case 'rma':
      return outcome('done', 'Return started', r.rmaId, [
        row('Item', r.itemName),
        r.feeCents ? row('Return shipping', `−${usd(r.feeCents)}`, 'kv--deduct') : null,
        row('You get back', usd(r.refundCents), 'kv--total'),
      ].filter(Boolean), 'Print the label from the link in your email.')

    case 'exchange':
      return outcome('done', 'Exchange started', r.rmaId, [
        row('Item', r.itemName), row('New size', r.newVariant),
      ], 'We hold the replacement while the original is on its way back.')

    case 'storeCredit':
      return outcome('done', 'Store credit', r.code, [
        row('Amount', usd(r.amountCents)), row('Expires', day(r.expiresAt)),
      ])

    case 'claim':
      return outcome('done', 'Claim opened', r.claimId, [
        row('Carrier', r.carrier), row('Opened', day(r.openedAt)),
      ])

    case 'reschedule':
      return outcome('done', 'Delivery moved', r.orderId, [
        row('New date', day(r.newDate)), row('Carrier', r.carrier),
      ])

    case 'addressChange':
      return outcome('done', 'Address updated', r.orderId, [
        row('Ships to', `${r.address.city}, ${r.address.region} ${r.address.postal}`),
      ])

    // The href comes from the TYPED RESULT, never from generated prose. The link opens in
    // a new tab so the conversation it came out of is still there afterwards.
    case 'checkout':
      return card('checkout',
        head(r.cartId, 'Your basket'),
        el('ul', { class: 'lines' }, ...r.items.map(i =>
          el('li', { class: 'lines__item' },
            el('span', { class: 'lines__name', text: i.name }),
            el('span', { class: 'lines__meta spec', text: `× ${i.qty}` }),
            el('span', { class: 'lines__price spec', text: usd(i.lineTotalCents) })))),
        el('div', { class: 'kvs' }, row('Subtotal', usd(r.subtotalCents), 'kv--total')),
        el('div', { class: 'card__actions' },
          el('a', {
            class: 'btn btn--go', href: r.url, target: '_blank', rel: 'noopener',
            text: 'Open checkout',
          })),
        el('p', { class: 'card__note', text: 'Size and colour are chosen at checkout. Payment happens on the site.' }))

    case 'restockSub':
      return outcome('done', 'On the list', r.sku, [row('We email', r.email)])

    case 'ticket':
      return card('ticket',
        head(r.ticketId, 'Passed to a person'),
        el('div', { class: 'kvs' },
          row('Queue', r.queue),
          row('Priority', r.priority),
          row('Opened', day(r.openedAt))),
        el('p', { class: 'card__note', text: 'You will get a copy of this by email.' }))

    default: return null
  }
}
