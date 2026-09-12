import { el } from './render.js'

// The trace panel is a demo asset, not a debug leftover.
//
// It exists so an audience can WATCH a gate refuse something, rather than be told it
// would. The most persuasive section is the first one: the exact payload the planner
// received, with the absence of record data visible rather than asserted.

const GATES = ['resolve', 'taint', 'capability', 'precondition', 'confirm', 'idempotency', 'execute']
const GATE_NO = { resolve: 2, taint: 3, capability: 4, precondition: 5, confirm: 6, idempotency: 7, execute: 8 }

const json = v => JSON.stringify(v, null, 2)

const section = (title, ...body) => el('section', { class: 'tr__sec' },
  el('h3', { class: 'tr__h', text: title }), ...body)

const pre = (text, cls = '') => el('pre', { class: `tr__pre ${cls}`, text })

// Which gate an error belongs to. Only THAT gate is marked failed — the ones after it
// were never reached, and colouring them red would misrepresent what happened.
const GATE_FOR_ERROR = {
  TaintViolation: 'taint',
  CapabilityDenied: 'capability',
  PreconditionFailed: 'precondition',
  ConfirmationInvalid: 'confirm',
}

function gateRow (step) {
  const failedAt = step.error ? (GATE_FOR_ERROR[step.error.name] ?? null) : null
  const failedIdx = failedAt ? GATES.indexOf(failedAt) : -1

  const pills = GATES.map((g, i) => {
    const state = step.gates[g]
    const cls = g === failedAt ? 'is-fail'
      : failedIdx >= 0 && i > failedIdx ? 'is-idle'          // never reached
        : state === 'pass' || state === 'replayed' ? 'is-pass'
          : state === 'pending' ? 'is-hold'
            : state === 'skipped' ? 'is-skip'
              : 'is-idle'
    return el('span', { class: `pill ${cls}`, title: `${GATE_NO[g]} · ${g}` },
      el('b', { text: String(GATE_NO[g]) }), el('i', { text: g }))
  })

  // Gate 1 is the grammar, which ran before the kernel saw the step at all.
  pills.unshift(el('span', { class: 'pill is-pass', title: '1 · grammar' },
    el('b', { text: '1' }), el('i', { text: 'grammar' })))

  return el('div', { class: 'tr__gates' }, ...pills)
}

function stepBlock (step, i) {
  const body = el('div', { class: 'tr__stepbody' },
    gateRow(step),
    el('div', { class: 'tr__kv' },
      el('span', { text: 'resolved args' }),
      pre(json(step.resolvedArgs ?? {}))),
    step.heldScope && el('p', { class: 'tr__note', text: `scope used: ${step.heldScope}` }),
    step.error && el('p', { class: 'tr__fail' },
      el('b', { text: step.error.name }),
      el('span', { text: ` — ${step.error.reason}` })))

  return el('article', { class: `tr__step${step.error ? ' is-fail' : ''}` },
    el('header', { class: 'tr__stephead' },
      el('span', { class: 'tr__stepid', text: `${step.stepId ?? `s${i + 1}`}` }),
      el('span', { class: 'tr__steptool', text: step.tool })),
    body)
}

