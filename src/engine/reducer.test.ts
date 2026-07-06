import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/brewery/config';
import { newGame } from './newGame';
import {
  applyCommand,
  effectiveCapacity,
  estimateBills,
  grantDiscoveryLicense,
  ingredientResearchCost,
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

  it('starts with the starting facility already auto-producing', () => {
    const state = newGame(breweryScenario, 42);
    expect(state.player.autoProduce).toContain(breweryScenario.startingLicenseResourceId[0]);
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
    // Isolate manual production from the default auto-produce (facilities
    // now default to on) so this test's capacity math stays exact.
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'barley', on: false }, breweryScenario);
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
    // Facilities default to auto-producing now — turn off barley so it can't
    // passively restock the malthouse's ingredient within the same tick.
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'barley', on: false }, breweryScenario);
    state.player.knowledge.knownRecipeIds.add('recipe_malt');
    state.player.licenses.push({ resourceId: 'malt', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.facilities.push({
      id: 'facility_malt', type: 'malthouse', assignedResourceId: 'malt', capacityPerTurn: 15, level: 1, buildTurnsLeft: 0, upkeepPerTurn: 10,
      requiredWorkers: 3, hiredWorkers: 3, wageRatio: 1.0, condition: 100, maintenanceFunded: true, capacityUsedThisTick: 0, upkeepPrepaid: false,
    });
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'malt', on: true }, breweryScenario);
    state = tick(state, breweryScenario); // no barley in inventory → no malt
    expect(state.player.inventory['malt']?.qty ?? 0).toBe(0);
  });

  // Regression coverage: yeast_culture used to have a facility ('lab') but no
  // producing Recipe anywhere in the scenario config, so tryProduce's
  // findRecipe() lookup could never succeed for it — making every tier-2
  // beer/cider (all of which require yeast_culture) permanently unproducible.
  // recipe_yeast_culture (config.ts) closes that gap — it consumes Barley
  // (propagated on a grain-based nutrient medium) rather than being a bare
  // extraction, consistent with every other tier-1 processed good.
  it('yeast_culture is producible once its recipe is known, a lab is staffed, and barley is on hand', () => {
    let state = newGame(breweryScenario, 1); // seed 1 fires no disruptive event in the first two ticks
    state.player.licenses.push({ resourceId: 'yeast_culture', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.knowledge.knownRecipeIds.add('recipe_yeast_culture');
    state.player.inventory['barley'] = { qty: 10, ageTurns: 0 };
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'lab', resourceId: 'yeast_culture' }, breweryScenario);
    const lab = state.player.facilities.find((f) => f.type === 'lab')!;
    state = applyCommand(state, { kind: 'hireFire', facilityId: lab.id, targetWorkers: lab.requiredWorkers }, breweryScenario);
    // Isolate the manual produce command from auto-production's own claim on capacity.
    state = applyCommand(state, { kind: 'toggleAutoProduce', resourceId: 'yeast_culture', on: false }, breweryScenario);
    for (let i = 0; i < 2; i++) state = tick(state, breweryScenario); // lab buildTurns is 2
    expect(state.player.facilities.find((f) => f.type === 'lab')!.buildTurnsLeft).toBe(0);
    state = applyCommand(state, { kind: 'produce', resourceId: 'yeast_culture', qty: 5 }, breweryScenario);
    expect(state.player.inventory['yeast_culture']?.qty ?? 0).toBe(5);
  });

  it("recipe_keg_beer's full ingredient chain (malt + hops + yeast_culture) can actually complete end-to-end", () => {
    let state = newGame(breweryScenario, 3);
    state.player.cash = 2_000_000; // headroom for facility builds/upkeep across many ticks
    state.player.licenseSlots = 10;

    // Bypass the RNG-driven discovery ladder (covered by the "research ladder"
    // and "discovery disclosure" tests above) to isolate production mechanics:
    // does the chain actually assemble and produce keg_beer once everything is known?
    for (const id of ['recipe_extract_hops', 'recipe_malt', 'recipe_yeast_culture', 'recipe_keg_beer']) {
      state.player.knowledge.knownRecipeIds.add(id);
    }
    // turnsUntilRenewal set well beyond the tick window so keg_beer's license
    // quota check doesn't fire before the brewery has even finished building.
    for (const resourceId of ['hops', 'malt', 'yeast_culture', 'keg_beer']) {
      state.player.licenses.push({ resourceId, status: 'active', turnsUntilRenewal: 100, unitsProducedThisPeriod: 0 });
    }

    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'farm', resourceId: 'hops' }, breweryScenario);
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'malthouse', resourceId: 'malt' }, breweryScenario);
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'lab', resourceId: 'yeast_culture' }, breweryScenario);
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'brewery', resourceId: 'keg_beer' }, breweryScenario);
    for (const f of state.player.facilities) {
      state = applyCommand(state, { kind: 'hireFire', facilityId: f.id, targetWorkers: f.requiredWorkers }, breweryScenario);
    }

    for (let i = 0; i < 30; i++) state = tick(state, breweryScenario);

    expect(state.ledger.some((e) => e.label.startsWith('Produced') && e.label.endsWith('yeast_culture'))).toBe(true);
    expect(state.player.inventory['keg_beer']?.qty ?? 0).toBeGreaterThan(0);
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

  it('reassigning a facility defaults the new resource to auto-producing', () => {
    let state = newGame(breweryScenario, 5);
    state.player.licenses.push({ resourceId: 'hops', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 });
    state.player.knowledge.knownRecipeIds.add('recipe_extract_hops');
    const farmId = state.player.facilities[0].id;
    state = applyCommand(state, { kind: 'reassignFacility', facilityId: farmId, resourceId: 'hops' }, breweryScenario);
    expect(state.player.autoProduce).toContain('hops');
  });

  it('a newly built facility defaults to auto-producing its assigned resource', () => {
    const state = applyCommand(
      newGame(breweryScenario, 5),
      { kind: 'buildFacility', facilityType: 'quarry', resourceId: 'silica_sand' },
      breweryScenario
    );
    expect(state.player.autoProduce).toContain('silica_sand');
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
    // Both recipe_malt and recipe_yeast_culture are valid tier-1 candidates
    // buildable from barley alone — assert on the discovered recipe's own
    // inputs rather than assuming which one the RNG lands on.
    let state = newGame(breweryScenario, 6);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 1 }]);
    state = step(state);
    state = step(state);
    const discoveredId = [...state.player.knowledge.knownRecipeIds].find((id) => id !== 'recipe_extract_barley');
    expect(discoveredId).toBeDefined();
    const discoveredRecipe = state.recipes.find((r) => r.id === discoveredId)!;
    expect(discoveredRecipe.inputs.every((i) => i.ingredientId === 'barley')).toBe(true);
  });

  it('ingredient-directed research will not discover a recipe needing unselected ingredients', () => {
    let state = newGame(breweryScenario, 6);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 1 }]);
    state = step(state);
    state = step(state);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_keg_beer')).toBe(false);
  });

  it('blind research charges the scenario research cost upfront', () => {
    let state = newGame(breweryScenario, 4);
    const cashBefore = state.player.cash;
    state = applyCommand(state, { kind: 'researchBlind' }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - breweryScenario.researchCost);
  });

  it('ingredient-directed research charges tier × 200, not the flat breakthrough cost', () => {
    let state = newGame(breweryScenario, 6);
    const cashBefore = state.player.cash;
    state = applyCommand(state, { kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 1 }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - ingredientResearchCost(1));
    expect(ingredientResearchCost(1)).toBe(200);
  });

  it('ingredient-directed research cost scales with the targeted tier, with tier 3 as a premium jump', () => {
    let state = newGame(breweryScenario, 6);
    state.player.cash = 10000;
    const cashBefore = state.player.cash;
    state = applyCommand(state, { kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 3 }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - 800);
    expect(ingredientResearchCost(3)).toBe(800);
    expect(state.player.knowledge.activeCommission?.targetTier).toBe(3);
  });

  it('ingredient-directed research cost doubles each tier, so tier 4/5 cost strictly more than tier 3', () => {
    expect(ingredientResearchCost(1)).toBe(200);
    expect(ingredientResearchCost(2)).toBe(400);
    expect(ingredientResearchCost(3)).toBe(800);
    expect(ingredientResearchCost(4)).toBe(1600);
    expect(ingredientResearchCost(5)).toBe(3200);
  });

  it('cannot start research without enough cash', () => {
    let state = newGame(breweryScenario, 4);
    state.player.cash = breweryScenario.researchCost - 1;
    const next = applyCommand(state, { kind: 'researchBlind' }, breweryScenario);
    expect(next.player.knowledge.activeCommission).toBeUndefined();
    expect(next.player.cash).toBe(state.player.cash);
  });

  it('cannot start ingredient-directed research without enough cash for the target tier', () => {
    let state = newGame(breweryScenario, 6);
    state.player.cash = ingredientResearchCost(1) - 1;
    const next = applyCommand(state, { kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 1 }, breweryScenario);
    expect(next.player.knowledge.activeCommission).toBeUndefined();
    expect(next.player.cash).toBe(state.player.cash);
  });

  it('only discovers a recipe whose output matches the targeted tier', () => {
    let state = newGame(breweryScenario, 6);
    state.player.cash = 10000;
    // recipe_malt (output 'malt') is tier 1 — targeting tier 2 with the same
    // ingredient set should find nothing, even though malt is reachable.
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 2 }]);
    state = step(state);
    state = step(state);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_malt')).toBe(false);
  });

  it('reaching a tier-3 recipe requires already knowing AND selecting its tier-2 ingredient — a tier-0 ingredient alone finds nothing', () => {
    let state = newGame(breweryScenario, 1);
    state.player.cash = 10000;
    // No tier-3 recipe (bottled/canned beer) is buildable from barley alone —
    // they all require keg_beer (tier 2) plus a packaging good (tier 1).
    state = applyCommand(state, { kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 3 }, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_bottled_beer')).toBe(false);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_canned_beer')).toBe(false);
  });

  it('discovers a tier-3 recipe once its full tier-2 + tier-1 ingredient set is known and selected', () => {
    let state = newGame(breweryScenario, 1);
    state.player.cash = 10000;
    state.player.knowledge.knownRecipeIds.add('recipe_keg_beer');
    state.player.knowledge.knownRecipeIds.add('recipe_glass_bottle');
    state = applyCommand(
      state,
      { kind: 'researchByIngredients', ingredients: ['keg_beer', 'glass_bottle'], targetTier: 3 },
      breweryScenario
    );
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_bottled_beer')).toBe(true);
  });

  it('knowing a tier-2 ingredient is not enough — it must also be selected, or a tier-3 recipe needing it is not found', () => {
    let state = newGame(breweryScenario, 1);
    state.player.cash = 10000;
    state.player.knowledge.knownRecipeIds.add('recipe_keg_beer');
    state.player.knowledge.knownRecipeIds.add('recipe_glass_bottle');
    // Only keg_beer is selected — glass_bottle is known but left out of the pick.
    state = applyCommand(state, { kind: 'researchByIngredients', ingredients: ['keg_beer'], targetTier: 3 }, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    state = tick(state, breweryScenario);
    expect(state.player.knowledge.knownRecipeIds.has('recipe_bottled_beer')).toBe(false);
  });
});

