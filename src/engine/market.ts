import type { MarketEntry, ResourceId } from './types';
import { randomRange } from './rng';

const PRESSURE_K = 0.05;
const MAX_TURN_CHANGE = 0.15;
const FLOOR_FACTOR = 0.4;
const CEILING_FACTOR = 4.0;

// new_price = old_price * (1 + drift + pressure), clamped to +-15%/turn and
// to [40%, 400%] of the resource's base price. See doc §4.
export function updatePrice(
  entry: MarketEntry,
  basePrice: number,
  rngState: number
): { entry: MarketEntry; nextState: number } {
  const { value: drift, nextState } = randomRange(rngState, -0.03, 0.03);
  const pressure = entry.supply > 0 ? (PRESSURE_K * (entry.demand - entry.supply)) / entry.supply : 0;
  const rawChange = drift + pressure;
  const clampedChange = Math.max(-MAX_TURN_CHANGE, Math.min(MAX_TURN_CHANGE, rawChange));
  let price = entry.price * (1 + clampedChange);
  price = Math.max(basePrice * FLOOR_FACTOR, Math.min(basePrice * CEILING_FACTOR, price));
  return { entry: { ...entry, price }, nextState };
}

export function updateAllMarkets(
  market: Record<ResourceId, MarketEntry>,
  basePrices: Record<ResourceId, number>,
  rngState: number
): { market: Record<ResourceId, MarketEntry>; nextState: number } {
  let state = rngState;
  const next: Record<ResourceId, MarketEntry> = {};
  for (const id of Object.keys(market)) {
    const { entry, nextState } = updatePrice(market[id], basePrices[id], state);
    next[id] = entry;
    state = nextState;
  }
  return { market: next, nextState: state };
}
