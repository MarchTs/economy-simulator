import type { FacilityTypeDef, ScenarioConfig } from '../scenarios/types';
import { refreshContractBoard, refreshStandingOfferBoard } from './contracts';
import { makeDiscoveryChecker } from './discovery';
import { rollEvent } from './events';
import { updateAllMarkets } from './market';
import { nextRandom } from './rng';
import { repriceRival } from './rivals';
import type {
  ActiveEffect,
  CompanyState,
  Facility,
  FacilityId,
  GameState,
  HeldLicense,
  LedgerEntry,
  Loan,
  QuestContract,
  Recipe,
  Resource,
  ResourceId,
} from './types';

const WIN_TURN = 60;
const INSURANCE_RATE = 0.02; // 2%/turn of asset value, per doc §6
const LEGAL_RETAINER = 25; // per turn, per doc §9 balance numbers
const LEVEL_CAPACITY_BONUS = 0.25; // +25% base capacity per level above 1
export const MAX_FACILITY_LEVEL = 5;
const RENEWAL_FAILURE_SUSPENSION_TURNS = 3; // per doc §3's "2-3 turns" suspension range

// Ingredient-directed research targets a specific tier, so it's priced
// steeper than the flat, random-outcome Breakthrough (scenario.researchCost) —
// paying for precision. Doubles per tier (200/400/800/1600/3200...) rather
// than scaling linearly, so each higher tier costs disproportionately more
// than the last, not just a flat multiple of tier 1.
export const INGREDIENT_RESEARCH_COST_PER_TIER = 200;
export function ingredientResearchCost(targetTier: number): number {
  return INGREDIENT_RESEARCH_COST_PER_TIER * 2 ** (targetTier - 1);
}

// Banking, per doc §6.9 "reduced to a single loan action": one unsecured
// product, flat rate, no fixed/floating/secured choice or credit score.
const LOAN_INTEREST_RATE = 0.2; // total interest over the life of the loan
export const LOAN_TERM_TURNS = 20;
const LOAN_LIMIT_MULTIPLIER = 1.5; // borrowing cap relative to net worth
const LOAN_MISS_REPUTATION_PENALTY = 5;

function clone<T>(v: T): T {
  return structuredClone(v);
}

function addLedger(ledger: LedgerEntry[], turn: number, label: string, delta: number, cashAfter: number) {
  ledger.push({ turn, label, delta, cashAfter });
}

function resourceById(scenario: ScenarioConfig, id: string) {
  return scenario.resources.find((r) => r.id === id)!;
}

function licenseDefById(scenario: ScenarioConfig, id: string) {
  return scenario.licenses.find((l) => l.resourceId === id)!;
}

function facilityTypeDef(scenario: ScenarioConfig, type: string) {
  return scenario.facilityTypes.find((f) => f.type === type)!;
}

// Whoever discovers a recipe owns its license — for free, no purchase step.
// This is deliberately non-exclusive: it only checks the discoverer's OWN
// licenses/slots, so if the player and a rival happen to discover the same
// recipe (even the same turn), each gets their own grant independently —
// ownership "splits" between simultaneous discoverers rather than one
// blocking the other. Returns the same array reference if nothing changed
// (already held, or no free slot), so callers can check `!== licenses` to
// know whether a grant actually happened.
export function grantDiscoveryLicense(
  licenses: HeldLicense[],
  licenseSlots: number,
  resourceId: ResourceId,
  scenario: ScenarioConfig
): HeldLicense[] {
  if (licenses.some((l) => l.resourceId === resourceId)) return licenses;
  if (licenses.length >= licenseSlots) return licenses;
  const def = licenseDefById(scenario, resourceId);
  return [
    ...licenses,
    {
      resourceId,
      status: 'active',
      turnsUntilRenewal: def.renewalPeriod,
      unitsProducedThisPeriod: 0,
      turnsUntilQuotaCheck: def.quotaPeriodTurns,
    },
  ];
}

function assetValue(player: CompanyState, scenario: ScenarioConfig): number {
  const facilityValue = player.facilities.reduce((sum, f) => {
    const def = facilityTypeDef(scenario, f.type);
    return sum + def.buildCost * (f.condition / 100);
  }, 0);
  const inventoryValue = Object.entries(player.inventory).reduce((sum, [id, entry]) => {
    const r = scenario.resources.find((res) => res.id === id);
    return sum + (r ? r.basePrice * entry.qty : 0);
  }, 0);
  return player.cash + facilityValue + inventoryValue;
}

export function outstandingDebt(player: CompanyState): number {
  return player.loans.reduce((sum, l) => sum + l.remaining, 0);
}

// Borrowing capacity shrinks as existing debt piles up against the same assets.
export function loanCreditLimit(player: CompanyState, scenario: ScenarioConfig): number {
  const netWorth = assetValue(player, scenario) - outstandingDebt(player);
  return Math.max(0, Math.round(netWorth * LOAN_LIMIT_MULTIPLIER));
}

export interface BillsBreakdown {
  facilities: { facilityId: FacilityId; type: string; upkeep: number; payroll: number; prepaid: boolean }[];
  insurance: number;
  legalRetainer: number;
  loanPayments: { loanId: string; payment: number }[];
  buyContracts: { contractId: string; resourceId: ResourceId; cost: number }[];
  // Periodic, not per-turn — informational only, excluded from totalPerTurn.
  licenseRenewals: { resourceId: ResourceId; cost: number; turnsUntilRenewal: number }[];
  totalPerTurn: number;
}

