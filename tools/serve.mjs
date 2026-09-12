// Local preview server. Serves the static site AND runs api/llm.js, so the full agent
// works locally with no Vercel login and no deployment.
//
//   node tools/serve.mjs          → http://localhost:5173
//
// Reads .env.local into process.env exactly as Vercel would. Not part of the deployed app.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PORT = Number(process.env.PORT ?? 5173)

/* --------------------------------------------------------------- .env.local */

try {
  const text = await readFile(join(ROOT, '.env.local'), 'utf8')
  let loaded = 0
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line)
    if (!m || !m[2].trim()) continue
    process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '')
    loaded++
  }
  console.log(`ridgeline: loaded ${loaded} key(s) from .env.local`)
} catch {
  console.log('ridgeline: no .env.local — the agent will run its deterministic path')
}

const { default: llmHandler } = await import('../api/llm.js')

/* ------------------------------------------------------------------ statics */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
}

const readBody = req => new Promise((done) => {
  let raw = ''
  req.on('data', c => { raw += c })
  req.on('end', () => { try { done(JSON.parse(raw || '{}')) } catch { done({}) } })
})

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)

  // Stand in for the Vercel function runtime: same handler, same (req, res) shape.
  if (urlPath === '/api/llm') {
    req.body = await readBody(req)
    const shim = {
      status (code) { res.statusCode = code; return shim },
      json (payload) {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify(payload))
        return shim
      },
    }
    try {
      await llmHandler(req, shim)
    } catch (e) {
      console.error('api/llm failed:', e.message)
      shim.status(200).json({ text: null })
    }
    return
  }

  const target = resolve(join(ROOT, urlPath === '/' ? '/index.html' : urlPath))
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    res.writeHead(403).end('forbidden')
    return
  }

  try {
    const body = await readFile(target)
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    }).end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
  }
}).listen(PORT, () => {
  console.log(`ridgeline: http://localhost:${PORT}`)
  console.log(`           groq ${process.env.GROQ_API_KEY ? 'live' : 'absent'} · gemini ${process.env.GEMINI_API_KEY ? 'live' : 'absent'}`)
})
