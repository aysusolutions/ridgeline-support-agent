/* Runs BEFORE first paint, so a shopper who chose dark never sees a white flash.
 *
 * A classic script in <head>, not a module: module scripts are deferred, which would put
 * this after the first paint and defeat the point. And not inline either — the page's CSP
 * is `script-src 'self'`, so an inline snippet would be blocked. Weakening the CSP for a
 * cosmetic flash would be a bad trade.
 *
 * Deliberately tiny and dependency-free. The only thing it knows is which attribute to set.
 */
(function () {
  var KEY = 'ridgeline:theme:v1'
  var stored = null
  // Private mode and blocked site data throw on ACCESS, not just on write.
  try { stored = localStorage.getItem(KEY) } catch (e) { stored = null }

  // Light is the default, on purpose: this shop is a light-first design and the dark
  // palette is the alternative, not the baseline. `system` is offered as an explicit
  // choice so anyone who wants their OS preference honoured can still have it.
  var theme = stored === 'dark' || stored === 'light' || stored === 'system' ? stored : 'light'

  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
})()
