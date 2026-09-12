// Every string that reaches the DOM goes through here.
//
// The rule is absolute: user and model content is set with textContent, never innerHTML.
// Markdown-lite builds real nodes rather than parsing HTML, so there is no path from a
// string to an element — which is a stronger position than escaping and hoping.

const ALLOWED_SCHEMES = new Set(['https:', 'mailto:'])

export function linkAllowed (href) {
  try {
    const url = new URL(String(href), 'https://ridgeline.example')
    return ALLOWED_SCHEMES.has(url.protocol)
  } catch {
    return false
  }
}

export function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue
    if (k === 'class') node.className = v
    else if (k === 'text') node.textContent = v            // never innerHTML
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v)
    else node.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue
    node.append(typeof c === 'string' ? document.createTextNode(c) : c)
  }
  return node
}

const INLINE = /(\*\*[^*]+\*\*|_[^_]+_|https?:\/\/[^\s)]+)/g

// Bold, italic and links only. Everything else stays literal text.
export function mdLite (text) {
  const frag = document.createDocumentFragment()
  for (const part of String(text ?? '').split(INLINE)) {
    if (!part) continue
    if (/^\*\*[^*]+\*\*$/.test(part)) {
      frag.append(el('strong', { text: part.slice(2, -2) }))
    } else if (/^_[^_]+_$/.test(part)) {
      frag.append(el('em', { text: part.slice(1, -1) }))
    } else if (/^https?:\/\//.test(part) && linkAllowed(part)) {
      frag.append(el('a', {
        href: part, text: part, rel: 'noopener noreferrer nofollow', target: '_blank',
      }))
    } else {
      frag.append(document.createTextNode(part))
    }
  }
  return frag
}

// Test seam: the same pipeline, serialised. Used by the render tests, which run in Node
// against a minimal DOM shim rather than a browser.
export function mdLiteToHtmlString (text) {
  const holder = el('span')
  holder.append(mdLite(text))
  return holder.innerHTML
}
