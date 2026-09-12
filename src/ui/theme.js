// Theme state and the control that changes it.
//
// The token layer already had everything: `:root` is light, `@media (prefers-color-scheme:
// dark)` covers a dark OS, and `:root[data-theme="light"|"dark"]` overrides both. What was
// missing was anything that SET the attribute, so the choice was never the shopper's.
//
// Three states, not two. Light and Dark are explicit; System hands the decision back to the
// operating system by removing the attribute and letting the media query apply. A two-way
// toggle cannot express "follow my machine", and on a dark-OS machine that is the state
// people most often actually want.

export const THEME_KEY = 'ridgeline:theme:v1'
export const THEMES = Object.freeze(['light', 'dark', 'system'])

const LABEL = { light: 'Light', dark: 'Dark', system: 'System' }

// Storage throws on access — not just on write — in a private window or with site data
// blocked. Every touch is guarded, and failing to remember is never failing to work.
export function readTheme (storage = safeStorage()) {
  try {
    const v = storage?.getItem(THEME_KEY)
    return THEMES.includes(v) ? v : 'light'
  } catch { return 'light' }
}

export function writeTheme (theme, storage = safeStorage()) {
  try { storage?.setItem(THEME_KEY, theme) } catch { /* a forgotten choice still works */ }
}

function safeStorage () {
  try { return globalThis.localStorage ?? null } catch { return null }
}

export function applyTheme (theme, root = globalThis.document?.documentElement) {
  if (!root) return theme
  // System means "no opinion in the markup" — that is what lets the media query win.
  if (theme === 'system') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', theme)
  return theme
}

// What the OS is asking for, used only to describe what `system` currently resolves to.
export function systemPrefers (win = globalThis) {
  try {
    return win.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light'
  } catch { return 'light' }
}

export function nextTheme (theme) {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
}

// A button rather than a select: one control, one tap, and it states what it will do next
// rather than only what it currently is — which is the part screen-reader users need.
export function createThemeToggle ({ doc = globalThis.document, onChange } = {}) {
  applyTheme(readTheme())

  const btn = doc.createElement('button')
  btn.type = 'button'
  btn.className = 'theme-toggle'

  const icon = doc.createElement('span')
  icon.className = 'theme-toggle__icon'
  icon.setAttribute('aria-hidden', 'true')

  const text = doc.createElement('span')
  text.className = 'theme-toggle__text'

  btn.append(icon, text)

  // No private copy of the state. An earlier version cached it in a closure, and the
  // moment anything else set the theme the button's label was confidently wrong — it read
  // "DARK" on a light page. Storage is the single source of truth and it is cheap to read.
  const paint = () => {
    const theme = readTheme()
    const resolved = theme === 'system' ? systemPrefers() : theme
    icon.textContent = resolved === 'dark' ? '☾' : '☀'
    // Visible text and accessible name must agree on the CURRENT state, or a voice-control
    // user asking for the button by its visible name does not get this button.
    text.textContent = LABEL[theme]
    btn.dataset.theme = theme
    btn.setAttribute('aria-label',
      `Theme: ${LABEL[theme]}${theme === 'system' ? ` (${resolved})` : ''}.`
      + ` Switch to ${LABEL[nextTheme(theme)]}.`)
    btn.title = btn.getAttribute('aria-label')
  }

  btn.addEventListener('click', () => {
    const theme = nextTheme(readTheme())
    applyTheme(theme)
    writeTheme(theme)
    paint()
    onChange?.(theme)
  })

  // While on `system`, follow the OS live rather than until the next reload.
  try {
    globalThis.matchMedia?.('(prefers-color-scheme: dark)')
      ?.addEventListener?.('change', () => { if (readTheme() === 'system') paint() })
  } catch { /* no matchMedia, no live updates — the button still works */ }

  // Another tab changing the theme should not leave this one mislabelled.
  try {
    globalThis.addEventListener?.('storage', (e) => {
      if (e?.key === THEME_KEY) { applyTheme(readTheme()); paint() }
    })
  } catch { /* no storage events, no cross-tab sync */ }

  paint()
  return btn
}