export function renderTrace (d) {
  if (!d) return el('p', { class: 'tr__empty', text: 'Send a message to see the trace.' })

  const out = el('div', { class: 'tr' })

  /* 1 — input */
  out.append(section('Input',
    el('div', { class: 'tr__kv' }, el('span', { text: 'raw' }), pre(String(d.raw ?? ''))),
    d.sanitized !== d.raw &&
      el('div', { class: 'tr__kv' }, el('span', { text: 'sanitised' }), pre(d.sanitized ?? '')),
    d.flags?.length
      ? el('div', { class: 'tr__flags' }, ...d.flags.map(f => el('span', { class: 'pill is-fail', text: f })))
      : el('p', { class: 'tr__note', text: 'no injection heuristics tripped' }),
    d.classify && el('p', { class: 'tr__note',
      text: `classified ${d.classify.intent} @ ${d.classify.confidence}` })))

  /* 2 — what the planner saw. The load-bearing section. */
  if (d.plannerSaw) {
    const flat = JSON.stringify(d.plannerSaw)
    const leaks = ['RO-1', '@example.com'].filter(s => flat.includes(s))
    out.append(section('What the planner saw',
      pre(json(d.plannerSaw)),
      el('p', { class: leaks.length ? 'tr__fail' : 'tr__ok' },
        el('b', { text: leaks.length ? '✗' : '✓' }),
        el('span', {
          text: leaks.length
            ? ` record data reached the planner: ${leaks.join(', ')}`
            : ' no order data, no record text, no PII — only capability names and what you typed',
        }))))
  }

  /* 3 — the plan */
  if (d.plan) {
    out.append(section('Plan',
      el('p', { class: 'tr__note',
        text: `${d.plan.source} · parsed with trusted:${d.plan.trusted}` }),
      pre(typeof d.plan.raw === 'string' ? d.plan.raw : json(d.plan.raw)),
      d.plan.rejected && el('p', { class: 'tr__fail' },
        el('b', { text: 'PlanRejected' }), el('span', { text: ` — ${d.plan.rejected}` }))))
  }

  /* 4 — the eight gates, per step */
  if (d.kernel?.length) {
    out.append(section('Kernel · eight gates per step',
      ...d.kernel.map((s, i) => stepBlock(s, i))))
  }

  /* 5 — the composer and the firewall */
  if (d.compose) {
    const v = d.compose.verdict
    out.append(section('Composer · provenance firewall',
      el('p', { class: v === 'accepted' ? 'tr__ok' : 'tr__note' },
        el('b', { text: v === 'accepted' ? '✓' : v === 'rejected' ? '✗' : '—' }),
        el('span', {
          text: v === 'accepted' ? ' generation kept — every fact traced to a typed result'
            : v === 'rejected' ? ' generation discarded, deterministic template shipped'
              : ' no adapter available, deterministic template shipped',
        })),
      d.compose.text && pre(d.compose.text),
      d.compose.rejected?.length && el('div', { class: 'tr__flags' },
        ...d.compose.rejected.map(a => el('span', { class: 'pill is-fail', text: a })))))
  }

  /* 6 — what actually changed */
  out.append(section('Ledger delta',
    d.ledgerDelta?.length
      ? el('ul', { class: 'tr__ledger' }, ...d.ledgerDelta.map(e =>
        el('li', {}, el('b', { text: e.tool }), el('span', { text: ` · ${e.idemKey}` }))))
      : el('p', { class: 'tr__ok' }, el('b', { text: '∅' }),
        el('span', { text: ' no state changed this turn' }))))

  /* 7 — events */
  if (d.events?.length) {
    out.append(section('Events', el('ul', { class: 'tr__events' },
      ...d.events.map(e => el('li', {
        class: e.name.startsWith('security') ? 'is-sec' : '',
      }, el('b', { text: e.name }),
      el('span', { text: Object.keys(e.payload).length ? ` ${json(e.payload)}` : '' }))))))
  }

  return out
}

export function mountTrace (root) {
  let last = null

  const body = el('div', { class: 'tr__body' }, renderTrace(null))
  const panel = el('aside', {
    class: 'tracepanel', hidden: true,
    'aria-label': 'Turn trace', role: 'region',
  },
  el('header', { class: 'tracepanel__top' },
    el('span', { class: 'eyebrow', text: 'Turn trace' }),
    el('button', { class: 'icon', type: 'button', 'aria-label': 'Close trace',
      text: '×', onclick: () => toggle(false) })),
  body)

  function toggle (next) {
    panel.hidden = !next
    document.documentElement?.classList?.toggle?.('has-trace', next)
  }

  root.append(panel)

  return {
    // Called after every turn with the turn's debug record, and again with no argument
    // when the user hits the {} button.
    update (out, opts = {}) {
      if (out?.debug) {
        last = out.debug
        body.textContent = ''
        body.append(renderTrace(last))
      }
      if (!opts.silent) toggle(panel.hidden)
    },
  }
}
