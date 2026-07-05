import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/brewery/config';
import { newGame } from './newGame';
import {
  applyCommand,
  effectiveCapacity,
  estimateBills,
  levelUpCost,
  levelUpDuration,
  loanCreditLimit,
  LOAN_TERM_TURNS,
  MAX_FACILITY_LEVEL,
  outstandingDebt,
  tick,
  type Command,
} from './reducer';
import type { GameState } from './types';

function totalMoneyInSystem(state: GameState): number {
  const rivalCash = state.rivals.reduce((sum, r) => sum + r.cash, 0);
  return state.player.cash + rivalCash;
}

// Apply a batch of instant commands, then advance one simulation tick.
function step(state: GameState, cmds: Command[] = []): GameState {
  let s = state;
  for (const c of cmds) s = applyCommand(s, c, breweryScenario);
  return tick(s, breweryScenario);
}

describe('newGame', () => {
  it('starts with the scenario starting cash and one active license', () => {
    const state = newGame(breweryScenario, 42);
    expect(state.player.cash).toBe(breweryScenario.startingCash);
    expect(state.player.licenses).toHaveLength(1);
    expect(state.player.licenses[0].status).toBe('active');
  });
});

describe('tick', () => {
  it('is deterministic for a given seed', () => {
    const a = tick(newGame(breweryScenario, 7), breweryScenario);
    const b = tick(newGame(breweryScenario, 7), breweryScenario);
    expect(a.player.cash).toBe(b.player.cash);
    expect(a.market).toEqual(b.market);
  });

  it('advances the tick counter', () => {
    const state = newGame(breweryScenario, 1);
    expect(tick(state, breweryScenario).turn).toBe(state.turn + 1);
  });

  it('clamps market prices within [40%, 400%] of base price over many ticks', () => {
    let state = newGame(breweryScenario, 3);
    for (let i = 0; i < 200; i++) state = tick(state, breweryScenario);
    for (const r of breweryScenario.resources) {
      const entry = state.market[r.id];
      expect(entry.price).toBeGreaterThanOrEqual(r.basePrice * 0.4 - 1e-6);
      expect(entry.price).toBeLessThanOrEqual(r.basePrice * 4 + 1e-6);
    }
  });

  it('detects bankruptcy when cash goes negative', () => {
    const state = newGame(breweryScenario, 5);
    state.player.cash = 1;
    expect(tick(state, breweryScenario).gameOver?.result).toBe('bankrupt');
  });

  it('declares a win at the target tick', () => {
    const state = newGame(breweryScenario, 5);
    state.turn = 60;
    expect(tick(state, breweryScenario).gameOver?.result).toBe('won');
  });

  it('never creates money from nowhere across a tick (no external faucet in v1)', () => {
    const state = newGame(breweryScenario, 9);
    const before = totalMoneyInSystem(state);
    const after = totalMoneyInSystem(tick(state, breweryScenario));
    expect(after).toBeLessThanOrEqual(before);
  });

  it('applies an active cost-multiplier effect (e.g. energy spike) to facility upkeep', () => {
    // With spot trading removed, upkeep is the only place a "production cost"
    // event can still bite — verify it actually raises the upkeep charge.
    const state = newGame(breweryScenario, 5);
    const control = newGame(breweryScenario, 5);
    state.activeEffects.push({
      id: 'test_cost_spike',
      kind: 'disaster',
      label: 'test spike',
      turnsLeft: 3,
      effect: { type: 'costMultiplier', multiplier: 1.25 },
    });
    const next = tick(state, breweryScenario);
    const nextControl = tick(control, breweryScenario);
    const farmUpkeep = breweryScenario.facilityTypes.find((f) => f.type === 'farm')!.upkeepPerTurn;
    expect(nextControl.player.cash - next.player.cash).toBeCloseTo(farmUpkeep * 0.25, 5);
  });

  it('seeds a contract board within a few ticks', () => {
    let state = newGame(breweryScenario, 11);
    for (let i = 0; i < 3; i++) state = tick(state, breweryScenario);
    expect(state.contractBoard.length).toBeGreaterThan(0);
    for (const offer of state.contractBoard) {
      expect(offer.boardTurnsLeft).toBeGreaterThan(0);
      expect(offer.qty).toBeGreaterThan(0);
    }
  });

  it('only generates contract/standing-offer board resources the player has discovered', () => {
    // At game start only barley extraction is known — every generated offer,
    // on both boards, must reference barley (or a resource the player has
    // since become licensed/inventoried in, which at this point is just barley).
    let state = newGame(breweryScenario, 11);
    for (let i = 0; i < 5; i++) state = tick(state, breweryScenario);
    expect(state.contractBoard.length + state.standingOfferBoard.length).toBeGreaterThan(0);
    for (const offer of state.contractBoard) expect(offer.resourceId).toBe('barley');
    for (const offer of state.standingOfferBoard) expect(offer.resourceId).toBe('barley');
  });

  it('opens up new contract-board resources once the player discovers them', () => {
    let state = newGame(breweryScenario, 11);
    // Discover malt (ingredient-of-known also reveals nothing new beyond
    // barley/malt themselves here) and confirm malt can now appear on the board.
    state.player.knowledge.knownRecipeIds.add('recipe_malt');
    let sawMalt = false;
    for (let i = 0; i < 30 && !sawMalt; i++) {
      state = tick(state, breweryScenario);
      sawMalt = state.contractBoard.some((o) => o.resourceId === 'malt') || state.standingOfferBoard.some((o) => o.resourceId === 'malt');
    }
    expect(sawMalt).toBe(true);
    // Still never anything beyond the discovered set (barley, malt).
    for (const offer of state.contractBoard) expect(['barley', 'malt']).toContain(offer.resourceId);
    for (const offer of state.standingOfferBoard) expect(['barley', 'malt']).toContain(offer.resourceId);
  });

  it('seeds a permanent "Customer" lane on the contract board: small qty, high premium', () => {
    let state = newGame(breweryScenario, 11);
    for (let i = 0; i < 3; i++) state = tick(state, breweryScenario);
    const customerOffers = state.contractBoard.filter((o) => o.issuer === 'Customer');
    expect(customerOffers.length).toBeGreaterThan(0);
    for (const offer of customerOffers) {
      expect(offer.qty).toBeLessThanOrEqual(4);
      expect(offer.lawsuitOnBreach).toBe(false);
      const resourceBase = breweryScenario.resources.find((r) => r.id === offer.resourceId)!.basePrice;
      // Customer offers pay a steep premium (1.5x-2.5x) — payout per unit should
      // clear the resource's base price with real room to spare.
      expect(offer.payout / offer.qty).toBeGreaterThan(resourceBase * 1.3);
    }
  });

  it('keeps the Customer lane and the regular quest lane replenishing independently', () => {
    let state = newGame(breweryScenario, 11);
    for (let i = 0; i < 3; i++) state = tick(state, breweryScenario);
    const nonCustomer = state.contractBoard.filter((o) => o.issuer !== 'Customer');
    const customer = state.contractBoard.filter((o) => o.issuer === 'Customer');
    expect(nonCustomer.length).toBeGreaterThan(0);
    expect(customer.length).toBeGreaterThan(0);
  });
});

