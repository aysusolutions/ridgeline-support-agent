const log = []

export const events = {
  emit (name, payload = {}) { log.push({ name, payload, seq: log.length }) },
  all () { return log.slice() },
  since (seq) { return log.filter(e => e.seq > seq) },
  count (name) { return log.filter(e => e.name === name).length },
  reset () { log.length = 0 },
}
