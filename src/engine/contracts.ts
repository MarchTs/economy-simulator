import type { ScenarioConfig } from '../scenarios/types';
import { nextRandom, randomRange } from './rng';
import type { MarketEntry, QuestContract, Resource, ResourceId, StandingOfferContract } from './types';

const BOARD_TARGET_SIZE = 3;
const CUSTOMER_BOARD_TARGET_SIZE = 2;
const OFFER_LIFETIME_TURNS = 4;
const STANDING_BOARD_TARGET_SIZE = 2;

const ISSUERS = ['Local co-op', 'Regional distributor', 'Government procurement', 'Rival producer'];

interface QuestOfferRanges {
  issuer: string | string[];
  qtyRange: [number, number];
  premiumRange: [number, number];
  deadlineRange: [number, number];
  forceNoLawsuit?: boolean;
  idPrefix: string;
}

// `resources` must already be filtered to what the player has discovered —
// contracts never reference a resource the player wouldn't see in their own
// market list yet (see discovery.ts). Caller guarantees resources.length > 0.
function rollQuestOffer(
  rngState: number,
  resources: Resource[],
  market: Record<ResourceId, MarketEntry>,
  turn: number,
  idx: number,
  ranges: QuestOfferRanges
): { offer: QuestContract; nextState: number } {
  let state = rngState;

  const pickIdx = nextRandom(state);
  state = pickIdx.nextState;
  const resource = resources[Math.floor(pickIdx.value * resources.length)];

  const qtyRoll = randomRange(state, ranges.qtyRange[0], ranges.qtyRange[1]);
  state = qtyRoll.nextState;
  const qty = Math.round(qtyRoll.value);

  const deadlineRoll = randomRange(state, ranges.deadlineRange[0], ranges.deadlineRange[1]);
  state = deadlineRoll.nextState;
  const deadline = Math.round(deadlineRoll.value);

  const premiumRoll = randomRange(state, ranges.premiumRange[0], ranges.premiumRange[1]);
  state = premiumRoll.nextState;

  let issuer: string;
  if (Array.isArray(ranges.issuer)) {
    const issuerRoll = nextRandom(state);
    state = issuerRoll.nextState;
    issuer = ranges.issuer[Math.floor(issuerRoll.value * ranges.issuer.length)];
  } else {
    issuer = ranges.issuer;
  }

  const basePrice = market[resource.id]?.price ?? resource.basePrice;
  const payout = Math.round(basePrice * qty * premiumRoll.value);

  return {
    offer: {
      id: `${ranges.idPrefix}_${turn}_${idx}_${resource.id}`,
      issuer,
      resourceId: resource.id,
      qty,
      deadlineTurnsLeft: deadline,
      payout,
      reputationReward: Math.round(2 + premiumRoll.value * 4),
      penalty: Math.round(payout * 0.3),
      lawsuitOnBreach: ranges.forceNoLawsuit ? false : payout > 500,
      deliveredQty: 0,
      boardTurnsLeft: OFFER_LIFETIME_TURNS,
    },
    nextState: state,
  };
}

