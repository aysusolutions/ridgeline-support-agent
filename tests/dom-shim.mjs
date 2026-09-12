// A ~70-line DOM good enough to test rendering in Node without a browser or a dependency.
// It is deliberately dumb: no HTML parsing at all, which is exactly the property under
// test — if src/ui ever reaches for innerHTML assignment on untrusted content, it breaks
// here rather than shipping an XSS.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const escape = s => String(s).replace(/[&<>"]/g, c => ESC[c])

class Txt {
  constructor (text) { this.nodeType = 3; this.textContent = String(text) }
  get outerHTML () { return escape(this.textContent) }
}

class Frag {
  constructor () { this.children = [] }
  append (...n) { this.children.push(...n) }
}

class Elem {
  constructor (tag) {
    this.nodeType = 1
    this.tagName = tag.toUpperCase()
    this.attributes = {}
    this.children = []
    this.listeners = {}
    this.className = ''
    this._text = null
  }

  setAttribute (k, v) { this.attributes[k] = String(v) }
  getAttribute (k) { return this.attributes[k] ?? null }
  addEventListener (type, fn) { (this.listeners[type] ??= []).push(fn) }
  dispatch (type, ev = {}) { for (const fn of this.listeners[type] ?? []) fn(ev) }
  focus () { this.focused = true }
  remove () { this.removed = true }

  set textContent (v) { this._text = String(v); this.children = [] }
  get textContent () {
    if (this._text !== null) return this._text
    return this.children.map(c => c.textContent ?? '').join('')
  }

  append (...nodes) {
    if (this._text !== null) { this.children = [new Txt(this._text)]; this._text = null }
    this.children.push(...nodes.flatMap(n => (n instanceof Frag ? n.children : [n])))
  }

  querySelectorAll (sel) {
    const want = sel.replace(/^\./, '')
    const out = []
    const walk = n => {
      if (n.nodeType !== 1) return
      if (sel.startsWith('.') ? String(n.className).split(' ').includes(want)
        : n.tagName === sel.toUpperCase()) out.push(n)
      n.children.forEach(walk)
    }
    this.children.forEach(walk)
    return out
  }

  get innerHTML () {
    if (this._text !== null) return escape(this._text)
    return this.children.map(c => c.outerHTML ?? escape(c.textContent ?? '')).join('')
  }

  get outerHTML () {
    const attrs = Object.entries(this.attributes)
      .map(([k, v]) => ` ${k}="${escape(v)}"`).join('')
    const cls = this.className ? ` class="${escape(this.className)}"` : ''
    const tag = this.tagName.toLowerCase()
    return `<${tag}${cls}${attrs}>${this.innerHTML}</${tag}>`
  }
}

export function installDomShim () {
  globalThis.document = {
    createElement: t => new Elem(t),
    createTextNode: t => new Txt(t),
    createDocumentFragment: () => new Frag(),
  }
  globalThis.queueMicrotask ??= fn => Promise.resolve().then(fn)
  return { Elem, Txt, Frag }
}
