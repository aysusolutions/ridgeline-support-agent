// The default adapter. Returns null for every job, which forces the deterministic path.
// Every conversation fixture must pass with this in place — if one only works with a real
// adapter, the seam has leaked and that is a bug, not a limitation.
export const nullAdapter = {
  async run () { return null },
}