describe('applyCommand — production & licensing', () => {
  it('extracts a tier-0 material instantly when licensed, known, and staffed', () => {
    const state = newGame(breweryScenario, 5);
    const next = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 5 }, breweryScenario);
    expect(next.player.inventory['barley']?.qty ?? 0).toBe(5);
  });

  it('gates production on holding an active license', () => {
    const state = newGame(breweryScenario, 5);
    // Player is not licensed for hops (and doesn't know hops extraction).
    const next = applyCommand(state, { kind: 'produce', resourceId: 'hops', qty: 10 }, breweryScenario);
    expect(next.player.inventory['hops']?.qty ?? 0).toBe(0);
  });

  it('requires a known extraction recipe to produce a tier-0 material', () => {
    const state = newGame(breweryScenario, 5);
    state.player.licenses.push({ resourceId: 'rice', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    const next = applyCommand(state, { kind: 'produce', resourceId: 'rice', qty: 5 }, breweryScenario);
    expect(next.player.inventory['rice']?.qty ?? 0).toBe(0); // no rice extraction recipe known
  });

  it('caps production at per-tick capacity even across repeated commands', () => {
    let state = newGame(breweryScenario, 5);
    // Farm capacity is 20/tick. Five produce commands of 10 should not exceed 20.
    for (let i = 0; i < 5; i++) {
      state = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 10 }, breweryScenario);
    }
    expect(state.player.inventory['barley'].qty).toBe(20);
    // After a tick the budget resets, allowing more.
    state = tick(state, breweryScenario);
    state = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 10 }, breweryScenario);
    expect(state.player.inventory['barley'].qty).toBe(30);
  });

  it('auto-produces an enabled output every tick up to capacity', () => {
    // Seed 1 fires no disruptive event in the first two ticks.
    let state = newGame(breweryScenario, 1);
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'barley', on: true }, breweryScenario);
    expect(state.player.autoProduce).toContain('barley');
    const before = state.player.inventory['barley']?.qty ?? 0;
    state = tick(state, breweryScenario);
    // Farm capacity is 20/tick; one tick should add 20 barley.
    expect((state.player.inventory['barley']?.qty ?? 0) - before).toBe(20);
    state = tick(state, breweryScenario);
    expect(state.player.inventory['barley'].qty).toBe(40);
  });

  it('stops auto-producing once disabled', () => {
    let state = newGame(breweryScenario, 1);
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'barley', on: true }, breweryScenario);
    state = tick(state, breweryScenario);
    const held = state.player.inventory['barley'].qty;
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'barley', on: false }, breweryScenario);
    state = tick(state, breweryScenario);
    expect(state.player.inventory['barley'].qty).toBe(held); // unchanged after disabling
  });

  it('does not auto-produce a crafted good when its ingredients are missing', () => {
    let state = newGame(breweryScenario, 5);
    state.player.knowledge.knownRecipeIds.add('recipe_malt');
    state.player.licenses.push({ resourceId: 'malt', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.facilities.push({
      id: 'facility_malt', type: 'malthouse', assignedResourceId: 'malt', capacityPerTurn: 15, level: 1, buildTurnsLeft: 0, upkeepPerTurn: 10,
      requiredWorkers: 3, hiredWorkers: 3, wageRatio: 1.0, condition: 100, maintenanceFunded: true, capacityUsedThisTick: 0,
    });
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'malt', on: true }, breweryScenario);
    state = tick(state, breweryScenario); // no barley in inventory → no malt
    expect(state.player.inventory['malt']?.qty ?? 0).toBe(0);
  });

});