// A read-only forecast of every recurring cost the player is on the hook for
// next turn — mirrors runUpkeep/runLoanPayments/runSupplyContracts exactly so
// the "Payments" page never drifts from what actually gets charged.
export function estimateBills(state: GameState, scenario: ScenarioConfig): BillsBreakdown {
  const player = state.player;
  const costMult = costMultiplierNow(state);

  const facilities = player.facilities
    .filter((f) => f.buildTurnsLeft === 0)
    .map((f) => {
      const def = facilityTypeDef(scenario, f.type);
      return {
        facilityId: f.id,
        type: f.type,
        upkeep: f.upkeepPrepaid ? 0 : f.upkeepPerTurn * costMult,
        payroll: f.upkeepPrepaid ? 0 : def.standardWage * f.wageRatio * f.hiredWorkers,
        prepaid: f.upkeepPrepaid,
      };
    });

  const insurance = player.defenses.insurance ? assetValue(player, scenario) * INSURANCE_RATE : 0;
  const legalRetainer = player.defenses.legalTeam ? LEGAL_RETAINER : 0;

  const loanPayments = player.loans.map((l) => ({
    loanId: l.id,
    payment: Math.min(l.paymentPerTurn, l.remaining),
  }));

  const buyContracts = player.supplyContracts
    .filter((c) => c.side === 'buy')
    .map((c) => ({ contractId: c.id, resourceId: c.resourceId, cost: c.qtyPerTurn * c.price }));

  const licenseRenewals = player.licenses.map((l) => {
    const def = licenseDefById(scenario, l.resourceId);
    return { resourceId: l.resourceId, cost: def.renewalCost, turnsUntilRenewal: l.turnsUntilRenewal };
  });

  const totalPerTurn =
    facilities.reduce((sum, f) => sum + f.upkeep + f.payroll, 0) +
    insurance +
    legalRetainer +
    loanPayments.reduce((sum, l) => sum + l.payment, 0) +
    buyContracts.reduce((sum, c) => sum + c.cost, 0);

  return { facilities, insurance, legalRetainer, loanPayments, buyContracts, licenseRenewals, totalPerTurn };
}

// --- UPKEEP -----------------------------------------------------------

function runUpkeep(state: GameState, scenario: ScenarioConfig) {
  const { player } = state;

  // License renewals & suspensions
  for (const lic of player.licenses) {
    if (lic.status === 'suspended') {
      lic.suspendedTurnsLeft = (lic.suspendedTurnsLeft ?? 1) - 1;
      if (lic.suspendedTurnsLeft <= 0) {
        lic.status = 'active';
        lic.suspendedTurnsLeft = undefined;
      }
    }
    lic.turnsUntilRenewal -= 1;
    if (lic.turnsUntilRenewal <= 0) {
      const def = licenseDefById(scenario, lic.resourceId);
      if (player.cash < def.renewalCost) {
        // Can't afford it — suspend instead of driving cash negative.
        // turnsUntilRenewal is left at/below 0, so the charge retries every
        // subsequent turn until it's affordable (or a fresh suspension keeps
        // getting applied) rather than resetting on a missed payment.
        lic.status = 'suspended';
        lic.suspendedTurnsLeft = RENEWAL_FAILURE_SUSPENSION_TURNS;
        addLedger(
          state.ledger,
          state.turn,
          `License renewal failed — suspended: ${lic.resourceId} (need ${def.renewalCost}g)`,
          0,
          player.cash
        );
      } else {
        player.cash -= def.renewalCost;
        addLedger(state.ledger, state.turn, `License renewal: ${lic.resourceId}`, -def.renewalCost, player.cash);
        lic.turnsUntilRenewal = def.renewalPeriod;
        // Catching up on an overdue payment lifts a nonpayment suspension
        // immediately, rather than waiting out the rest of its timer.
        if (lic.status === 'suspended') {
          lic.status = 'active';
          lic.suspendedTurnsLeft = undefined;
        }
      }
    }

    // Quota check runs on its OWN cadence (quotaPeriodTurns), independent of
    // the renewal-fee cycle above — a license's quota window is usually
    // longer than its renewal period, and tying the two together used to
    // lapse every quota-gated license before a freshly-built facility could
    // even finish construction, let alone produce anything.
    if (lic.turnsUntilQuotaCheck !== undefined) {
      lic.turnsUntilQuotaCheck -= 1;
      if (lic.turnsUntilQuotaCheck <= 0) {
        const def = licenseDefById(scenario, lic.resourceId);
        if (lic.unitsProducedThisPeriod < (def.quotaPerPeriod ?? 0)) {
          lic.status = 'lapsed';
          addLedger(state.ledger, state.turn, `Quota missed — license lapsed: ${lic.resourceId}`, 0, player.cash);
        }
        lic.unitsProducedThisPeriod = 0;
        lic.turnsUntilQuotaCheck = def.quotaPeriodTurns;
      }
    }
  }
  player.licenses = player.licenses.filter((l) => l.status !== 'lapsed');

  // Facility upkeep + payroll. Upkeep scales with the active cost multiplier
  // (e.g. an energy price spike) — with spot trading gone, this is the one
  // place "production costs" events still bite.
  const costMult = costMultiplierNow(state);
  for (const f of player.facilities) {
    if (f.buildTurnsLeft > 0) continue;
    if (f.upkeepPrepaid) {
      f.upkeepPrepaid = false;
    } else {
      const def = facilityTypeDef(scenario, f.type);
      const upkeep = f.upkeepPerTurn * costMult;
      player.cash -= upkeep;
      const wage = def.standardWage * f.wageRatio * f.hiredWorkers;
      player.cash -= wage;
      addLedger(state.ledger, state.turn, `Upkeep+payroll: ${f.type}`, -(upkeep + wage), player.cash);
    }
    if (!f.maintenanceFunded) {
      // Higher levels resist wear better — degradation shrinks per level, floored at 1/min.
      const degrade = Math.max(1, 5 - (f.level - 1));
      f.condition = Math.max(0, f.condition - degrade);
    }
  }

  // Facility construction / level-up ticking. A facility mid-level-up keeps
  // producing at its CURRENT level throughout — only a fresh build blocks output.
  for (const f of player.facilities) {
    if (f.buildTurnsLeft > 0) f.buildTurnsLeft -= 1;
    if (f.levelUpTurnsLeft !== undefined) {
      f.levelUpTurnsLeft -= 1;
      if (f.levelUpTurnsLeft <= 0) {
        f.levelUpTurnsLeft = undefined;
        f.level += 1;
      }
    }
  }

  // Defenses
  if (player.defenses.insurance) {
    const premium = assetValue(player, scenario) * INSURANCE_RATE;
    player.cash -= premium;
    addLedger(state.ledger, state.turn, 'Insurance premium', -premium, player.cash);
  }
  if (player.defenses.legalTeam) {
    player.cash -= LEGAL_RETAINER;
    addLedger(state.ledger, state.turn, 'Legal retainer', -LEGAL_RETAINER, player.cash);
  }
}

// --- EVENTS -------------------------------------------------------------

