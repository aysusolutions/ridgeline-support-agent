import { usd, day } from '../shared/format.js'
import { brand } from '../config/brand.js'

// Deterministic prose for every typed result kind. This is what ships when there is no
// LLM, and what the provenance firewall falls back to when a generation is rejected.
// If a flow only reads well with the composer on, the seam has leaked.
export const TEMPLATES = {
  order: r => [
    `${r.id} is ${r.stage.toLowerCase()}.`,
    r.tracking ? `${r.carrier} has it, tracking ${r.tracking}.` : '',
    r.deliveredAt ? `It was delivered ${day(r.deliveredAt)}.`
      : r.eta ? `Estimated ${day(r.eta)}.` : '',
  ].filter(Boolean).join(' '),

  cancellation: r =>
    `Done — ${r.orderId} is cancelled. ${usd(r.refundCents)} goes back to your ` +
    `${r.method} ending ${r.last4} in ${r.etaBusinessDays} business days.`,

  rma: r => r.feeCents
    ? `Your return is set up: ${r.rmaId}. That's ${usd(r.refundCents)} back after the ` +
      `${usd(r.feeCents)} return shipping. The label is on its way to your email.`
    : `Your return is set up: ${r.rmaId}. You'll get ${usd(r.refundCents)} back and we ` +
      'cover the shipping. The label is on its way to your email.',

  exchange: r =>
    `Exchange ${r.rmaId} is set up for size ${r.newVariant}. We're holding it while the ` +
    'original comes back, and the label is in your email.',

  storeCredit: r =>
    `I've issued ${usd(r.amountCents)} in store credit — code ${r.code}. It's good for ` +
    'twelve months on anything we stock.',

  claim: r =>
    `Claim ${r.claimId} is open with ${r.carrier}. We'll chase it from here and either ` +
    'replace it or refund you within five business days.',

  reschedule: r => `Rebooked — ${r.carrier} will hold ${r.orderId} until ${day(r.newDate)}.`,

  addressChange: r =>
    `Updated. ${r.orderId} now ships to ${r.address.city}, ${r.address.region} ${r.address.postal}.`,

  restockSub: r => `You're on the list — we'll email you the moment ${r.sku} is back.`,

  checkout: r =>
    `Basket ${r.cartId} is ready — ${r.items.map(i => `${i.qty} × ${i.name}`).join(', ')}, ` +
    `${usd(r.subtotalCents)}. Open it to pick a size and pay on the site.`,

  ticket: r =>
    `I've passed this to a person. Ticket ${r.ticketId}, ${r.queue} queue. ` +
    `${r.priority === 'high' ? 'Flagged as urgent. ' : ''}Someone will pick it up in ` +
    `${brand.sla.inHours}.`,

  policy: r => r.value === null ? null : `Our ${r.key} is ${r.value}.`,

  faqList: r => r.items[0]?.answer ?? null,

  productList: r => r.relaxed?.length
    ? `Nothing matched on ${r.relaxed.join(' and ')}, so here's the closest I have.`
    : r.items.length
      ? `Here ${r.items.length === 1 ? 'is one' : `are ${Math.min(r.items.length, 3)}`} that fit.`
      : null,

  comparison: r => {
    const real = r.differences.filter(d => d.winner)
    if (!real.length) return `${r.products.map(p => p.name).join(' and ')} are very close on paper.`
    const lead = real[0]
    const winner = r.products.find(p => p.sku === lead.winner)
    return `${winner.name} wins on ${lead.attribute} by ${lead.delta}. ` +
      `The cheaper one is ${r.products.find(p => p.sku === r.cheapest).name}.`
  },
}

// Refusals read as policy, never as a filter tripping. Every reason code the kernel can
// produce needs an entry here, and the tone tests assert none of them lecture.
export const REFUSALS = {
  ALREADY_SHIPPED: () =>
    "That one's already on its way, so I can't cancel it from here — but I can reroute it, " +
    'or set up a return the moment it lands.',

  NOT_IN_TRANSIT: () => "That one isn't with the carrier yet, so there's nothing to reschedule.",

  NOT_DELIVERED: () => "That hasn't been delivered yet, so a return would be early.",

  OUTSIDE_RETURN_WINDOW: d =>
    `That was delivered ${day(d.deliveredAt)}, so the 30-day window closed ` +
    `${day(d.closedAt)} — ${d.daysPast} days ago.`,

  FINAL_SALE: () =>
    "That item was a final-sale buy, so it isn't returnable. If it arrived damaged though, " +
    'the warranty still covers it — was there something wrong with it?',

  NOT_RETURNABLE: () => "That item isn't returnable, but a teammate can take a look.",

  RMA_EXISTS: d => `There's already a return open on that item — ${d.rmaId}. Want me to pull it up?`,

  NO_SUCH_LINE: () => "I couldn't find that item on the order. Which one did you mean?",

  WAIT_NOT_ELAPSED: d =>
    `Carriers sometimes scan a parcel early. Give it ${d.hoursRemaining} more hours — if it ` +
    "hasn't turned up by then, I'll open a claim straight away.",

  NOT_DEFECTIVE: () => 'That one is past the return window and it is not flagged as faulty.',

  OUTSIDE_WARRANTY: d => `That was ${d.monthsOld} months ago, past the 24-month warranty.`,

  ABOVE_GOODWILL_CAP: () =>
    "That's above what I can approve on my own, so I'm sending it to a teammate who can.",

  DATE_IN_PAST: () => "That date has already been. Which day did you mean?",
  DATE_TOO_FAR: d => `Carriers will only hold a parcel ${d.maxDays} days out.`,
  BAD_DATE: () => "I didn't follow that date. Something like 2026-08-06 works.",

  // Reached from an exchange (a size) and from a basket (the whole SKU), so it must not
  // claim to know which. Offering the restock list matters more than the noun.
  OUT_OF_STOCK: () => "That one's out of stock right now. I can tell you the moment it's back.",
  // Two limits can bind on a basket line. The refusal names whichever one did, with the
  // real figure — code owns that number, the model only phrases it.
  OVER_STOCK: d => `There ${d.available === 1 ? 'is' : 'are'} only ${d.available} of those left. ` +
    `I can put ${d.available} in the basket if that works.`,
  OVER_LINE_CAP: d => `I can do up to ${d.max} of one item in a single basket. ` +
    'For more than that a person can sort you out.',
  BAD_QUANTITY: () => "I didn't follow the quantity. How many did you want?",
  EMPTY_BASKET: () => 'Which one did you want? Tell me and I can put a basket together.',
  NO_SUCH_VARIANT: d => `We don't do that size. We have ${d.available.join(', ')}.`,
  ALREADY_IN_STOCK: () => "Good news — that one's in stock right now.",
  NO_SUCH_SKU: () => "I couldn't find that item in the catalogue.",

  INCOMPLETE_ADDRESS: d => `I'm missing the ${d.field} for the new address.`,
  BAD_POSTAL: () => "That postcode doesn't look right. Could you check it?",

  DEFAULT: () => brand.voice.refusedByPolicy,
}

// Reasons where a human could legitimately approve what code cannot.
export const ESCALATABLE = new Set([
  'OUTSIDE_RETURN_WINDOW', 'ABOVE_GOODWILL_CAP', 'OUTSIDE_WARRANTY', 'NOT_RETURNABLE',
])

export function refusalFor (error) {
  if (error.name === 'CapabilityDenied') return brand.voice.refusedByPolicy
  const fn = REFUSALS[error.reason] ?? REFUSALS.DEFAULT
  return fn(error.detail ?? {})
}