describe('facility dedication & leveling', () => {
  it('rejects building a facility with a resource that does not match its type', () => {
    const state = newGame(breweryScenario, 5);
    const cashBefore = state.player.cash;
    // 'barley' is a farm resource, not a malthouse one.
    const next = applyCommand(state, { kind: 'buildFacility', facilityType: 'malthouse', resourceId: 'barley' }, breweryScenario);
    expect(next.player.facilities).toHaveLength(1); // unchanged
    expect(next.player.cash).toBe(cashBefore);
  });

  it('a facility only produces the resource it is currently dedicated to', () => {
    const state = newGame(breweryScenario, 5);
    state.player.licenses.push({ resourceId: 'hops', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.knowledge.knownRecipeIds.add('recipe_extract_hops');
    // The only farm is still dedicated to barley — hops has nowhere to produce.
    const next = applyCommand(state, { kind: 'produce', resourceId: 'hops', qty: 5 }, breweryScenario);
    expect(next.player.inventory['hops']?.qty ?? 0).toBe(0);
  });

  it('reassigning a facility switches which resource it can produce', () => {
    let state = newGame(breweryScenario, 5);
    state.player.licenses.push({ resourceId: 'hops', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.knowledge.knownRecipeIds.add('recipe_extract_hops');
    const farmId = state.player.facilities[0].id;

    state = applyCommand(state, { kind: 'reassignFacility', facilityId: farmId, resourceId: 'hops' }, breweryScenario);
    const madeHops = applyCommand(state, { kind: 'produce', resourceId: 'hops', qty: 5 }, breweryScenario);
    expect(madeHops.player.inventory['hops']?.qty ?? 0).toBeGreaterThan(0);

    // The sole farm is now dedicated to hops, so barley can no longer be made.
    const madeBarley = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 5 }, breweryScenario);
    expect(madeBarley.player.inventory['barley']?.qty ?? 0).toBe(0);
  });

  it('leveling up costs cash and time, and keeps producing at the current level meanwhile', () => {
    let state = newGame(breweryScenario, 5);
    const facility = state.player.facilities[0];
    const def = breweryScenario.facilityTypes.find((f) => f.type === facility.type)!;
    const cost = levelUpCost(def, facility.level);
    const duration = levelUpDuration(def);
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'levelUpFacility', facilityId: facility.id }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - cost);
    expect(state.player.facilities[0].levelUpTurnsLeft).toBe(duration);
    expect(state.player.facilities[0].level).toBe(1); // not applied yet

    const midUpgrade = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 1000 }, breweryScenario);
    expect(midUpgrade.player.inventory['barley'].qty).toBe(def.baseCapacity); // still level-1 capacity

    for (let i = 0; i < duration; i++) state = tick(state, breweryScenario);
    expect(state.player.facilities[0].level).toBe(2);
    expect(state.player.facilities[0].levelUpTurnsLeft).toBeUndefined();
  });

  it('a higher level facility has more effective capacity', () => {
    const state = newGame(breweryScenario, 5);
    const facility = state.player.facilities[0];
    const capL1 = effectiveCapacity(facility);
    const capL2 = effectiveCapacity({ ...facility, level: 2 });
    expect(capL2).toBeGreaterThan(capL1);
  });

  it('cannot level up past the max level', () => {
    const state = newGame(breweryScenario, 5);
    state.player.cash = 1_000_000;
    state.player.facilities[0].level = MAX_FACILITY_LEVEL;
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'levelUpFacility', facilityId: state.player.facilities[0].id }, breweryScenario);
    expect(next.player.cash).toBe(cashBefore);
    expect(next.player.facilities[0].levelUpTurnsLeft).toBeUndefined();
  });
});