describe('discovery disclosure', () => {
  // Lands on whichever of recipe_malt / recipe_yeast_culture the RNG picks —
  // both are valid tier-1-from-barley candidates and both start published,
  // which is exactly what this fixture needs (see the test below).
  function discoverPublishedTier1FromBarley(seed: number) {
    let state = newGame(breweryScenario, seed);
    state = step(state, [{ kind: 'researchByIngredients', ingredients: ['barley'], targetTier: 1 }]);
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

  // recipe_bottled_beer sits at the end of a deep chain (needs keg_beer,
  // which itself needs malt+hops+yeast_culture, none of which rivals start
  // knowing) — reaching it via rivals' own background research would require
  // several independent lucky rolls to land in the right order. Not
  // mathematically impossible like some shallower recipes, but negligible
  // within the ~30-tick window this fixture is used for (verified empirically
  // for the seed below). Used where a test runs many ticks and needs a target
  // that won't incidentally get "discovered" by a rival's own research,
  // isolating "did disclosure choice X publish it" from "did a rival
  // separately discover it on their own" (a different, valid path now that
  // rivals research too).
  function withPendingBottledBeerDisclosure(seed: number) {
    const state = newGame(breweryScenario, seed);
    state.player.knowledge.knownRecipeIds.add('recipe_bottled_beer');
    state.pendingDisclosures.push({ recipeId: 'recipe_bottled_beer' });
    return state;
  }

  it('queues a pending disclosure exactly when the newly discovered recipe starts unpublished', () => {
    // Blind research can land on any reachable recipe, including recipe_malt
    // (published from turn 1) — assert against the discovered recipe's own
    // published flag rather than assuming which one gets picked, so this
    // isn't tied to one seed's exact RNG draw.
    let state = newGame(breweryScenario, 4);
    state = step(state, [{ kind: 'researchBlind' }]);
    state = step(state);
    state = step(state);
    const discoveredId = [...state.player.knowledge.knownRecipeIds].find((id) => id !== 'recipe_extract_barley')!;
    expect(discoveredId).toBeDefined();
    const discoveredRecipe = state.recipes.find((r) => r.id === discoveredId)!;
    if (discoveredRecipe.published) {
      expect(state.pendingDisclosures).toHaveLength(0);
    } else {
      expect(state.pendingDisclosures).toHaveLength(1);
      expect(state.pendingDisclosures[0].recipeId).toBe(discoveredId);
    }
  });

  it('does not queue a disclosure for a recipe that is already published', () => {
    // Both recipe_malt and recipe_yeast_culture start published: true —
    // rivals already know either from turn 1, so there's no real disclosure
    // choice regardless of which one the RNG lands on.
    const state = discoverPublishedTier1FromBarley(6);
    const discoveredId = [...state.player.knowledge.knownRecipeIds].find((id) => id !== 'recipe_extract_barley');
    expect(discoveredId).toBeDefined();
    const discoveredRecipe = state.recipes.find((r) => r.id === discoveredId)!;
    expect(discoveredRecipe.published).toBe(true);
    expect(state.pendingDisclosures).toHaveLength(0);
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
    let state = withPendingBottledBeerDisclosure(6);
    state = applyCommand(state, { kind: 'resolveDisclosure', choice: 'exclusive' }, breweryScenario);
    let recipe = state.recipes.find((r) => r.id === 'recipe_bottled_beer')!;
    expect(recipe.exclusiveTurnsLeft).toBe(30);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_bottled_beer')).toBe(false);

    for (let i = 0; i < 29; i++) state = tick(state, breweryScenario);
    recipe = state.recipes.find((r) => r.id === 'recipe_bottled_beer')!;
    expect(recipe.published).toBe(false);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_bottled_beer')).toBe(false);

    state = tick(state, breweryScenario); // 30th tick — timer lapses
    recipe = state.recipes.find((r) => r.id === 'recipe_bottled_beer')!;
    expect(recipe.published).toBe(true);
    for (const rival of state.rivals) expect(rival.knownRecipeIds.has('recipe_bottled_beer')).toBe(true);
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

describe('discovery grants ownership', () => {
  it('discovering a recipe grants its license for free, no purchase needed', () => {
    let state = newGame(breweryScenario, 4);
    state.player.licenseSlots = 2; // room for the discovery grant alongside the starting Barley license
    state = step(state, [{ kind: 'researchBlind' }]);
    state = step(state);
    state = step(state);
    const discoveredId = [...state.player.knowledge.knownRecipeIds].find((id) => id !== 'recipe_extract_barley')!;
    const discoveredRecipe = state.recipes.find((r) => r.id === discoveredId)!;
    expect(state.player.licenses.some((l) => l.resourceId === discoveredRecipe.output)).toBe(true);
    const grantEntry = state.ledger.filter((e) => e.label.includes('discovery reward'));
    expect(grantEntry).toHaveLength(1);
    expect(grantEntry[0].delta).toBe(0); // free — no cash change from the grant itself
  });

  it('does not grant a duplicate license if the discoverer already holds one for that resource', () => {
    // recipe_extract_barley's output is 'barley', which the player already
    // holds a license for from game start.
    const state = newGame(breweryScenario, 4);
    expect(state.player.licenses.filter((l) => l.resourceId === 'barley')).toHaveLength(1);
  });

  it('does not grant a license when the discoverer has no free license slot', () => {
    let state = newGame(breweryScenario, 4);
    state.player.licenseSlots = 1; // already at cap with the starting Barley license
    state = step(state, [{ kind: 'researchBlind' }]);
    state = step(state);
    state = step(state);
    const discoveredId = [...state.player.knowledge.knownRecipeIds].find((id) => id !== 'recipe_extract_barley')!;
    const discoveredRecipe = state.recipes.find((r) => r.id === discoveredId)!;
    // Still learned the recipe...
    expect(state.player.knowledge.knownRecipeIds.has(discoveredId)).toBe(true);
    // ...but no license was granted since there was no room.
    expect(state.player.licenses).toHaveLength(1);
    expect(state.player.licenses.some((l) => l.resourceId === discoveredRecipe.output)).toBe(false);
  });

  it('grantDiscoveryLicense has no cross-company exclusivity — independent discoverers each get their own license', () => {
    const scenario = breweryScenario;
    const rice = 'rice';
    const playerLicenses = grantDiscoveryLicense([], 5, rice, scenario);
    const rivalLicenses = grantDiscoveryLicense([], 5, rice, scenario);
    // Both succeed independently — one company's grant doesn't block another's.
    expect(playerLicenses.some((l) => l.resourceId === rice)).toBe(true);
    expect(rivalLicenses.some((l) => l.resourceId === rice)).toBe(true);
  });

  it('rivals eventually discover new recipes and license themselves via background research', () => {
    let state = newGame(breweryScenario, 7);
    const startingKnownSize = state.rivals[0].knownRecipeIds.size;
    for (let i = 0; i < 60 && state.rivals[0].knownRecipeIds.size === startingKnownSize; i++) {
      state = tick(state, breweryScenario);
    }
    expect(state.rivals[0].knownRecipeIds.size).toBeGreaterThan(startingKnownSize);
    const discoveryEntries = state.ledger.filter((e) => e.label.includes(`${state.rivals[0].name} discovered`));
    expect(discoveryEntries.length).toBeGreaterThan(0);
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
    // Facilities default to auto-producing now — clear any passively-grown
    // inventory so "insufficient inventory" is actually true here.
    state.player.inventory = {};
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

  it('sendSupplyContractNow settles a sell contract immediately', () => {
    let state = newGame(breweryScenario, 5);
    state.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    const id = state.player.supplyContracts[0].id;
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'sendSupplyContractNow', id }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore + 5 * 4);
    expect(state.player.inventory['barley'].qty).toBe(95);
    expect(state.player.supplyContracts[0].settledThisTurn).toBe(true);
  });

  it('sendSupplyContractNow does not cause a double-settle at end of turn', () => {
    let pathA = newGame(breweryScenario, 5);
    pathA.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    pathA = applyCommand(
      pathA,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    const id = pathA.player.supplyContracts[0].id;
    pathA = applyCommand(pathA, { kind: 'sendSupplyContractNow', id }, breweryScenario);
    pathA = tick(pathA, breweryScenario);

    let pathB = newGame(breweryScenario, 5);
    pathB.player.inventory['barley'] = { qty: 100, ageTurns: 0 };
    pathB = applyCommand(
      pathB,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    pathB = tick(pathB, breweryScenario);

    expect(pathA.player.cash).toBeCloseTo(pathB.player.cash, 5);
    expect(pathA.player.inventory['barley'].qty).toBeCloseTo(pathB.player.inventory['barley'].qty, 5);
    expect(pathA.player.supplyContracts[0].settledThisTurn).toBe(false); // flag reset after the tick
  });

  it('sendSupplyContractNow settles a buy contract immediately', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'buy', resourceId: 'hops', qtyPerTurn: 3, price: 12, turnsLeft: 5 },
      breweryScenario
    );
    const id = state.player.supplyContracts[0].id;
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'sendSupplyContractNow', id }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - 3 * 12);
    expect(state.player.inventory['hops'].qty).toBe(3);
  });

  it('sendSupplyContractNow does nothing if the resource stock is insufficient', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(
      state,
      { kind: 'proposeSupplyContract', side: 'sell', resourceId: 'barley', qtyPerTurn: 5, price: 4, turnsLeft: 3 },
      breweryScenario
    );
    const id = state.player.supplyContracts[0].id;
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'sendSupplyContractNow', id }, breweryScenario);
    expect(next.player.cash).toBe(cashBefore);
    expect(next.player.supplyContracts[0].settledThisTurn).toBe(false);
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

  it('payLoanNow deducts exactly one installment and lowers the remaining balance', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'payLoanNow', loanId: loan.id }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - loan.paymentPerTurn);
    expect(state.player.loans[0].remaining).toBeCloseTo(loan.remaining - loan.paymentPerTurn, 5);
  });

  it('paying one installment early does not cause an extra charge overall — it just shifts the timing', () => {
    // Path A: pay one installment manually, then let one tick run.
    let pathA = newGame(breweryScenario, 5);
    pathA = applyCommand(pathA, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    pathA = applyCommand(pathA, { kind: 'payLoanNow', loanId: pathA.player.loans[0].id }, breweryScenario);
    pathA = tick(pathA, breweryScenario);

    // Path B: let two ticks run automatically, no manual payment at all.
    let pathB = newGame(breweryScenario, 5);
    pathB = applyCommand(pathB, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    pathB = tick(pathB, breweryScenario);
    pathB = tick(pathB, breweryScenario);

    // Same two installments' worth paid down in both paths — no double charge.
    expect(pathA.player.loans[0]?.remaining ?? 0).toBeCloseTo(pathB.player.loans[0]?.remaining ?? 0, 5);
  });

  it('payLoanNow does nothing if cash is insufficient', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];
    state.player.cash = 0;
    const next = applyCommand(state, { kind: 'payLoanNow', loanId: loan.id }, breweryScenario);
    expect(next.player.loans[0].remaining).toBe(loan.remaining); // unchanged
  });

  it('payLoanNow pays off and removes a loan whose remaining is less than one installment', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'takeLoan', amount: 500 }, breweryScenario);
    const loan = state.player.loans[0];
    state.player.loans[0].remaining = 5; // less than paymentPerTurn
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'payLoanNow', loanId: loan.id }, breweryScenario);
    expect(next.player.loans).toHaveLength(0);
    expect(next.player.cash).toBe(cashBefore - 5);
  });
});