function runEvents(state: GameState, scenario: ScenarioConfig) {
  // Tick down existing effects
  state.activeEffects = state.activeEffects.filter((e) => {
    e.turnsLeft -= 1;
    return e.turnsLeft > 0;
  });

  const tier0Ids = scenario.resources.filter((r) => r.tier === 0).map((r) => r.id);
  const rolled = rollEvent(state.rngState, tier0Ids);
  state.rngState = rolled.nextState;
  if (!rolled.event) return;

  const effect = rolled.event;
  if (effect.effect.type === 'outputCut') {
    // Immediate one-off: destroy a fraction of inventory now.
    const factor = state.player.defenses.insurance ? effect.effect.multiplier / 2 : effect.effect.multiplier;
    for (const id of Object.keys(state.player.inventory)) {
      const entry = state.player.inventory[id];
      entry.qty = Math.floor(entry.qty * (1 - factor));
    }
    addLedger(state.ledger, state.turn, effect.label, 0, state.player.cash);
    return;
  }

  if (effect.effect.type === 'productionHalt') {
    // Suspend a random active license for 2 turns.
    const active = state.player.licenses.filter((l) => l.status === 'active');
    if (active.length > 0) {
      const { value, nextState } = nextRandom(state.rngState);
      state.rngState = nextState;
      const target = active[Math.floor(value * active.length)];
      const hasLegal = state.player.defenses.legalTeam;
      if (!hasLegal || value < 0.5) {
        target.status = 'suspended';
        target.suspendedTurnsLeft = 2;
        addLedger(state.ledger, state.turn, `${effect.label}: ${target.resourceId} suspended`, 0, state.player.cash);
      }
    }
    return;
  }

  // Persistent effects (supplyShift, costMultiplier) live in activeEffects
  // and get read during MARKET / PRODUCE.
  state.activeEffects.push(effect as ActiveEffect);
}

// --- MARKET ---------------------------------------------------------------

function runMarket(state: GameState, scenario: ScenarioConfig) {
  const basePrices: Record<string, number> = {};
  for (const r of scenario.resources) basePrices[r.id] = r.basePrice;

  // Apply active supply shifts before drift/pressure this turn.
  for (const eff of state.activeEffects) {
    if (eff.effect.type === 'supplyShift') {
      const entry = state.market[eff.effect.resourceId];
      if (entry) entry.supply = Math.max(1, entry.supply * eff.effect.multiplier);
    }
  }

  const updated = updateAllMarkets(state.market, basePrices, state.rngState);
  state.market = updated.market;
  state.rngState = updated.nextState;

  // Rivals produce into the market (adds supply pressure for next turn) and reprice.
  for (const rival of state.rivals) {
    for (const lic of rival.licenses) {
      if (lic.status !== 'active') continue;
      const entry = state.market[lic.resourceId];
      if (!entry) continue;
      entry.supply += 10; // flat rival output, kept simple for v1
      rival.postedPrices[lic.resourceId] = repriceRival(rival, lic.resourceId, entry.price);
    }
  }
}

// --- CONTRACT BOARD ---------------------------------------------------------

function runContractBoard(state: GameState, scenario: ScenarioConfig) {
  const isDiscovered = makeDiscoveryChecker(state);

  const refreshed = refreshContractBoard(state.contractBoard, scenario, state.market, state.rngState, state.turn, isDiscovered);
  state.contractBoard = refreshed.board;
  state.rngState = refreshed.nextState;

  const refreshedStanding = refreshStandingOfferBoard(
    state.standingOfferBoard,
    scenario,
    state.market,
    state.rngState,
    state.turn,
    isDiscovered
  );
  state.standingOfferBoard = refreshedStanding.board;
  state.rngState = refreshedStanding.nextState;
}

// --- PLAYER ACTIONS ---------------------------------------------------------

function findRecipe(state: GameState, resourceId: string, recipeId?: string): Recipe | undefined {
  const candidates = state.recipes.filter((r) => r.output === resourceId);
  if (recipeId) return candidates.find((r) => r.id === recipeId);
  return candidates[0];
}

function costMultiplierNow(state: GameState): number {
  const eff = state.activeEffects.find((e) => e.effect.type === 'costMultiplier');
  return eff && eff.effect.type === 'costMultiplier' ? eff.effect.multiplier : 1;
}

// Cost/duration curve for leveling up: cheaper and faster than a fresh build,
// scaling with the level being left behind so each step costs more than the last.
export function levelUpCost(def: FacilityTypeDef, currentLevel: number): number {
  return Math.round(def.buildCost * 0.5 * currentLevel);
}

export function levelUpDuration(def: FacilityTypeDef): number {
  return Math.max(1, Math.round(def.buildTurns * 0.5));
}

// Effective production capacity for a facility this tick (level × staffing × condition).
export function effectiveCapacity(facility: Facility): number {
  const staffRatio = facility.requiredWorkers > 0 ? Math.min(1, facility.hiredWorkers / facility.requiredWorkers) : 1;
  const levelMultiplier = 1 + (facility.level - 1) * LEVEL_CAPACITY_BONUS;
  return facility.capacityPerTurn * levelMultiplier * staffRatio * (facility.condition / 100);
}

// Produce up to `maxUnits` of a resource, bounded by license, facility, per-tick
// capacity remaining, known recipe, and available ingredients. Returns units made.
// Shared by the manual produce command and auto-production each tick.
function tryProduce(state: GameState, resourceId: string, maxUnits: number, scenario: ScenarioConfig): number {
  const player = state.player;
  const resource = resourceById(scenario, resourceId);
  const license = player.licenses.find((l) => l.resourceId === resourceId);
  if (!license || license.status !== 'active') return 0;

  // Facilities are dedicated to one resource (chosen at build time / reassigned
  // later) — a facility mid-level-up still counts (it keeps its current level's
  // output), only a fresh build (buildTurnsLeft > 0) blocks production.
  const facility = player.facilities.find(
    (f) => f.type === resource.facility && f.assignedResourceId === resourceId && f.buildTurnsLeft === 0
  );
  if (!facility) return 0;
  const remaining = Math.floor(effectiveCapacity(facility) - facility.capacityUsedThisTick);
  const cap = Math.min(maxUnits, remaining);
  if (cap <= 0) return 0;

  const recipe = findRecipe(state, resourceId);
  if (!recipe || !player.knowledge.knownRecipeIds.has(recipe.id)) return 0;

  let batches = Math.floor(cap / recipe.outputQty);
  for (const i of recipe.inputs) {
    const have = player.inventory[i.ingredientId]?.qty ?? 0;
    batches = Math.min(batches, Math.floor(have / i.qty));
  }
  if (batches <= 0) return 0;

  for (const i of recipe.inputs) player.inventory[i.ingredientId].qty -= i.qty * batches;
  const produced = batches * recipe.outputQty;
  const inv = player.inventory[resourceId] ?? { qty: 0, ageTurns: 0 };
  inv.qty += produced;
  player.inventory[resourceId] = inv;
  facility.capacityUsedThisTick += produced;
  license.unitsProducedThisPeriod += produced;
  const verb = recipe.inputs.length === 0 ? 'Extracted' : 'Produced';
  addLedger(state.ledger, state.turn, `${verb} ${produced} ${resourceId}`, 0, player.cash);
  return produced;
}