describe('applyCommand — research ladder', () => {
  it('blind research discovers a reachable recipe after 3 ticks', () => {
    let state = newGame(breweryScenario, 4);
    const before = new Set(state.player.knowledge.knownRecipeIds);
    state = applyCommand(state, { kind: 'researchBlind' }, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    const after = state.player.knowledge.knownRecipeIds;
    expect(after.size).toBe(before.size + 1);
  });

  it('blind research never skips ahead to a recipe with undiscovered ingredients', () => {
    let state = newGame(breweryScenario, 8);
    state = step(state, [{ kind: 'researchBlind' }]);
    state = step(state);
    state = step(state);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_keg_beer')).toBe(false);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_bottled_beer')).toBe(false);
  });

  it('ingredient-directed research discovers a recipe built from the chosen ingredients', () => {
    let state = newGame(breweryScenario, 6);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'] }]);
    state = step(state);
    state = step(state);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_malt')).toBe(true);
  });

  it('ingredient-directed research will not discover a recipe needing unselected ingredients', () => {
    let state = newGame(breweryScenario, 6);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'] }]);
    state = step(state);
    state = step(state);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_keg_beer')).toBe(false);
  });
});

describe('discovery disclosure', () => {
  function discoverMalt(seed: number) {
    let state = newGame(breweryScenario, seed);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'] }]);
    state = step(state);
    state = step(state);
    return state;
  }

  // recipe_extract_hops starts unpublished (unlike recipe_malt, which the
  // scenario config marks published from turn 1) — the right fixture for
  // asserting rivals do/don't learn a recipe based on the disclosure choice.
  function withPendingHopsDisclosure(seed: number) {
    const state = newGame(breweryScenario, seed);
    state.player.knowledge.knownRecipeIds.add('recipe_extract_hops');
    state.pendingDisclosures.push({ recipeId: 'recipe_extract_hops' });
    return state;
  }

  it('queues a pending disclosure for the newly discovered recipe', () => {
    const state = discoverMalt(6);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_malt')).toBe(true);
    expect(state.pendingDisclosures).toHaveLength(1);
    expect(state.pendingDisclosures[0].recipeId).toBe('recipe_malt');
  });

  it('"free" publishes the recipe to every rival immediately', () => {
    let state = withPendingHopsDisclosure(6);
    state = applyCommand(state, { kind: 'resolveDisclosure', choice: 'free' }, breweryScenario);
    expect(state.pendingDisclosures).toHaveLength(0);
    const recipe = state.recipes.find((r) => r.id === 'recipe_extract_hops')!;
    expect(recipe.published).toBe(true);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_extract_hops')).toBe(true);
  });

  it('"exclusive" keeps it private for 30 minutes, then auto-publishes', () => {
    let state = withPendingHopsDisclosure(6);
    state = applyCommand(state, { kind: 'resolveDisclosure', choice: 'exclusive' }, breweryScenario);
    let recipe = state.recipes.find((r) => r.id === 'recipe_extract_hops')!;
    expect(recipe.exclusiveTurnsLeft).toBe(30);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_extract_hops')).toBe(false);

    for (let i = 0; i < 29; i++) state = tick(state, breweryScenario);
    recipe = state.recipes.find((r) => r.id === 'recipe_extract_hops')!;
    expect(recipe.published).toBe(false);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_extract_hops')).toBe(false);

    state = tick(state, breweryScenario); // 30th tick — timer lapses
    recipe = state.recipes.find((r) => r.id === 'recipe_extract_hops')!;
    expect(recipe.published).toBe(true);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_extract_hops')).toBe(true);
  });

  it('"sell" pays the player, teaches only the buyer, and keeps it unpublished', () => {
    let state = withPendingHopsDisclosure(6);
    const cashBefore = state.player.cash;
    const rivalCashBefore = state.rivals.map((r) => r.cash);
    state = applyCommand(state, { kind: 'resolveDisclosure', choice: 'sell' }, breweryScenario);

    const recipe = state.recipes.find((r) => r.id === 'recipe_extract_hops')!;
    expect(recipe.published).toBe(false);
    expect(state.player.cash).toBeGreaterThan(cashBefore);

    const buyers = state.rivals.filter((r) => r.knownRecipeIds.has('recipe_extract_hops'));
    expect(buyers).toHaveLength(1); // only one rival learns it, not all
    const buyerIdx = state.rivals.indexOf(buyers[0]);
    expect(rivalCashBefore[buyerIdx] - buyers[0].cash).toBe(state.player.cash - cashBefore); // closed-loop: buyer pays exactly what player receives
  });

  it('resolving with no pending disclosure is a safe no-op', () => {
    const state = newGame(breweryScenario, 6);
    expect(state.pendingDisclosures).toHaveLength(0);
    const next = applyCommand(state, { kind: 'resolveDisclosure', choice: 'free' }, breweryScenario);
    expect(next.pendingDisclosures).toHaveLength(0);
  });
});

