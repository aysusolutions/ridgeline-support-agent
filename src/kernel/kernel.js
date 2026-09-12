import { assertUntainted, unwrap, isTainted } from '../shared/taint.js'
import { PRECONDITIONS, PreconditionFailed } from './preconditions.js'
import { createGrantSet } from './capabilities.js'
import { createConfirmations, bindingOf, ConfirmationInvalid } from './confirm.js'
import { createLedger } from './ledger.js'
import { events } from '../telemetry/events.js'

export class CapabilityDenied extends Error {
  constructor (subject, scope) {
    super(`no grant for ${scope} on ${subject}`)
    this.name = 'CapabilityDenied'
    this.subject = subject
    this.scope = scope
  }
}

export function createSession (id, clock = () => Date.now()) {
  return {
    id,
    grants: createGrantSet(clock),
    confirmations: createConfirmations(clock),
    ledger: createLedger(),
    entitySet: new Set(),
    seq: { n: 1000 },
  }
}

function readPath (obj, path) {
  return path.split(/[.[\]]+/).filter(Boolean)
    .reduce((acc, k) => (acc === null || acc === undefined ? acc : acc[k]), obj)
}

// Resolves refs WITHOUT stripping taint — the labels have to survive to the taint gate.
function resolveArgs (stepArgs, { grants, results }) {
  const out = {}
  for (const [name, spec] of Object.entries(stepArgs)) {
    if ('lit' in spec) { out[name] = spec.lit; continue }

    const cap = /^\$cap\.([a-z_][a-z0-9_]*)$/.exec(spec.ref)
    if (cap) {
      const g = grants.get(cap[1])
      if (!g) throw new CapabilityDenied(`cap:${cap[1]}`, 'resolve')
      out[name] = g.value
      continue
    }

    const st = /^\$(s\d+)\.(.+)$/.exec(spec.ref)
    out[name] = readPath(results[st[1]], st[2])
  }
  return out
}

// Only called AFTER assertUntainted has run, so the gate sees the labels first.
const plainify = args =>
  Object.fromEntries(Object.entries(args).map(([k, v]) => [k, isTainted(v) ? unwrap(v) : v]))

function eventNameFor (e) {
  if (e.name === 'TaintViolation') return 'security.taint_violation'
  if (e.name === 'CapabilityDenied') return 'security.capability_denied'
  if (e instanceof ConfirmationInvalid) return 'security.confirmation_invalid'
  if (e instanceof PreconditionFailed) return 'policy.precondition_failed'
  return 'kernel.error'
}

export function createKernel ({ db, tools, clock = () => Date.now() }) {
  const policies = db.getPolicies()

  function runStep (step, session, opts, results, trace) {
    const tool = tools[step.tool]
    const t = { stepId: step.id, tool: step.tool, gates: {} }
    trace.push(t)

    // 2 — resolve
    const args = resolveArgs(step.args, { grants: session.grants, results })
    t.resolvedArgs = args           // labels intact; the adversarial harness inspects these
    t.gates.resolve = 'pass'

    // 3 — taint. Before capability on purpose: a poisoned argument is refused even when
    // the session happens to hold the matching grant.
    assertUntainted(args)
    t.gates.taint = 'pass'
    const plain = plainify(args)

    // 4 — capability
    const subject = tool.subject(plain)
    if (tool.scope) {
      const scopes = [].concat(tool.scope)
      const held = scopes.find(sc => session.grants.has(subject, sc))
      if (!held) throw new CapabilityDenied(subject, scopes.join('|'))
      t.heldScope = held
    }
    t.gates.capability = 'pass'

    // 5 — preconditions
    const order = subject?.startsWith('order:') ? db.getOrder(subject.slice(6)) : null
    const product = plain.sku ? db.getProduct(plain.sku) : null
    // `db` is here for predicates over a LIST of records — a basket resolves its own
    // lines, because the single-`sku` resolution above cannot.
    const pctx = { db, order, product, args: plain, policies, now: clock(), heldScope: t.heldScope }
    for (const name of tool.preconditions) PRECONDITIONS[name](pctx)
    // Scope-specific gates for the dual-scope return tool.
    if (t.heldScope === 'return') PRECONDITIONS.within_return_window(pctx)
    if (t.heldScope === 'warranty_return') PRECONDITIONS.within_warranty(pctx)
    t.gates.precondition = 'pass'

    const execCtx = { db, policies, now: clock(), seq: session.seq, sessionId: session.id }

    // 6 — confirmation
    if (tool.consequential) {
      const binding = bindingOf(session.id, step.id, step.tool, plain)
      const supplied = opts.confirmations?.[step.id]
      if (!supplied) {
        const token = session.confirmations.mint(binding)
        t.gates.confirm = 'pending'
        return {
          halt: {
            status: 'PENDING_CONFIRMATION',
            stepId: step.id,
            token,
            preview: tool.preview(execCtx, plain),
          },
        }
      }
      session.confirmations.verify(supplied, binding)
      t.gates.confirm = 'pass'
    }

    // 7 — idempotency
    const key = tool.idemKey ? tool.idemKey(plain) : null
    const prior = key ? session.ledger.findByKey(key) : null
    if (prior) {
      results[step.id] = prior.result
      t.gates.idempotency = 'replayed'
      t.gates.execute = 'skipped'
      return {}
    }
    t.gates.idempotency = 'pass'

    // 8 — execute
    const result = tool.execute(execCtx, plain)
    if (key) {
      session.ledger.append({
        idemKey: key, tool: step.tool, args: plain, result,
        at: new Date(clock()).toISOString(),
      })
    }
    results[step.id] = result
    t.gates.execute = 'pass'
    return {}
  }

  return {
    execute (plan, session, opts = {}) {
      const results = {}
      const trace = []
      for (const step of plan.steps) {
        try {
          const { halt } = runStep(step, session, opts, results, trace)
          if (halt) return { ...halt, results, trace }
        } catch (e) {
          const t = trace[trace.length - 1]
          if (t) t.error = { name: e.name, reason: e.reason ?? e.message }
          events.emit(eventNameFor(e), {
            tool: step.tool, name: e.name, reason: e.reason ?? e.message,
          })
          return { status: 'REFUSED', reason: e, results, trace }
        }
      }
      return { status: 'OK', results, trace }
    },
  }
}