// Auto-production: each enabled output makes as much as it can this tick.
function runAutoProduction(state: GameState, scenario: ScenarioConfig) {
  for (const resourceId of state.player.autoProduce) {
    tryProduce(state, resourceId, Infinity, scenario);
  }
}

// --- Passive per-tick processing (no player input) -------------------------

function runResearchProgress(state: GameState, scenario: ScenarioConfig) {
  const player = state.player;
  if (!player.knowledge.activeCommission) return;
  const commission = player.knowledge.activeCommission;
  commission.turnsLeft -= 1;
  if (commission.turnsLeft > 0) return;

  const known = player.knowledge.knownRecipeIds;
  const isResourceKnown = (rid: string) => state.recipes.some((r) => r.output === rid && known.has(r.id));

  let candidates;
  if (commission.blind) {
    // Discover any recipe you can now reach: every ingredient is already known
    // (climb the tree by ingredient). From nothing → tier-0 extractions.
    candidates = state.recipes.filter(
      (r) => !known.has(r.id) && r.inputs.every((i) => isResourceKnown(i.ingredientId))
    );
  } else {
    // Ingredient-directed: discover a crafted recipe whose inputs are all among
    // the chosen ingredients (and each is known-to-make), AND whose output is
    // the tier the player paid to target.
    const chosenSet = new Set(commission.ingredients ?? []);
    candidates = state.recipes.filter(
      (r) =>
        !known.has(r.id) &&
        r.inputs.length > 0 &&
        r.inputs.every((i) => chosenSet.has(i.ingredientId) && isResourceKnown(i.ingredientId)) &&
        resourceById(scenario, r.output).tier === commission.targetTier
    );
  }

  if (candidates.length > 0) {
    const { value, nextState } = nextRandom(state.rngState);
    state.rngState = nextState;
    const chosen = candidates[Math.floor(value * candidates.length)];
    known.add(chosen.id);
    if (!chosen.firstDiscoveredTurn) chosen.firstDiscoveredTurn = state.turn;
    addLedger(state.ledger, state.turn, `Research discovered: ${chosen.output}`, 0, player.cash);
    // A recipe that's already published (e.g. Malt) is common industry
    // knowledge rivals had from turn 1 — there's no real disclosure choice to
    // make (exclusivity was never actually possible), so don't offer one.
    if (!chosen.published) {
      state.pendingDisclosures.push({ recipeId: chosen.id });
    }
    // Discovering it means owning it — a free license grant, not just
    // knowledge. Skipped only if already held or out of license slots.
    const grantedLicenses = grantDiscoveryLicense(player.licenses, player.licenseSlots, chosen.output, scenario);
    if (grantedLicenses !== player.licenses) {
      player.licenses = grantedLicenses;
      addLedger(state.ledger, state.turn, `License granted (discovery reward): ${chosen.output}`, 0, player.cash);
    }
  } else {
    addLedger(state.ledger, state.turn, 'Research found nothing new', 0, player.cash);
  }
  player.knowledge.activeCommission = undefined;
}

// Rivals do their own background research — the same "climb the tree by
// ingredient" algorithm as the player's blind Breakthrough, rolled
// independently per rival each turn. This is what makes "discover it, own
// it" a real race rather than a player-only mechanic: a rival can discover
// (and get auto-licensed for) the same recipe the player is chasing, on the
// same turn or a different one — grantDiscoveryLicense has no cross-company
// exclusivity, so simultaneous discovery just means both end up licensed.
const RIVAL_RESEARCH_CHANCE = 0.15;

function runRivalResearch(state: GameState, scenario: ScenarioConfig) {
  for (const rival of state.rivals) {
    const isResourceKnown = (rid: string) => state.recipes.some((r) => r.output === rid && rival.knownRecipeIds.has(r.id));
    const candidates = state.recipes.filter(
      (r) => !rival.knownRecipeIds.has(r.id) && r.inputs.every((i) => isResourceKnown(i.ingredientId))
    );
    if (candidates.length === 0) continue;

    const roll = nextRandom(state.rngState);
    state.rngState = roll.nextState;
    if (roll.value > RIVAL_RESEARCH_CHANCE) continue;

    const pick = nextRandom(state.rngState);
    state.rngState = pick.nextState;
    const chosen = candidates[Math.floor(pick.value * candidates.length)];
    rival.knownRecipeIds.add(chosen.id);
    if (!chosen.firstDiscoveredTurn) chosen.firstDiscoveredTurn = state.turn;

    const grantedLicenses = grantDiscoveryLicense(rival.licenses, rival.licenseSlots, chosen.output, scenario);
    const gotLicense = grantedLicenses !== rival.licenses;
    rival.licenses = grantedLicenses;
    addLedger(
      state.ledger,
      state.turn,
      `${rival.name} discovered${gotLicense ? ' and licensed' : ''}: ${chosen.output}`,
      0,
      state.player.cash
    );
  }
}

// A recipe's exclusivity window ("stay exclusive for 30 minutes") ticks down
// regardless of what else happens; once it lapses the recipe auto-publishes
// to every rival, same end state as choosing "free" up front.
const EXCLUSIVE_DURATION_TURNS = 30;