describe('applyCommand — contracts', () => {
  it('lets the player accept a board offer, moving it into active quest contracts', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.contractBoard[0];
    const next = applyCommand(state, { kind: 'acceptQuestContract', id: offer.id }, breweryScenario);
    expect(next.contractBoard.some((o) => o.id === offer.id)).toBe(false);
    expect(next.player.questContracts.some((c) => c.id === offer.id)).toBe(true);
  });

  it('delivers a quest contract instantly once enough inventory is on hand', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.contractBoard[0];
    state = applyCommand(state, { kind: 'acceptQuestContract', id: offer.id }, breweryScenario);
    state.player.inventory[offer.resourceId] = { qty: offer.qty, ageTurns: 0 };
    const cashBefore = state.player.cash;
    const turnBefore = state.turn;
    const next = applyCommand(state, { kind: 'deliverQuestContract', id: offer.id }, breweryScenario);
    expect(next.player.questContracts.some((c) => c.id === offer.id)).toBe(false);
    expect(next.player.cash).toBe(cashBefore + offer.payout);
    expect(next.turn).toBe(turnBefore); // instant — no tick elapses
  });

  it('does not deliver a quest contract when inventory is insufficient', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.contractBoard[0];
    state = applyCommand(state, { kind: 'acceptQuestContract', id: offer.id }, breweryScenario);
    const next = applyCommand(state, { kind: 'deliverQuestContract', id: offer.id }, breweryScenario);
    expect(next.player.questContracts.some((c) => c.id === offer.id)).toBe(true);
  });

  it('charges half the miss penalty when a quest contract is cancelled', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.contractBoard[0];
    state = applyCommand(state, { kind: 'acceptQuestContract', id: offer.id }, breweryScenario);
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'cancelQuestContract', id: offer.id }, breweryScenario);
    expect(next.player.questContracts).toHaveLength(0);
    expect(cashBefore - next.player.cash).toBe(Math.round(offer.penalty * 0.5));
  });

  it('settles a standing supply contract on the next tick', () => {
    let state = newGame(breweryScenario, 5);
    state.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    expect(state.player.supplyContracts).toHaveLength(1);

    // Compare against a control run that never proposed the contract, to isolate
    // the +revenue / -inventory settlement from ordinary upkeep.
    let control = newGame(breweryScenario, 5);
    control.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    const withC = tick(state, breweryScenario);
    const withoutC = tick(control, breweryScenario);
    expect(withC.player.cash - withoutC.player.cash).toBe(5 * 4);
    expect(withC.player.inventory['barley'].qty - withoutC.player.inventory['barley'].qty).toBe(-5);
  });

  it('charges the cancellation fine when a supply contract is cancelled', () => {
    let state = newGame(breweryScenario, 5);
    state.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    const id = state.player.supplyContracts[0].id;
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'cancelSupplyContract', id }, breweryScenario);
    expect(next.player.supplyContracts).toHaveLength(0);
    expect(next.player.cash).toBeLessThan(cashBefore);
  });

  it('seeds a standing-offer board with recurring "long quest" deals', () => {
    let state = newGame(breweryScenario, 11);
    for (let i = 0; i < 3; i++) state = tick(state, breweryScenario);
    expect(state.standingOfferBoard.length).toBeGreaterThan(0);
    for (const offer of state.standingOfferBoard) {
      expect(offer.qtyPerTurn).toBeGreaterThan(0);
      expect(offer.turnsLeft).toBeGreaterThan(0);
      expect(offer.boardTurnsLeft).toBeGreaterThan(0);
    }
  });

  it('accepting a standing offer creates a matching recurring supply contract', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.standingOfferBoard[0];
    const next = applyCommand(state, { kind: 'acceptStandingOffer', id: offer.id }, breweryScenario);
    expect(next.standingOfferBoard.some((o) => o.id === offer.id)).toBe(false);
    const created = next.player.supplyContracts.find((c) => c.resourceId === offer.resourceId);
    expect(created).toBeDefined();
    expect(created?.side).toBe('sell');
    expect(created?.qtyPerTurn).toBe(offer.qtyPerTurn);
    expect(created?.price).toBe(offer.price);
    expect(created?.turnsLeft).toBe(offer.turnsLeft);
    expect(created?.counterparty).toBe(offer.issuer);
  });

  it('settles an accepted standing offer every minute like any other supply contract', () => {
    let state = newGame(breweryScenario, 11);
    state = tick(state, breweryScenario);
    const offer = state.standingOfferBoard[0];
    state = applyCommand(state, { kind: 'acceptStandingOffer', id: offer.id }, breweryScenario);
    state.player.inventory[offer.resourceId] = { qty: 1000, ageTurns: 0 };

    let control = newGame(breweryScenario, 11);
    control = tick(control, breweryScenario);
    control.player.inventory[offer.resourceId] = { qty: 1000, ageTurns: 0 };

    const withC = tick(state, breweryScenario);
    const withoutC = tick(control, breweryScenario);
    expect(withC.player.cash - withoutC.player.cash).toBeCloseTo(offer.qtyPerTurn * offer.price, 5);
    expect(withC.player.inventory[offer.resourceId].qty - withoutC.player.inventory[offer.resourceId].qty).toBe(-offer.qtyPerTurn);
  });
});

