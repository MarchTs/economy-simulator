// Seeded PRNG (mulberry32) so runs are reproducible from a single numeric seed.
// State is stored as a plain number on GameState so nextTurn stays a pure function.

export function nextRandom(state: number): { value: number; nextState: number } {
  let t = (state += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  return { value, nextState: state >>> 0 };
}

export function randomRange(state: number, min: number, max: number): { value: number; nextState: number } {
  const { value, nextState } = nextRandom(state);
  return { value: min + value * (max - min), nextState };
}