function runExclusivityClock(state: GameState) {
  for (const recipe of state.recipes) {
    if (recipe.exclusiveTurnsLeft === undefined) continue;
    recipe.exclusiveTurnsLeft -= 1;
    if (recipe.exclusiveTurnsLeft <= 0) {
      recipe.exclusiveTurnsLeft = undefined;
      recipe.published = true;
      for (const rival of state.rivals) rival.knownRecipeIds.add(recipe.id);
      addLedger(state.ledger, state.turn, `Recipe went public: ${recipe.output}`, 0, state.player.cash);
    }
  }
}

// A recipe's private sale value scales with what it lets you produce — pegged
// to the resource's base price so a Keg Beer recipe is worth far more than a
// Barley one, without needing a separate "recipe value" config.
export function estimateRecipeSalePrice(resource: Resource): number {
  return Math.round(resource.basePrice * 20);
}

function runSupplyContracts(state: GameState) {
  const player = state.player;
  player.supplyContracts = player.supplyContracts.filter((c) => {
    if (c.settledThisTurn) {
      // Already sent/bought early this turn via sendSupplyContractNow —
      // don't settle again, just clear the flag for next turn.
      c.settledThisTurn = false;
    } else if (c.side === 'sell') {
      const have = player.inventory[c.resourceId]?.qty ?? 0;
      if (have >= c.qtyPerTurn) {
        player.inventory[c.resourceId].qty -= c.qtyPerTurn;
        player.cash += c.qtyPerTurn * c.price;
        c.missedStreak = 0;
      } else {
        c.missedStreak += 1;
      }
    } else {
      const cost = c.qtyPerTurn * c.price;
      if (player.cash >= cost) {
        player.cash -= cost;
        const inv = player.inventory[c.resourceId] ?? { qty: 0, ageTurns: 0 };
        inv.qty += c.qtyPerTurn;
        player.inventory[c.resourceId] = inv;
        c.missedStreak = 0;
      } else {
        c.missedStreak += 1;
      }
    }
    c.turnsLeft -= 1;
    if (c.missedStreak >= 2) {
      player.reputation = Math.max(0, player.reputation - 10);
      addLedger(state.ledger, state.turn, `Contract breach: ${c.resourceId}`, 0, player.cash);
      return false;
    }
    return c.turnsLeft > 0;
  });
}

// Loans stay on the books until fully repaid — missing a payment just skips
// it (with a reputation ding) and keeps charging the same amount next tick,
// rather than seizing collateral (there is none in this unsecured product).
function runLoanPayments(state: GameState) {
  const player = state.player;
  for (const loan of player.loans) {
    const payment = Math.min(loan.paymentPerTurn, loan.remaining);
    if (player.cash >= payment) {
      player.cash -= payment;
      loan.remaining -= payment;
      addLedger(state.ledger, state.turn, 'Loan payment', -payment, player.cash);
    } else {
      loan.missedPayments += 1;
      player.reputation = Math.max(0, player.reputation - LOAN_MISS_REPUTATION_PENALTY);
      addLedger(state.ledger, state.turn, 'Missed loan payment', 0, player.cash);
    }
    loan.termTurnsLeft = Math.max(0, loan.termTurnsLeft - 1);
  }
  player.loans = player.loans.filter((l) => l.remaining > 0);
}

// Delivers a quest contract if enough inventory is on hand. Shared by the
// automatic tick check and the player's instant "Deliver" command.
function tryFulfillQuest(state: GameState, contract: QuestContract): boolean {
  const player = state.player;
  const needed = contract.qty - contract.deliveredQty;
  const have = player.inventory[contract.resourceId]?.qty ?? 0;
  if (have < needed) return false;
  player.inventory[contract.resourceId].qty -= needed;
  player.cash += contract.payout;
  player.reputation = Math.min(100, player.reputation + contract.reputationReward);
  addLedger(state.ledger, state.turn, `Quest fulfilled: ${contract.resourceId}`, contract.payout, player.cash);
  return true;
}

function runQuestDeadlines(state: GameState) {
  const player = state.player;
  player.questContracts = player.questContracts.filter((c) => {
    c.deadlineTurnsLeft -= 1;
    if (tryFulfillQuest(state, c)) return false;
    if (c.deadlineTurnsLeft <= 0) {
      player.cash -= c.penalty;
      player.reputation = Math.max(0, player.reputation - 5);
      addLedger(state.ledger, state.turn, `Quest missed: ${c.resourceId}`, -c.penalty, player.cash);
      return false;
    }
    return true;
  });
}

function runPerishable(state: GameState, scenario: ScenarioConfig) {
  const player = state.player;
  for (const r of scenario.resources) {
    if (!r.shelfLifeTurns) continue;
    const inv = player.inventory[r.id];
    if (!inv || inv.qty <= 0) continue;
    inv.ageTurns += 1;
    if (inv.ageTurns > r.shelfLifeTurns) {
      addLedger(state.ledger, state.turn, `Spoiled: ${r.id} (${inv.qty} written off)`, 0, player.cash);
      inv.qty = 0;
      inv.ageTurns = 0;
    }
  }
}

function runResolve(state: GameState, scenario: ScenarioConfig) {
  const netWorth = assetValue(state.player, scenario);
  if (state.player.cash < 0) {
    state.gameOver = { result: 'bankrupt', turn: state.turn };
  } else if (state.turn >= WIN_TURN) {
    state.gameOver = { result: 'won', turn: state.turn };
  }
  addLedger(state.ledger, state.turn, 'Net worth', 0, netWorth);
  state.turn += 1;
}

// --- Public API: real-time tick + instant commands -------------------------

// One step of the simulation clock. Player commands are NOT applied here —
// they arrive instantly via applyCommand between ticks.
export function tick(prevState: GameState, scenario: ScenarioConfig): GameState {
  const state = clone(prevState);
  if (state.gameOver) return state;

  // Reset per-tick production budget so capacity is a per-tick limit.
  for (const f of state.player.facilities) f.capacityUsedThisTick = 0;

  runUpkeep(state, scenario);
  runEvents(state, scenario);
  runMarket(state, scenario);
  runContractBoard(state, scenario);
  runAutoProduction(state, scenario);
  runResearchProgress(state, scenario);
  runRivalResearch(state, scenario);
  runExclusivityClock(state);
  runSupplyContracts(state);
  runLoanPayments(state);
  runQuestDeadlines(state);
  runPerishable(state, scenario);
  runResolve(state, scenario);

  return state;
}