describe('bank loan', () => {
  it('grants cash immediately and records principal + 20% interest as owed', () => {
    const state = newGame(breweryScenario, 5);
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    expect(next.player.cash).toBe(cashBefore + 500);
    expect(next.player.loans).toHaveLength(1);
    expect(next.player.loans[0].principal).toBe(500);
    expect(next.player.loans[0].remaining).toBe(600); // 500 * 1.2
    expect(next.player.loans[0].termTurnsLeft).toBe(LOAN_TERM_TURNS);
  });

  it('rejects a loan above the credit limit', () => {
    const state = newGame(breweryScenario, 5);
    const limit = loanCreditLimit(state.player, breweryScenario);
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'takeLoan', amount: limit + 1000 }, breweryScenario);
    expect(next.player.cash).toBe(cashBefore);
    expect(next.player.loans).toHaveLength(0);
  });

  it('credit limit shrinks as outstanding debt grows', () => {
    let state = newGame(breweryScenario, 5);
    const limitBefore = loanCreditLimit(state.player, breweryScenario);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    expect(outstandingDebt(state.player)).toBe(600);
    const limitAfter = loanCreditLimit(state.player, breweryScenario);
    expect(limitAfter).toBeLessThan(limitBefore);
  });

  it('settles the loan payment automatically each minute', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];

    const control = newGame(breweryScenario, 5); // never took the loan — isolates the payment from ordinary upkeep
    state.player.cash = control.player.cash; // equalize cash so the +500 injection doesn't skew the comparison

    const withLoan = tick(state, breweryScenario);
    const withoutLoan = tick(control, breweryScenario);

    expect(withLoan.player.cash - withoutLoan.player.cash).toBeCloseTo(-loan.paymentPerTurn, 5);
    expect(withLoan.player.loans[0].remaining).toBeCloseTo(loan.remaining - loan.paymentPerTurn, 5);
  });

  it('records a missed payment and a reputation penalty when cash is insufficient, without throwing', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    state.player.cash = 0; // can't cover even the next payment
    const repBefore = state.player.reputation;
    const next = tick(state, breweryScenario);
    expect(next.player.loans[0].missedPayments).toBe(1);
    expect(next.player.reputation).toBeLessThan(repBefore);
    expect(next.player.loans[0].remaining).toBe(state.player.loans[0].remaining); // untouched — payment skipped, not partial
  });

  it('paying off a loan removes it from the books', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'repayLoanEarly', loanId: loan.id }, breweryScenario);
    expect(next.player.loans).toHaveLength(0);
    expect(next.player.cash).toBe(cashBefore - loan.remaining);
  });

  it('cannot repay early without enough cash on hand', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];
    state.player.cash = 0;
    const next = applyCommand(state, { kind: 'repayLoanEarly', loanId: loan.id }, breweryScenario);
    expect(next.player.loans).toHaveLength(1); // still there — repayment rejected
  });

  it('a fully repaid loan (via ticks) disappears from the books on its own', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 100 }, breweryScenario);
    state.player.cash = 10_000; // plenty to cover every payment on time
    for (let i = 0; i < LOAN_TERM_TURNS; i++) state = tick(state, breweryScenario);
    expect(state.player.loans).toHaveLength(0);
  });
});

