import { intentByName } from './intents.js'
import { nextMissing, REASON_MAP } from './slots.js'
import { extractEntities } from './entities.js'
import { brand } from '../config/brand.js'

// The no-LLM planner. Every task must be completable through this alone — the chips
// ARE the planner when the adapter is null.

const step = (id, tool, args) => ({ id, tool, args })
const lit = v => ({ lit: v })
const cap = n => ({ ref: `$cap.${n}` })
const from = (s, path) => ({ ref: `$${s}.${path}` })

const PLANS = {
  track_order: () => ({ steps: [step('s1', 'lookup_order', { orderId: cap('order') })] }),

  cancel_order: () => ({ steps: [step('s1', 'cancel_order', { orderId: cap('order') })] }),

  change_address: f => ({ steps: [step('s1', 'change_shipping_address',
    { orderId: cap('order'), address: lit(f.address) })] }),

  reschedule: f => ({ steps: [step('s1', 'reschedule_delivery',
    { orderId: cap('order'), newDate: lit(f.newDate) })] }),

  report_missing: () => ({ steps: [step('s1', 'file_package_claim', { orderId: cap('order') })] }),

  start_return: f => ({ steps: [
    step('s1', 'lookup_order', { orderId: cap('order') }),
    step('s2', 'create_return_rma', {
      orderId: cap('order'), lineItemId: lit(f.lineItemId), reason: lit(f.reason),
    }),
  ] }),

  // No filters at all means the shopper has not narrowed anything yet. Default to tents
  // only in that case — never override what interpret_need actually understood.
  recommend: f => ({ steps: [step('s1', 'search_products', {
    filters: lit(Object.keys(f.filters ?? {}).length ? f.filters : { category: 'tents' }),
    weights: lit(f.weights ?? {}),
  })] }),

  compare: f => ({ steps: [step('s1', 'compare_products', { skus: lit(f.skus ?? []) })] }),

  handoff: f => ({ steps: [step('s1', 'create_handoff_ticket',
    { reason: lit(f.reason ?? 'requested') })] }),

  faq: f => ({ steps: [step('s1', 'search_faq', { query: lit(f.query ?? '') })] }),
}

// Slot priority: when a flow is awaiting an order number, "10850" fills that slot rather
// than being reclassified as a fresh intent. Getting this wrong is the single most common
// reason demo bots feel broken.
function tryFillSlot (session, opts) {
  const slot = session.pending.ask
  const known = { orderIds: opts.knownOrderIds ?? [], skus: opts.knownSkus ?? [] }
  const found = extractEntities(opts.rawText, known)
  const raw = String(opts.rawText ?? '').trim()

  let value = null
  if (slot === 'orderId') value = found.orderIds[0] ?? null
  else if (slot === 'email') value = found.emails[0] ?? null
  else if (slot === 'newDate') value = found.dates[0] ?? null
  else if (slot === 'reason') value = REASON_MAP[raw.toLowerCase()] ?? null
  else if (slot === 'lineItemId') value = /^L\d+$/i.test(raw) ? raw.toUpperCase() : null
  else if (slot === 'size') value = raw || null
  else value = raw || null

  return value ? { filled: slot, value } : null
}

export function planFor (intentName, session, filled = {}, opts = {}) {
  if (session.pending && opts.rawText !== undefined) {
    const hit = tryFillSlot(session, opts)
    if (hit) return hit
  }

  const intent = intentByName(intentName)
  if (!intent) {
    return { chips: brand.chips }
  }

  // A verified capability satisfies the identity slots — the grant IS the proof of
  // ownership, so re-asking for the order number after verifying is just rude.
  const satisfied = { ...filled }
  if (session.grants.get('order')) { satisfied.orderId = true; satisfied.email = true }

  const missing = nextMissing(intent.requires, satisfied)
  if (missing) return { ask: missing, intent: intent.name }

  return { plan: PLANS[intent.name](filled), intent: intent.name }
}