// A single player action, applied immediately (real-time). Each returns a new
// state; illegal/unaffordable actions are no-ops.
export type Command =
  | { kind: 'produce'; resourceId: ResourceId; qty: number; recipeId?: string }
  | { kind: 'toggleAutoProduce'; resourceId: ResourceId; on: boolean }
  | { kind: 'buyLicense'; resourceId: ResourceId }
  | { kind: 'dropLicense'; resourceId: ResourceId }
  | { kind: 'buildFacility'; facilityType: string; resourceId: ResourceId }
  | { kind: 'levelUpFacility'; facilityId: FacilityId }
  | { kind: 'reassignFacility'; facilityId: FacilityId; resourceId: ResourceId }
  | { kind: 'hireFire'; facilityId: FacilityId; targetWorkers: number }
  | { kind: 'fundMaintenance'; facilityId: FacilityId; funded: boolean }
  | { kind: 'toggleInsurance'; on: boolean }
  | { kind: 'toggleLegalTeam'; on: boolean }
  | { kind: 'researchBlind' }
  | { kind: 'researchByIngredients'; ingredients: ResourceId[]; targetTier: number }
  | { kind: 'acceptQuestContract'; id: string }
  | { kind: 'acceptStandingOffer'; id: string }
  | { kind: 'deliverQuestContract'; id: string }
  | { kind: 'cancelQuestContract'; id: string }
  | {
      kind: 'proposeSupplyContract';
      side: 'sell' | 'buy';
      resourceId: ResourceId;
      qtyPerTurn: number;
      price: number;
      turnsLeft: number;
    }
  | { kind: 'cancelSupplyContract'; id: string }
  | { kind: 'sendSupplyContractNow'; id: string }
  | { kind: 'lawsuitDecision'; decision: 'settle' | 'fight' }
  | { kind: 'resolveDisclosure'; choice: 'free' | 'exclusive' | 'sell' }
  | { kind: 'takeLoan'; amount: number }
  | { kind: 'repayLoanEarly'; loanId: string }
  | { kind: 'payLoanNow'; loanId: string }
  | { kind: 'renewLicenseNow'; resourceId: ResourceId }
  | { kind: 'payFacilityUpkeepNow'; facilityId: FacilityId };

