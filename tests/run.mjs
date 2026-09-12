import { readdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { registered } from './harness.mjs'

const ROOT = fileURLToPath(new URL('.', import.meta.url))

async function walk (dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full))
    else if (entry.name.endsWith('.test.mjs')) out.push(full)
  }
  return out
}

const files = (await walk(ROOT)).sort()
for (const f of files) await import(pathToFileURL(f).href)

let pass = 0
const failures = []
for (const { name, fn } of registered()) {
  try {
    await fn()
    pass++
    console.log(`  ok   ${name}`)
  } catch (e) {
    failures.push({ name, message: e.message })
    console.log(`  FAIL ${name}`)
  }
}

console.log(`\n${pass} passed, ${failures.length} failed, ${files.length} files`)
for (const f of failures) console.log(`\n--- ${f.name}\n${f.message}`)
process.exit(failures.length ? 1 : 0)