describe('quota check runs on its own cadence, independent of the renewal cycle', () => {
  // Regression coverage for a real bug found while adding Vodka: the quota
  // check used to fire at every renewal (renewalPeriod, typically 5 turns),
  // but quotaPeriodTurns is typically 10 — and facilities routinely take
  // 6-7+ turns just to finish building. Every quota-gated license (keg_beer,
  // wine, hard_cider, vodka, ...) lapsed before it could ever produce
  // anything. Fixed via HeldLicense.turnsUntilQuotaCheck, ticked down
  // separately from turnsUntilRenewal.

  it('does not lapse a quota-gated license at its first renewal, before the quota period has elapsed', () => {
    let state = newGame(breweryScenario, 5);
    state.player.cash = 1_000_000;
    state.player.licenseSlots = 10;
    state = applyCommand(state, { kind: 'buyLicense', resourceId: 'keg_beer' }, breweryScenario);
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'keg_beer')!;
    expect(def.renewalPeriod).toBeLessThan(def.quotaPeriodTurns!); // the exact mismatch that caused the bug

    for (let i = 0; i < def.renewalPeriod; i++) state = tick(state, breweryScenario);
    // Past the first renewal, with zero keg_beer produced — the license must
    // still be alive (quota window hasn't elapsed yet), just renewed.
    const lic = state.player.licenses.find((l) => l.resourceId === 'keg_beer');
    expect(lic).toBeDefined();
    expect(lic!.status).toBe('active');
  });

  it('does lapse a quota-gated license once its own quota period elapses with the quota unmet', () => {
    let state = newGame(breweryScenario, 5);
    state.player.cash = 1_000_000;
    state.player.licenseSlots = 10;
    state = applyCommand(state, { kind: 'buyLicense', resourceId: 'keg_beer' }, breweryScenario);
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'keg_beer')!;

    for (let i = 0; i < def.quotaPeriodTurns!; i++) state = tick(state, breweryScenario);
    // No keg_beer was ever produced — the quota window has now fully elapsed.
    expect(state.player.licenses.some((l) => l.resourceId === 'keg_beer')).toBe(false);
    const lapseEntry = state.ledger.filter((e) => e.label.includes('Quota missed'));
    expect(lapseEntry.length).toBeGreaterThan(0);
  });

  it('resets unitsProducedThisPeriod and the quota countdown independently of the renewal countdown', () => {
    let state = newGame(breweryScenario, 5);
    state.player.cash = 1_000_000;
    state.player.licenseSlots = 10;
    state = applyCommand(state, { kind: 'buyLicense', resourceId: 'keg_beer' }, breweryScenario);
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'keg_beer')!;
    let lic = state.player.licenses.find((l) => l.resourceId === 'keg_beer')!;
    lic.unitsProducedThisPeriod = def.quotaPerPeriod!; // pretend quota was already met

    for (let i = 0; i < def.quotaPeriodTurns!; i++) state = tick(state, breweryScenario);
    lic = state.player.licenses.find((l) => l.resourceId === 'keg_beer')!;
    expect(lic.status).toBe('active'); // quota met, no lapse
    expect(lic.unitsProducedThisPeriod).toBe(0); // reset for the next window
    expect(lic.turnsUntilQuotaCheck).toBe(def.quotaPeriodTurns); // countdown restarted
  });
});

