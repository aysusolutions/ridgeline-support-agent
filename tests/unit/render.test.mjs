import { test, assert } from '../harness.mjs'
import { installDomShim } from '../dom-shim.mjs'

installDomShim()
const { mdLiteToHtmlString, linkAllowed, el } = await import('../../src/ui/render.js')

test('markdown-lite escapes html rather than parsing it', () => {
  assert.eq(mdLiteToHtmlString('<img src=x onerror=alert(1)>'),
    '&lt;img src=x onerror=alert(1)&gt;', 'escaped')
})

test('markdown-lite allows bold and italic only', () => {
  assert.eq(mdLiteToHtmlString('**bold** and _em_'),
    '<strong>bold</strong> and <em>em</em>', 'allowed')
})

test('no payload becomes markup — every angle bracket is escaped, not parsed', () => {
  for (const payload of ['<script>alert(1)</script>', '</textarea><script>x</script>',
                         '<svg onload=alert(1)>', '"><img src=x onerror=alert(1)>',
                         '<iframe src=javascript:alert(1)>']) {
    const out = mdLiteToHtmlString(payload)
    // The only tags the renderer can ever emit are strong, em and a.
    const tags = [...out.matchAll(/<\/?([a-z]+)/gi)].map(m => m[1].toLowerCase())
    assert.ok(tags.every(t => ['strong', 'em', 'a'].includes(t)),
      `only allowlisted tags, got [${tags}] from: ${payload}`)
    // And the payload's own brackets survive as visible text, which is the proof it was
    // escaped rather than swallowed.
    assert.ok(out.includes('&lt;'), `brackets escaped, not parsed: ${payload}`)
  }
})

test('javascript and data links are rejected', () => {
  assert.eq(linkAllowed('javascript:alert(1)'), false, 'js blocked')
  assert.eq(linkAllowed('data:text/html,<script>'), false, 'data blocked')
  assert.eq(linkAllowed('vbscript:msgbox'), false, 'vbscript blocked')
  assert.eq(linkAllowed('http://insecure.example'), false, 'plain http blocked')
  assert.eq(linkAllowed('https://ups.com/track'), true, 'https allowed')
  assert.eq(linkAllowed('mailto:help@ridgeline.example'), true, 'mailto allowed')
})

test('an autolinked url carries rel=noopener and is never javascript:', () => {
  const out = mdLiteToHtmlString('see https://ups.com/track/1Z9')
  assert.ok(out.includes('rel="noopener noreferrer nofollow"'), 'rel set')
  assert.eq(mdLiteToHtmlString('see javascript:alert(1)').includes('<a'), false,
    'js scheme never becomes a link')
})

test('el sets text with textContent, so markup in a value stays literal', () => {
  assert.eq(el('p', { text: '<b>not bold</b>' }).innerHTML, '&lt;b&gt;not bold&lt;/b&gt;',
    'literal')
})

test('el wires listeners without putting them in the DOM', () => {
  let fired = 0
  const b = el('button', { onclick: () => { fired++ } })
  assert.eq(b.getAttribute('onclick'), null, 'no inline handler attribute')
  b.dispatch('click')
  assert.eq(fired, 1, 'listener bound in a closure')
})