// Seeds two lanes of one-off quest offers whenever the board is running low:
// regular B2B/government deals (bulk qty, modest premium — doc §3.7), and
// "Customer" deals (a permanent extra demand source per user request: retail
// buyers want a tiny quantity of literally anything, but pay a steep premium
// for it — the opposite risk/reward shape from the bulk offers). Unaccepted
// offers of either kind expire after OFFER_LIFETIME_TURNS. Only resources the
// player has discovered are eligible — see discovery.ts.
export function refreshContractBoard(
  board: QuestContract[],
  scenario: ScenarioConfig,
  market: Record<ResourceId, MarketEntry>,
  rngState: number,
  turn: number,
  isDiscovered: (resourceId: ResourceId) => boolean
): { board: QuestContract[]; nextState: number } {
  let state = rngState;
  const remaining = board.filter((o) => {
    if (o.boardTurnsLeft === undefined) return true; // already accepted, not board's concern
    return o.boardTurnsLeft > 1;
  });
  for (const o of remaining) {
    if (o.boardTurnsLeft !== undefined) o.boardTurnsLeft -= 1;
  }

  const discoveredResources = scenario.resources.filter((r) => isDiscovered(r.id));
  if (discoveredResources.length === 0) return { board: remaining, nextState: state };

  const liveCount = (issuer: string) =>
    remaining.filter((o) => o.boardTurnsLeft !== undefined && o.issuer === issuer).length;
  const liveNonCustomerCount = remaining.filter(
    (o) => o.boardTurnsLeft !== undefined && o.issuer !== 'Customer'
  ).length;

  const needed = Math.max(0, BOARD_TARGET_SIZE - liveNonCustomerCount);
  for (let i = 0; i < needed; i++) {
    const rolled = rollQuestOffer(state, discoveredResources, market, turn, i, {
      issuer: ISSUERS,
      qtyRange: [5, 30],
      premiumRange: [1.1, 1.4],
      deadlineRange: [3, 8],
      idPrefix: 'quest',
    });
    state = rolled.nextState;
    remaining.push(rolled.offer);
  }

  const customerNeeded = Math.max(0, CUSTOMER_BOARD_TARGET_SIZE - liveCount('Customer'));
  for (let i = 0; i < customerNeeded; i++) {
    const rolled = rollQuestOffer(state, discoveredResources, market, turn, i, {
      issuer: 'Customer',
      qtyRange: [1, 4],
      premiumRange: [1.5, 2.5],
      deadlineRange: [2, 5],
      forceNoLawsuit: true,
      idPrefix: 'customer',
    });
    state = rolled.nextState;
    remaining.push(rolled.offer);
  }

  return { board: remaining, nextState: state };
}

// Seeds "long quest" offers: recurring "sell N/minute for T minutes" deals at
// a locked price. Accepting one becomes a standing SupplyContract, so it
// settles every minute via the same recurring auto-settle/breach logic as a
// player-proposed contract. Per doc §3.7 Type 2 — companies can *offer* these
// too, not just the player. Only discovered resources are eligible.
export function refreshStandingOfferBoard(
  board: StandingOfferContract[],
  scenario: ScenarioConfig,
  market: Record<ResourceId, MarketEntry>,
  rngState: number,
  turn: number,
  isDiscovered: (resourceId: ResourceId) => boolean
): { board: StandingOfferContract[]; nextState: number } {
  let state = rngState;
  const remaining = board.filter((o) => o.boardTurnsLeft > 1);
  for (const o of remaining) o.boardTurnsLeft -= 1;

  const discoveredResources = scenario.resources.filter((r) => isDiscovered(r.id));
  if (discoveredResources.length === 0) return { board: remaining, nextState: state };

  const needed = Math.max(0, STANDING_BOARD_TARGET_SIZE - remaining.length);
  for (let i = 0; i < needed; i++) {
    const pickIdx = nextRandom(state);
    state = pickIdx.nextState;
    const resource = discoveredResources[Math.floor(pickIdx.value * discoveredResources.length)];

    const qtyRoll = randomRange(state, 3, 10);
    state = qtyRoll.nextState;
    const qtyPerTurn = Math.round(qtyRoll.value);

    const durationRoll = randomRange(state, 6, 15);
    state = durationRoll.nextState;
    const turnsLeft = Math.round(durationRoll.value);

    const premiumRoll = randomRange(state, 1.05, 1.25);
    state = premiumRoll.nextState;

    const issuerRoll = nextRandom(state);
    state = issuerRoll.nextState;
    const issuer = ISSUERS[Math.floor(issuerRoll.value * ISSUERS.length)];

    const basePrice = market[resource.id]?.price ?? resource.basePrice;
    const price = Math.round(basePrice * premiumRoll.value * 10) / 10;

    remaining.push({
      id: `standing_${turn}_${i}_${resource.id}`,
      issuer,
      resourceId: resource.id,
      qtyPerTurn,
      price,
      turnsLeft,
      boardTurnsLeft: OFFER_LIFETIME_TURNS,
    });
  }

  return { board: remaining, nextState: state };
}
