import { el, mdLite } from './render.js'
import { renderCard } from './cards.js'
import { createAnnouncer, trapFocus } from './a11y.js'
import { brand } from '../config/brand.js'
import { models } from '../config/models.js'

const CSAT_KINDS = new Set(['rma', 'cancellation', 'exchange', 'storeCredit', 'claim', 'ticket'])

export function mountWidget (root, agent, { onTrace, memory = null } = {}) {
  root.textContent = ''
  let open = false
  let busy = false

  const log = el('div', { class: 'chat__log', role: 'log', 'aria-label': 'Conversation' })
  const chips = el('div', { class: 'chat__chips' })
  const announce = createAnnouncer(root)

  const input = el('input', {
    class: 'chat__input', type: 'text', autocomplete: 'off',
    'aria-label': 'Message', placeholder: 'Order number, or ask anything',
  })

  const form = el('form', { class: 'chat__form' }, input,
    el('button', { class: 'btn btn--go chat__send', type: 'submit', text: 'Send' }))

  const panel = el('section', {
    class: 'chat', role: 'dialog', 'aria-modal': 'false',
    'aria-label': `${brand.name} support`, hidden: true,
  },
  el('header', { class: 'chat__top' },
    el('span', { class: 'chat__mark', 'aria-hidden': 'true' }),
    el('div', { class: 'chat__id' },
      el('strong', { class: 'chat__name', text: brand.name }),
      el('span', { class: 'chat__status eyebrow', text: 'Support · replies instantly' })),
    el('button', { class: 'icon', type: 'button', 'aria-label': 'Trace', text: '{}',
      onclick: () => onTrace?.() }),
    el('button', { class: 'icon', type: 'button', 'aria-label': 'Close', text: '×',
      onclick: () => toggle(false) })),
  log, chips, form)

  const bubble = el('button', {
    class: 'launcher', type: 'button',
    'aria-label': 'Open support chat', 'aria-expanded': 'false',
    onclick: () => toggle(!open),
  }, el('span', { class: 'launcher__mark', 'aria-hidden': 'true' }),
  el('span', { class: 'launcher__text', text: 'Support' }))

  trapFocus(panel)
  panel.addEventListener('keydown', ev => { if (ev.key === 'Escape') toggle(false) })

  /* ------------------------------------------------------------------ messages */

  function bubbleFor (who, text) {
    const node = el('div', { class: `msg msg--${who}` })
    const body = el('div', { class: 'msg__body' })
    for (const para of String(text).split('\n\n')) {
      if (para.trim()) body.append(el('p', {}, mdLite(para)))
    }
    node.append(body)
    log.append(node)
    log.scrollTop = log.scrollHeight
    return node
  }

  function typing () {
    const node = el('div', { class: 'msg msg--agent msg--typing' },
      el('span', { class: 'dot' }), el('span', { class: 'dot' }), el('span', { class: 'dot' }))
    node.setAttribute('aria-hidden', 'true')
    log.append(node)
    log.scrollTop = log.scrollHeight
    return node
  }

  function setChips (list) {
    chips.textContent = ''
    for (const label of list ?? []) {
      chips.append(el('button', {
        class: 'chip', type: 'button', text: label,
        onclick: () => { if (!busy) send(label) },
      }))
    }
  }

  function csat (intent) {
    const bar = el('div', { class: 'csat' },
      el('span', { class: 'eyebrow', text: 'Did that sort it?' }))
    const vote = (score, label) => el('button', {
      class: 'icon icon--csat', type: 'button', 'aria-label': label, text: score > 0 ? '▲' : '▼',
      onclick: () => {
        agent.session.csat = score
        bar.textContent = ''
        bar.append(el('span', { class: 'eyebrow', text: 'Thanks — noted.' }))
      },
    })
    bar.append(vote(1, 'Yes, that sorted it'), vote(-1, 'No, it did not'))
    log.append(bar)
  }

  /* -------------------------------------------------------------------- render */

  async function present (out) {
    // "Start over" clears the screen too, or the control only half works.
    if (out.cleared) { log.textContent = ''; said.length = 0 }
    bubbleFor('agent', out.reply)
    announce(out.reply)
    // The line that confirms the wipe is not itself worth storing — recording it would
    // put the key straight back and leave "Earlier — Fresh start" on the next visit.
    if (!out.cleared) record('agent', out.reply)

    for (const c of out.cards ?? []) {
      const node = renderCard(c, {
        onConfirm: async (token) => { await drive(() => agent.turn(null, { confirm: token })) },
        onPickProduct: async (p) => {
          bubbleFor('user', `Tell me about the ${p.name}`)
          await drive(() => agent.pick(p.sku))
        },
      })
      if (node) { log.append(node); log.scrollTop = log.scrollHeight }
    }

    if ((out.cards ?? []).some(c => CSAT_KINDS.has(c.kind))) csat(out.intent)
    setChips(out.chips)
    onTrace?.(out, { silent: true })
  }

  async function drive (fn) {
    busy = true
    input.disabled = true
    const dots = typing()
    // The last line of defence. `finally` only runs once the promise SETTLES, so a turn
    // that never settles leaves the input disabled and the dots spinning forever — the
    // one failure the user cannot type their way out of. Racing a clock against it means
    // the worst case is an apology, not a locked box.
    const late = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('turn timed out')), models.timeouts.turnMs))
    try {
      // If `fn()` resolves after the clock has won, its result is simply dropped.
      const out = await Promise.race([fn(), late])
      dots.remove()
      await present(out)
    } catch (err) {
      dots.remove()
      // Never a dead end, even on an unexpected fault.
      bubbleFor('agent', err?.message === 'turn timed out' ? brand.voice.tooSlow : brand.voice.abstain)
      setChips(['Talk to a human'])
      console.error('ridgeline: turn failed', err)
    } finally {
      busy = false
      input.disabled = false
      if (open) input.focus()
    }
  }

  // What is on screen, in plain text. Cards are deliberately NOT stored: an order card
  // carries an address and the last four of a card, and none of that belongs in
  // localStorage. Restoring the words and re-fetching the records through the gates is
  // both safer and more honest than replaying a snapshot of someone's order.
  const said = []
  function record (role, text) {
    if (!memory?.enabled) return
    said.push({ role, text })
    memory.saveChat(said)
  }

  async function send (text) {
    if (!text.trim() || busy) return
    bubbleFor('user', text)
    record('user', text)
    input.value = ''
    await drive(() => agent.turn(text))
  }

  // A conversation resumed from an earlier visit. Marked, so nobody mistakes it for
  // something the agent just said, and cardless by design.
  function restore () {
    const earlier = memory?.loadChat?.()
    if (!earlier?.length) return false
    for (const m of earlier) { bubbleFor(m.role, m.text); said.push(m) }
    log.append(el('div', { class: 'chat__divider' },
      el('span', { class: 'eyebrow', text: 'Earlier — say "start over" to clear this' })))
    log.scrollTop = log.scrollHeight
    return true
  }

  form.addEventListener('submit', (ev) => { ev.preventDefault(); send(input.value) })

  /* ---------------------------------------------------------------------- open */

  function toggle (next) {
    open = next
    panel.hidden = !open
    bubble.setAttribute('aria-expanded', String(open))
    bubble.classList?.toggle?.('is-open', open)
    if (!open) return
    if (!log.children.length) {
      // A resumed conversation opens where it left off. Only a genuinely new one gets
      // the standing greeting.
      if (!restore()) bubbleFor('agent', brand.voice.greeting)
      setChips(brand.chips)
    }
    input.focus()
  }

  root.append(panel, bubble)
  return { open: () => toggle(true), close: () => toggle(false), send }
}
