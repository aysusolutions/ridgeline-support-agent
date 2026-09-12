import { el } from './render.js'

// One polite live region for the whole widget. Screen readers announce each new agent
// message without stealing focus from whatever the user is doing.
export function createAnnouncer (mount) {
  const region = el('div', {
    class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true',
  })
  mount.append(region)
  return text => {
    region.textContent = ''
    // Re-setting on the next tick is what makes repeat announcements fire.
    queueMicrotask(() => { region.textContent = String(text) })
  }
}

// Keeps Tab inside the open panel. Escape is handled by the caller so it can also close.
export function trapFocus (panel) {
  const SELECTOR = 'button, [href], input, textarea, [tabindex]:not([tabindex="-1"])'
  panel.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return
    const items = [...panel.querySelectorAll(SELECTOR)].filter(n => !n.disabled)
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus() }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus() }
  })
}
