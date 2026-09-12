import { el } from './render.js'
import { specStrip } from './cards.js'
import { usd } from '../shared/format.js'
import { brand } from '../config/brand.js'
import { createThemeToggle } from './theme.js'

const CATEGORIES = ['tents', 'sleeping-bags', 'jackets', 'packs', 'boots']
const LABEL = { tents: 'Tents', 'sleeping-bags': 'Sleep', jackets: 'Jackets', packs: 'Packs', boots: 'Boots' }

// A ridgeline drawn as a topographic profile. The brand name is a landform, so the hero
// is that landform — no image files, no page weight, and it scales to any width.
function ridgeline () {
  const svg = document.createElementNS?.('http://www.w3.org/2000/svg', 'svg')
  if (!svg) return el('div')
  svg.setAttribute('viewBox', '0 0 1200 260')
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.setAttribute('class', 'ridge')
  svg.setAttribute('aria-hidden', 'true')

  const PEAK = 'M0,240 L90,196 L170,214 L280,120 L350,158 L430,96 L520,150 L610,64 ' +
               'L700,132 L790,104 L880,168 L980,128 L1080,186 L1200,150'
  const add = (d, cls, dy) => {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    p.setAttribute('d', d)
    p.setAttribute('class', cls)
    if (dy) p.setAttribute('transform', `translate(0 ${dy})`)
    svg.append(p)
  }
  // Contour lines below the ridge — the vernacular of the map, not decoration for its
  // own sake: they read as elevation.
  for (let i = 5; i >= 1; i--) add(PEAK, 'ridge__contour', i * 17)
  add(PEAK, 'ridge__line')
  return svg
}

export function mountStorefront (root, db, { onOpenChat } = {}) {
  root.textContent = ''

  const nav = el('header', { class: 'top' },
    el('a', { class: 'wordmark', href: '#main', text: brand.wordmark }),
    el('nav', { class: 'top__nav', 'aria-label': 'Categories' },
      ...CATEGORIES.map(c => el('a', { class: 'top__link', href: `#cat-${c}`, text: LABEL[c] }))),
    el('span', { class: 'top__meta eyebrow', text: 'Denver, CO' }),
    createThemeToggle())

  const hero = el('section', { class: 'hero' },
    ridgeline(),
    el('div', { class: 'hero__body' },
      el('span', { class: 'eyebrow', text: 'Outfitters since 2011' }),
      el('h1', { class: 'hero__title' },
        el('span', { text: 'Gear that earns' }),
        el('span', { text: 'its place in' }),
        el('span', { class: 'hero__accent', text: 'your pack' })),
      // Not the tagline — that is already the headline. Say something the headline can't.
      el('p', { class: 'hero__sub',
        text: 'Tested in the Front Range, shipped from Denver within a day. '
            + 'Every spec below is the one we measured, not the one on the box.' }),
      el('button', {
        class: 'btn btn--go hero__cta', type: 'button',
        text: 'Ask about an order', onclick: () => onOpenChat?.(),
      })))

  const grid = el('main', { class: 'shop', id: 'main' },
    ...CATEGORIES.map(cat => el('section', { class: 'shelf', id: `cat-${cat}` },
      el('div', { class: 'shelf__head' },
        el('h2', { class: 'shelf__title', text: LABEL[cat] }),
        el('span', { class: 'eyebrow', text: `${db.searchProducts({ category: cat }).length} items` })),
      el('div', { class: 'shelf__grid' },
        ...db.searchProducts({ category: cat }).map(p => {
          const out = p.stock === 0
          return el('article', { class: `tile${out ? ' is-out' : ''}` },
            el('div', { class: `tile__thumb tile__thumb--${cat}`, 'aria-hidden': 'true' }),
            el('h3', { class: 'tile__name', text: p.name }),
            el('p', { class: 'tile__spec spec', text: specStrip(p) }),
            el('div', { class: 'tile__foot' },
              el('span', { class: 'tile__price spec', text: usd(p.priceCents) }),
              el('span', { class: `tile__stock spec${out ? ' is-out' : ''}`,
                text: out ? 'Out of stock' : `${p.stock} left` })))
        })))))

  const foot = el('footer', { class: 'foot' },
    el('span', { class: 'eyebrow', text: `${brand.name} · a demo storefront` }),
    el('span', { class: 'eyebrow',
      text: `Support ${brand.hours.tzLabel} Mon–Fri ${brand.hours.open}–${brand.hours.close}` }))

  root.append(nav, hero, grid, foot)
}