describe('estimateBills', () => {
  it('includes the starting facility upkeep and payroll', () => {
    const state = newGame(breweryScenario, 5);
    const bills = estimateBills(state, breweryScenario);
    const farmDef = breweryScenario.facilityTypes.find((f) => f.type === 'farm')!;
    expect(bills.facilities).toHaveLength(1);
    expect(bills.facilities[0].upkeep).toBe(farmDef.upkeepPerTurn);
    expect(bills.facilities[0].payroll).toBe(farmDef.standardWage * 1.0 * farmDef.workersForFullCapacity);
  });

  it('excludes a facility still under construction', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'quarry', resourceId: 'silica_sand' }, breweryScenario);
    const bills = estimateBills(state, breweryScenario);
    expect(bills.facilities).toHaveLength(1); // only the operational farm, not the under-construction quarry
  });

  it('includes insurance and legal retainer only when toggled on', () => {
    let state = newGame(breweryScenario, 5);
    expect(estimateBills(state, breweryScenario).insurance).toBe(0);
    expect(estimateBills(state, breweryScenario).legalRetainer).toBe(0);

    state = applyCommand(state, { kind: 'toggleInsurance', on: true }, breweryScenario);
    state = applyCommand(state, { kind: 'toggleLegalTeam', on: true }, breweryScenario);
    const bills = estimateBills(state, breweryScenario);
    expect(bills.insurance).toBeGreaterThan(0);
    expect(bills.legalRetainer).toBe(25);
  });

  it('includes active loan payments', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const bills = estimateBills(state, breweryScenario);
    expect(bills.loanPayments).toHaveLength(1);
    expect(bills.loanPayments[0].payment).toBe(state.player.loans[0].paymentPerTurn);
  });

  it('includes buy-side supply contracts but not sell-side ones', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'buy', resourceId: 'hops', qtyPerTurn: 3, price: 12, turnsLeft: 5 },
      breweryScenario
    );
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 5 },
      breweryScenario
    );
    const bills = estimateBills(state, breweryScenario);
    expect(bills.buyContracts).toHaveLength(1);
    expect(bills.buyContracts[0].cost).toBe(36); // 3 * 12
  });

  it('lists license renewals as informational, excluded from totalPerTurn', () => {
    const state = newGame(breweryScenario, 5);
    const bills = estimateBills(state, breweryScenario);
    expect(bills.licenseRenewals).toHaveLength(1);
    expect(bills.licenseRenewals[0].resourceId).toBe('barley');
    // totalPerTurn should just be facility upkeep+payroll (nothing else active yet).
    const expectedTotal = bills.facilities.reduce((s, f) => s + f.upkeep + f.payroll, 0);
    expect(bills.totalPerTurn).toBe(expectedTotal);
  });

  it('totalPerTurn sums every per-turn component', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'toggleLegalTeam', on: true }, breweryScenario);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'buy', resourceId: 'hops', qtyPerTurn: 2, price: 10, turnsLeft: 5 },
      breweryScenario
    );
    const bills = estimateBills(state, breweryScenario);
    const expected =
      bills.facilities.reduce((s, f) => s + f.upkeep + f.payroll, 0) +
      bills.legalRetainer +
      bills.loanPayments.reduce((s, l) => s + l.payment, 0) +
      bills.buyContracts.reduce((s, c) => s + c.cost, 0);
    expect(bills.totalPerTurn).toBeCloseTo(expected, 5);
    expect(bills.totalPerTurn).toBeGreaterThan(0);
  });
});
