import { test, assert } from '../harness.mjs'
import {
  THEMES, THEME_KEY, readTheme, writeTheme, applyTheme, nextTheme, createThemeToggle,
} from '../../src/ui/theme.js'

// A storage that can be made hostile, because a private window throws on ACCESS.
const memStore = (initial = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    getItem: k => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    _map: map,
  }
}
const hostileStore = () => ({
  getItem () { throw new Error('site data blocked') },
  setItem () { throw new Error('site data blocked') },
})

test('light is the default, and only a known theme survives', () => {
  assert.eq(readTheme(memStore()), 'light', 'nothing stored means light')
  assert.eq(readTheme(memStore({ [THEME_KEY]: 'dark' })), 'dark', 'a stored choice is honoured')
  assert.eq(readTheme(memStore({ [THEME_KEY]: 'system' })), 'system', 'system too')
  // Anything else is someone else's key or a stale format.
  assert.eq(readTheme(memStore({ [THEME_KEY]: 'solarized' })), 'light', 'unknown falls back')
})

test('blocked storage never breaks the page, it only forgets', () => {
  // Private windows and blocked site data throw when you so much as read.
  assert.eq(readTheme(hostileStore()), 'light', 'reading throws, we still get a theme')
  writeTheme('dark', hostileStore())      // must not throw
})

test('system removes the attribute so the OS media query can win', () => {
  const root = { attrs: {},
    setAttribute (k, v) { this.attrs[k] = v },
    removeAttribute (k) { delete this.attrs[k] } }

  applyTheme('dark', root)
  assert.eq(root.attrs['data-theme'], 'dark', 'explicit dark is stamped')
  applyTheme('light', root)
  assert.eq(root.attrs['data-theme'], 'light', 'explicit light is stamped too')
  // The whole point: an attribute of "system" would beat the media query and pin the
  // theme, which is the opposite of what system means.
  applyTheme('system', root)
  assert.eq('data-theme' in root.attrs, false, 'system leaves no opinion in the markup')
})

test('the cycle covers every theme and returns to the start', () => {
  assert.eq(THEMES, ['light', 'dark', 'system'], 'three states')
  let t = 'light'
  const seen = [t]
  for (let i = 0; i < THEMES.length; i++) { t = nextTheme(t); seen.push(t) }
  assert.eq(seen, ['light', 'dark', 'system', 'light'], 'and it wraps')
})

test('the toggle label always matches the theme actually in force', () => {
  // It used to cache the theme in a closure, so anything else changing it left the button
  // reading "DARK" on a light page — and a visible label that disagrees with the
  // accessible name breaks voice control as well as trust.
  const store = memStore()
  const root = { attrs: {}, setAttribute (k, v) { this.attrs[k] = v }, removeAttribute (k) { delete this.attrs[k] } }
  const made = []
  const doc = {
    createElement: () => {
      const n = {
        children: [], dataset: {}, attrs: {}, textContent: '', className: '', type: '', title: '',
        append (...c) { this.children.push(...c) },
        setAttribute (k, v) { this.attrs[k] = v },
        getAttribute (k) { return this.attrs[k] ?? null },
        addEventListener (_e, fn) { this.click = fn },
      }
      made.push(n)
      return n
    },
  }
  const g = globalThis
  const realDoc = g.document
  const realLocal = g.localStorage
  try {
    Object.defineProperty(g, 'document', { value: { documentElement: root }, configurable: true })
    Object.defineProperty(g, 'localStorage', { value: store, configurable: true })

    const btn = createThemeToggle({ doc })
    const [icon, text] = btn.children
    assert.eq(text.textContent, 'Light', 'starts on light')
    assert.ok(/Switch to Dark/.test(btn.getAttribute('aria-label')), 'and says what comes next')

    btn.click()
    assert.eq(text.textContent, 'Dark', 'label follows the click')
    assert.eq(root.attrs['data-theme'], 'dark', 'and so does the document')
    assert.eq(icon.textContent, '☾', 'moon for dark')
    assert.eq(store.getItem(THEME_KEY), 'dark', 'the choice is remembered')

    btn.click()
    assert.eq(text.textContent, 'System', 'then system')
    assert.eq('data-theme' in root.attrs, false, 'attribute removed for system')
  } finally {
    Object.defineProperty(g, 'document', { value: realDoc, configurable: true })
    Object.defineProperty(g, 'localStorage', { value: realLocal, configurable: true })
  }
})