describe('license renewal affordability', () => {
  // No facility in these fixtures — isolates the license-renewal check from
  // the unconditional facility upkeep/payroll charge (which would otherwise
  // drive an already-cash-short player into bankruptcy for an unrelated
  // reason and mask what's actually being tested).
  it('suspends the license instead of charging a fee it cannot cover', () => {
    let state = newGame(breweryScenario, 5);
    state.player.facilities = [];
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'barley')!;
    state.player.licenses[0].turnsUntilRenewal = 1;
    state.player.cash = def.renewalCost - 1; // one gold short

    const next = tick(state, breweryScenario);
    expect(next.player.cash).toBe(def.renewalCost - 1); // unchanged — no charge went through
    expect(next.player.licenses[0].status).toBe('suspended');
    expect(next.player.licenses[0].suspendedTurnsLeft).toBeGreaterThan(0);
  });

  it('logs a distinct warning ledger entry when a renewal is unaffordable', () => {
    let state = newGame(breweryScenario, 5);
    state.player.facilities = [];
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'barley')!;
    state.player.licenses[0].turnsUntilRenewal = 1;
    state.player.cash = def.renewalCost - 1;

    const next = tick(state, breweryScenario);
    const warning = next.ledger.filter((e) => e.label.includes('License renewal failed'));
    expect(warning).toHaveLength(1);
    expect(warning[0].label).toContain('barley');
  });

  it('a suspended license blocks production regardless of what caused the suspension', () => {
    const state = newGame(breweryScenario, 5);
    state.player.licenses[0].status = 'suspended';
    state.player.licenses[0].suspendedTurnsLeft = 3;
    const next = applyCommand(state, { kind: 'produce', resourceId: 'barley', qty: 5 }, breweryScenario);
    expect(next.player.inventory['barley']?.qty ?? 0).toBe(0);
  });

  it('retries the renewal once cash recovers, and clears the suspension on success', () => {
    let state = newGame(breweryScenario, 1);
    state.player.facilities = [];
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'barley')!;
    state.player.licenses[0].turnsUntilRenewal = 1;
    state.player.cash = def.renewalCost - 1;
    state = tick(state, breweryScenario); // fails, suspends

    state.player.cash = def.renewalCost + 100; // now affordable
    const next = tick(state, breweryScenario);
    const renewed = next.ledger.filter((e) => e.label === `License renewal: barley`);
    expect(renewed).toHaveLength(1);
    expect(next.player.licenses[0].turnsUntilRenewal).toBe(def.renewalPeriod);
    expect(next.player.licenses[0].status).toBe('active'); // paying off catches up the suspension too
  });
});