export function applyCommand(prevState: GameState, cmd: Command, scenario: ScenarioConfig): GameState {
  const state = clone(prevState);
  if (state.gameOver) return state;
  const player = state.player;

  switch (cmd.kind) {
    case 'lawsuitDecision': {
      if (!state.pendingLawsuit) break;
      const suit = state.pendingLawsuit;
      if (cmd.decision === 'settle') {
        player.cash -= suit.settleCost;
        addLedger(state.ledger, state.turn, `Settled lawsuit: ${suit.label}`, -suit.settleCost, player.cash);
      } else {
        const { value, nextState } = nextRandom(state.rngState);
        state.rngState = nextState;
        if (value < suit.fightWinChance) {
          addLedger(state.ledger, state.turn, `Won lawsuit: ${suit.label}`, 0, player.cash);
        } else {
          player.cash -= suit.fightLoseCost;
          player.reputation = Math.max(0, player.reputation - suit.reputationLossIfLose);
          addLedger(state.ledger, state.turn, `Lost lawsuit: ${suit.label}`, -suit.fightLoseCost, player.cash);
        }
      }
      state.pendingLawsuit = undefined;
      break;
    }

    case 'resolveDisclosure': {
      const pending = state.pendingDisclosures.shift();
      if (!pending) break;
      const recipe = state.recipes.find((r) => r.id === pending.recipeId);
      if (!recipe) break;

      if (cmd.choice === 'free') {
        recipe.published = true;
        for (const rival of state.rivals) rival.knownRecipeIds.add(recipe.id);
        addLedger(state.ledger, state.turn, `Published recipe: ${recipe.output}`, 0, player.cash);
      } else if (cmd.choice === 'exclusive') {
        recipe.exclusiveTurnsLeft = EXCLUSIVE_DURATION_TURNS;
        addLedger(state.ledger, state.turn, `Kept exclusive: ${recipe.output} (${EXCLUSIVE_DURATION_TURNS}min)`, 0, player.cash);
      } else if (cmd.choice === 'sell' && state.rivals.length > 0) {
        const { value, nextState } = nextRandom(state.rngState);
        state.rngState = nextState;
        const buyer = state.rivals[Math.floor(value * state.rivals.length)];
        const resource = resourceById(scenario, recipe.output);
        const price = estimateRecipeSalePrice(resource);
        buyer.knownRecipeIds.add(recipe.id);
        buyer.cash -= price;
        player.cash += price;
        addLedger(state.ledger, state.turn, `Sold recipe privately to ${buyer.name}: ${recipe.output}`, price, player.cash);
      }
      break;
    }

    case 'buyLicense': {
      const def = licenseDefById(scenario, cmd.resourceId);
      const already = player.licenses.some((l) => l.resourceId === def.resourceId);
      if (!already && player.licenses.length < player.licenseSlots && player.cash >= def.upfrontCost && player.reputation >= def.minReputation) {
        player.cash -= def.upfrontCost;
        player.licenses.push({
          resourceId: def.resourceId,
          status: 'active',
          turnsUntilRenewal: def.renewalPeriod,
          unitsProducedThisPeriod: 0,
          turnsUntilQuotaCheck: def.quotaPeriodTurns,
        });
        addLedger(state.ledger, state.turn, `Bought license: ${def.resourceId}`, -def.upfrontCost, player.cash);
      }
      break;
    }

    case 'dropLicense':
      player.licenses = player.licenses.filter((l) => l.resourceId !== cmd.resourceId);
      break;

    case 'buildFacility': {
      const def = facilityTypeDef(scenario, cmd.facilityType);
      const resource = resourceById(scenario, cmd.resourceId);
      if (resource.facility === def.type && player.cash >= def.buildCost) {
        player.cash -= def.buildCost;
        const newFacility: Facility = {
          id: `facility_${player.facilities.length + 1}`,
          type: def.type,
          assignedResourceId: cmd.resourceId,
          capacityPerTurn: def.baseCapacity,
          level: 1,
          buildTurnsLeft: def.buildTurns,
          upkeepPerTurn: def.upkeepPerTurn,
          requiredWorkers: def.workersForFullCapacity,
          hiredWorkers: 0,
          wageRatio: 1.0,
          condition: 100,
          maintenanceFunded: true,
          capacityUsedThisTick: 0,
          upkeepPrepaid: false,
        };
        player.facilities.push(newFacility);
        // New facilities default to producing — matches the starting
        // facility's default; the player can still switch it off in Facilities.
        if (!player.autoProduce.includes(cmd.resourceId)) player.autoProduce = [...player.autoProduce, cmd.resourceId];
        addLedger(state.ledger, state.turn, `Built facility: ${def.type} → ${cmd.resourceId}`, -def.buildCost, player.cash);
      }
      break;
    }

    case 'levelUpFacility': {
      const facility = player.facilities.find((f) => f.id === cmd.facilityId);
      if (
        facility &&
        facility.buildTurnsLeft === 0 &&
        facility.levelUpTurnsLeft === undefined &&
        facility.level < MAX_FACILITY_LEVEL
      ) {
        const def = facilityTypeDef(scenario, facility.type);
        const cost = levelUpCost(def, facility.level);
        if (player.cash >= cost) {
          player.cash -= cost;
          facility.levelUpTurnsLeft = levelUpDuration(def);
          addLedger(state.ledger, state.turn, `Leveling up ${facility.type} (L${facility.level} → L${facility.level + 1})`, -cost, player.cash);
        }
      }
      break;
    }

    case 'reassignFacility': {
      const facility = player.facilities.find((f) => f.id === cmd.facilityId);
      const resource = resourceById(scenario, cmd.resourceId);
      if (facility && resource.facility === facility.type) {
        facility.assignedResourceId = cmd.resourceId;
        // Reassigning defaults to producing the new output too.
        if (!player.autoProduce.includes(cmd.resourceId)) player.autoProduce = [...player.autoProduce, cmd.resourceId];
        addLedger(state.ledger, state.turn, `Reassigned ${facility.type} to ${cmd.resourceId}`, 0, player.cash);
      }
      break;
    }

    case 'hireFire': {
      const facility = player.facilities.find((f) => f.id === cmd.facilityId);
      if (facility) {
        const delta = cmd.targetWorkers - facility.hiredWorkers;
        if (delta < 0) {
          const def = facilityTypeDef(scenario, facility.type);
          const severance = -delta * def.standardWage * 2;
          player.cash -= severance;
          addLedger(state.ledger, state.turn, `Severance: ${facility.type}`, -severance, player.cash);
        }
        facility.hiredWorkers = Math.max(0, cmd.targetWorkers);
      }
      break;
    }

    case 'fundMaintenance': {
      const facility = player.facilities.find((f) => f.id === cmd.facilityId);
      if (facility) facility.maintenanceFunded = cmd.funded;
      break;
    }

    case 'toggleInsurance':
      player.defenses.insurance = cmd.on;
      break;

    case 'toggleLegalTeam':
      player.defenses.legalTeam = cmd.on;
      break;

    case 'researchBlind':
      if (!player.knowledge.activeCommission && player.cash >= scenario.researchCost) {
        player.cash -= scenario.researchCost;
        player.knowledge.activeCommission = { blind: true, turnsLeft: 3 };
        addLedger(state.ledger, state.turn, 'Commissioned research (breakthrough)', -scenario.researchCost, player.cash);
      }
      break;

    case 'researchByIngredients': {
      const cost = ingredientResearchCost(cmd.targetTier);
      if (!player.knowledge.activeCommission && cmd.ingredients.length > 0 && cmd.targetTier > 0 && player.cash >= cost) {
        player.cash -= cost;
        player.knowledge.activeCommission = { ingredients: [...cmd.ingredients], turnsLeft: 3, targetTier: cmd.targetTier };
        addLedger(state.ledger, state.turn, `Commissioned research (ingredients, tier ${cmd.targetTier})`, -cost, player.cash);
      }
      break;
    }
      break;

    case 'produce':
      tryProduce(state, cmd.resourceId, cmd.qty, scenario);
      break;

    case 'toggleAutoProduce': {
      const set = new Set(player.autoProduce);
      if (cmd.on) set.add(cmd.resourceId);
      else set.delete(cmd.resourceId);
      player.autoProduce = [...set];
      break;
    }

    case 'acceptQuestContract': {
      const idx = state.contractBoard.findIndex((q) => q.id === cmd.id && q.boardTurnsLeft !== undefined);
      if (idx >= 0) {
        const [offer] = state.contractBoard.splice(idx, 1);
        offer.boardTurnsLeft = undefined;
        player.questContracts.push(offer);
        addLedger(state.ledger, state.turn, `Accepted contract: ${offer.resourceId}`, 0, player.cash);
      }
      break;
    }

    case 'deliverQuestContract': {
      const c = player.questContracts.find((q) => q.id === cmd.id);
      if (c && tryFulfillQuest(state, c)) {
        player.questContracts = player.questContracts.filter((q) => q.id !== c.id);
      }
      break;
    }

    case 'cancelQuestContract': {
      const idx = player.questContracts.findIndex((q) => q.id === cmd.id);
      if (idx >= 0) {
        const [c] = player.questContracts.splice(idx, 1);
        // Walking away early costs half the miss penalty — cheaper than letting
        // it lapse, but not free, so accepting a contract still carries risk.
        const fee = Math.round(c.penalty * 0.5);
        player.cash -= fee;
        addLedger(state.ledger, state.turn, `Cancelled contract: ${c.resourceId}`, -fee, player.cash);
      }
      break;
    }

    case 'acceptStandingOffer': {
      const idx = state.standingOfferBoard.findIndex((o) => o.id === cmd.id);
      if (idx >= 0) {
        const [offer] = state.standingOfferBoard.splice(idx, 1);
        player.supplyContracts.push({
          id: `supply_${state.turn}_${player.supplyContracts.length}`,
          side: 'sell',
          counterparty: offer.issuer,
          resourceId: offer.resourceId,
          qtyPerTurn: offer.qtyPerTurn,
          price: offer.price,
          turnsLeft: offer.turnsLeft,
          cancelFine: Math.round(3 * offer.qtyPerTurn * offer.price),
          missedStreak: 0,
          settledThisTurn: false,
        });
        addLedger(state.ledger, state.turn, `Accepted standing offer: ${offer.resourceId}`, 0, player.cash);
      }
      break;
    }

    case 'proposeSupplyContract': {
      player.supplyContracts.push({
        id: `supply_${state.turn}_${player.supplyContracts.length}`,
        side: cmd.side,
        counterparty: 'Market',
        resourceId: cmd.resourceId,
        qtyPerTurn: cmd.qtyPerTurn,
        price: cmd.price,
        turnsLeft: cmd.turnsLeft,
        cancelFine: Math.round(3 * cmd.qtyPerTurn * cmd.price),
        missedStreak: 0,
        settledThisTurn: false,
      });
      addLedger(state.ledger, state.turn, `Proposed supply contract: ${cmd.resourceId}`, 0, player.cash);
      break;
    }

    case 'cancelSupplyContract': {
      const idx = player.supplyContracts.findIndex((c) => c.id === cmd.id);
      if (idx >= 0) {
        const [c] = player.supplyContracts.splice(idx, 1);
        player.cash -= c.cancelFine;
        addLedger(state.ledger, state.turn, `Cancelled supply contract: ${c.resourceId}`, -c.cancelFine, player.cash);
      }
      break;
    }

    // Settles this turn's delivery/purchase right now instead of waiting for
    // the automatic end-of-turn settlement — same anti-double-charge pattern
    // as payLoanNow/renewLicenseNow/payFacilityUpkeepNow: runSupplyContracts
    // skips a contract marked settledThisTurn and just resets the flag.
    case 'sendSupplyContractNow': {
      const c = player.supplyContracts.find((sc) => sc.id === cmd.id);
      if (c && !c.settledThisTurn) {
        if (c.side === 'sell') {
          const have = player.inventory[c.resourceId]?.qty ?? 0;
          if (have >= c.qtyPerTurn) {
            player.inventory[c.resourceId].qty -= c.qtyPerTurn;
            player.cash += c.qtyPerTurn * c.price;
            c.missedStreak = 0;
            c.settledThisTurn = true;
            addLedger(state.ledger, state.turn, `Sent early: ${c.resourceId}`, c.qtyPerTurn * c.price, player.cash);
          }
        } else {
          const cost = c.qtyPerTurn * c.price;
          if (player.cash >= cost) {
            player.cash -= cost;
            const inv = player.inventory[c.resourceId] ?? { qty: 0, ageTurns: 0 };
            inv.qty += c.qtyPerTurn;
            player.inventory[c.resourceId] = inv;
            c.missedStreak = 0;
            c.settledThisTurn = true;
            addLedger(state.ledger, state.turn, `Bought early: ${c.resourceId}`, -cost, player.cash);
          }
        }
      }
      break;
    }

    case 'takeLoan': {
      const limit = loanCreditLimit(player, scenario);
      if (cmd.amount > 0 && cmd.amount <= limit) {
        const remaining = Math.round(cmd.amount * (1 + LOAN_INTEREST_RATE));
        const newLoan: Loan = {
          id: `loan_${state.turn}_${player.loans.length}`,
          principal: cmd.amount,
          remaining,
          paymentPerTurn: Math.round((remaining / LOAN_TERM_TURNS) * 100) / 100,
          termTurnsLeft: LOAN_TERM_TURNS,
          missedPayments: 0,
        };
        player.cash += cmd.amount;
        player.loans.push(newLoan);
        addLedger(state.ledger, state.turn, `Took loan: ${cmd.amount}g`, cmd.amount, player.cash);
      }
      break;
    }

    case 'repayLoanEarly': {
      const idx = player.loans.findIndex((l) => l.id === cmd.loanId);
      if (idx >= 0 && player.cash >= player.loans[idx].remaining) {
        const [loan] = player.loans.splice(idx, 1);
        player.cash -= loan.remaining;
        addLedger(state.ledger, state.turn, 'Repaid loan early', -loan.remaining, player.cash);
      }
      break;
    }

    // Pays exactly one scheduled installment right now instead of waiting for
    // the automatic end-of-turn deduction. Safe with no extra bookkeeping —
    // it just lowers `remaining`, so the automatic payment charges less (or
    // nothing) once the turn actually ends.
    case 'payLoanNow': {
      const loan = player.loans.find((l) => l.id === cmd.loanId);
      if (loan) {
        const payment = Math.min(loan.paymentPerTurn, loan.remaining);
        if (payment > 0 && player.cash >= payment) {
          player.cash -= payment;
          loan.remaining -= payment;
          addLedger(state.ledger, state.turn, 'Paid loan installment early', -payment, player.cash);
          if (loan.remaining <= 0) {
            player.loans = player.loans.filter((l) => l.id !== loan.id);
          }
        }
      }
      break;
    }

    // Pays the renewal fee immediately and resets the countdown to a full
    // period — an early renewal, not a discount. Safe: it just moves the
    // same charge earlier, so the automatic renewal in runUpkeep won't
    // double-charge (the countdown starts fresh from here).
    case 'renewLicenseNow': {
      const license = player.licenses.find((l) => l.resourceId === cmd.resourceId);
      if (license) {
        const def = licenseDefById(scenario, cmd.resourceId);
        if (player.cash >= def.renewalCost) {
          player.cash -= def.renewalCost;
          license.turnsUntilRenewal = def.renewalPeriod;
          addLedger(state.ledger, state.turn, `Renewed early: ${cmd.resourceId}`, -def.renewalCost, player.cash);
        }
      }
      break;
    }

    // Pays this turn's upkeep+payroll right now and marks the facility so
    // runUpkeep skips its automatic charge (and clears the flag) at turn's
    // end — same anti-double-charge pattern as payLoanNow/renewLicenseNow.
    case 'payFacilityUpkeepNow': {
      const facility = player.facilities.find((f) => f.id === cmd.facilityId);
      if (facility && facility.buildTurnsLeft === 0 && !facility.upkeepPrepaid) {
        const def = facilityTypeDef(scenario, facility.type);
        const upkeep = facility.upkeepPerTurn * costMultiplierNow(state);
        const wage = def.standardWage * facility.wageRatio * facility.hiredWorkers;
        const total = upkeep + wage;
        if (player.cash >= total) {
          player.cash -= total;
          facility.upkeepPrepaid = true;
          addLedger(state.ledger, state.turn, `Paid upkeep+payroll early: ${facility.type}`, -total, player.cash);
        }
      }
      break;
    }
  }

  return state;
}