describe('renewLicenseNow', () => {
  it('pays the renewal fee immediately and resets the countdown to a full period', () => {
    let state = newGame(breweryScenario, 5);
    state.player.licenses[0].turnsUntilRenewal = 1; // about to renew naturally
    const def = breweryScenario.licenses.find((l) => l.resourceId === 'barley')!;
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'renewLicenseNow', resourceId: 'barley' }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore - def.renewalCost);
    expect(state.player.licenses[0].turnsUntilRenewal).toBe(def.renewalPeriod);
  });

  it('does not renew (or charge) a license the player does not hold', () => {
    const state = newGame(breweryScenario, 5);
    const cashBefore = state.player.cash;
    const next = applyCommand(state, { kind: 'renewLicenseNow', resourceId: 'hops' }, breweryScenario);
    expect(next.player.cash).toBe(cashBefore);
  });

  it('does nothing if cash is insufficient', () => {
    let state = newGame(breweryScenario, 5);
    state.player.cash = 0;
    const next = applyCommand(state, { kind: 'renewLicenseNow', resourceId: 'barley' }, breweryScenario);
    expect(next.player.licenses[0].turnsUntilRenewal).toBe(state.player.licenses[0].turnsUntilRenewal);
  });

  it('an early renewal prevents the automatic renewal from double-charging', () => {
    let state = newGame(breweryScenario, 5);
    state.player.licenses[0].turnsUntilRenewal = 1; // would renew on the very next tick otherwise
    state = applyCommand(state, { kind: 'renewLicenseNow', resourceId: 'barley' }, breweryScenario);

    const next = tick(state, breweryScenario);
    // The countdown was reset to a full period, so this tick should NOT also
    // charge a renewal fee — only ordinary upkeep/payroll should apply.
    const renewalLedgerEntries = next.ledger.filter((e) => e.label.includes('License renewal'));
    expect(renewalLedgerEntries).toHaveLength(0);
    expect(next.player.licenses[0].turnsUntilRenewal).toBeLessThan(state.player.licenses[0].turnsUntilRenewal);
  });
});

describe('payFacilityUpkeepNow', () => {
  it('charges upkeep+payroll immediately and marks the facility prepaid', () => {
    let state = newGame(breweryScenario, 5);
    const facility = state.player.facilities[0];
    const def = breweryScenario.facilityTypes.find((f) => f.type === facility.type)!;
    const expectedTotal = facility.upkeepPerTurn + def.standardWage * facility.wageRatio * facility.hiredWorkers;
    const cashBefore = state.player.cash;

    state = applyCommand(state, { kind: 'payFacilityUpkeepNow', facilityId: facility.id }, breweryScenario);
    expect(state.player.cash).toBeCloseTo(cashBefore - expectedTotal, 5);
    expect(state.player.facilities[0].upkeepPrepaid).toBe(true);
  });

  it('does nothing if cash is insufficient', () => {
    let state = newGame(breweryScenario, 5);
    state.player.cash = 0;
    const facility = state.player.facilities[0];
    state = applyCommand(state, { kind: 'payFacilityUpkeepNow', facilityId: facility.id }, breweryScenario);
    expect(state.player.facilities[0].upkeepPrepaid).toBe(false);
  });

  it('does nothing for a facility still under construction', () => {
    let state = newGame(breweryScenario, 5);
    state = applyCommand(state, { kind: 'buildFacility', facilityType: 'quarry', resourceId: 'silica_sand' }, breweryScenario);
    const quarry = state.player.facilities.find((f) => f.type === 'quarry')!;
    const cashBefore = state.player.cash;
    state = applyCommand(state, { kind: 'payFacilityUpkeepNow', facilityId: quarry.id }, breweryScenario);
    expect(state.player.cash).toBe(cashBefore);
    expect(state.player.facilities.find((f) => f.id === quarry.id)!.upkeepPrepaid).toBe(false);
  });

  it('paying upkeep early does not cause an extra charge overall — it just shifts the timing', () => {
    let pathA = newGame(breweryScenario, 5);
    const facilityA = pathA.player.facilities[0];
    pathA = applyCommand(pathA, { kind: 'payFacilityUpkeepNow', facilityId: facilityA.id }, breweryScenario);
    pathA = tick(pathA, breweryScenario);

    let pathB = newGame(breweryScenario, 5);
    pathB = tick(pathB, breweryScenario);

    expect(pathA.player.cash).toBeCloseTo(pathB.player.cash, 5);
  });

  it('an already-prepaid facility is not charged again by the automatic upkeep, and the flag resets', () => {
    let state = newGame(breweryScenario, 5);
    const facility = state.player.facilities[0];
    state = applyCommand(state, { kind: 'payFacilityUpkeepNow', facilityId: facility.id }, breweryScenario);
    const cashAfterPrepay = state.player.cash;

    const next = tick(state, breweryScenario);
    const upkeepLedgerEntries = next.ledger.filter((e) => e.label.includes('Upkeep+payroll'));
    expect(upkeepLedgerEntries).toHaveLength(0);
    expect(next.player.facilities[0].upkeepPrepaid).toBe(false);
    expect(next.player.cash).toBeCloseTo(cashAfterPrepay, 5); // no other charges apply this simple tick
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
