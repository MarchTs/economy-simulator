import type { ScenarioConfig } from '../scenarios/types';
import type { CompanyState, Facility, GameState, HeldLicense, MarketEntry, RivalCompany } from './types';

function makeStartingFacility(scenario: ScenarioConfig): Facility {
  const def = scenario.facilityTypes.find((f) => f.type === scenario.startingFacility.type)!;
  return {
    id: 'facility_1',
    type: def.type,
    assignedResourceId: scenario.startingLicenseResourceId[0],
    capacityPerTurn: def.baseCapacity,
    level: 1,
    buildTurnsLeft: 0,
    upkeepPerTurn: def.upkeepPerTurn,
    requiredWorkers: def.workersForFullCapacity,
    hiredWorkers: def.workersForFullCapacity,
    wageRatio: 1.0,
    condition: 100,
    maintenanceFunded: true,
    capacityUsedThisTick: 0,
    upkeepPrepaid: false,
  };
}

function makeStartingLicense(scenario: ScenarioConfig): HeldLicense {
  const resourceId = scenario.startingLicenseResourceId[0];
  const def = scenario.licenses.find((l) => l.resourceId === resourceId)!;
  return {
    resourceId,
    status: 'active',
    turnsUntilRenewal: def.renewalPeriod,
    unitsProducedThisPeriod: 0,
    turnsUntilQuotaCheck: def.quotaPeriodTurns,
  };
}

function makeInitialMarket(scenario: ScenarioConfig): Record<string, MarketEntry> {
  const market: Record<string, MarketEntry> = {};
  for (const r of scenario.resources) {
    market[r.id] = { price: r.basePrice, supply: 100, demand: 100 };
  }
  return market;
}

const RIVAL_NAMES: { name: string; personality: RivalCompany['personality'] }[] = [
  { name: 'Golden Hop Co.', personality: 'aggressive' },
  { name: 'Heritage Brewers', personality: 'premium' },
];

const RIVAL_LICENSE_SLOTS = 3;

// Rivals start selling whatever the scenario's first publicly-known recipe
// makes (Brewery: Malt; Bakery: Flour) — scenario-driven so this isn't
// hardcoded to one industry's output.
function makeRivals(scenario: ScenarioConfig): RivalCompany[] {
  const publishedRecipes = scenario.recipes.filter((rc) => rc.published);
  const flagshipResourceId = publishedRecipes[0]?.output ?? scenario.resources[0].id;
  const flagshipResource = scenario.resources.find((r) => r.id === flagshipResourceId)!;

  // Also seed the tier-0 extraction recipes behind whatever rivals already
  // make (e.g. Malt needs Barley) so their own background research (see
  // runRivalResearch in reducer.ts) has real precursor knowledge to climb
  // from, instead of starting permanently stuck with nothing left to reach.
  const baseKnownIds = new Set(publishedRecipes.map((rc) => rc.id));
  for (const r of publishedRecipes) {
    for (const input of r.inputs) {
      const producer = scenario.recipes.find((rc) => rc.output === input.ingredientId);
      if (producer) baseKnownIds.add(producer.id);
    }
  }

  return RIVAL_NAMES.map((r, i) => ({
    id: `rival_${i + 1}`,
    name: r.name,
    personality: r.personality,
    cash: 4000,
    reputation: 50,
    licenses: [
      { resourceId: flagshipResourceId, status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 },
    ],
    licenseSlots: RIVAL_LICENSE_SLOTS,
    knownRecipeIds: new Set(baseKnownIds),
    postedPrices: { [flagshipResourceId]: flagshipResource.basePrice },
    unitCost: { [flagshipResourceId]: Math.round(flagshipResource.basePrice * 0.75) },
    cumulativeLoss: {},
  }));
}

export function newGame(scenario: ScenarioConfig, seed: number): GameState {
  const player: CompanyState = {
    cash: scenario.startingCash,
    reputation: 50,
    inventory: {},
    licenses: [makeStartingLicense(scenario)],
    licenseSlots: 1,
    facilities: [makeStartingFacility(scenario)],
    knowledge: {
      knownRecipeIds: new Set(scenario.startingKnownRecipeIds),
      labLevel: 1,
    },
    autoProduce: [scenario.startingLicenseResourceId[0]],
    questContracts: [],
    supplyContracts: [],
    loans: [],
    defenses: { insurance: false, legalTeam: false, safetyLevel: 0 },
  };

  return {
    turn: 1,
    player,
    rivals: makeRivals(scenario),
    recipes: scenario.recipes.map((r) => ({ ...r })),
    market: makeInitialMarket(scenario),
    activeEffects: [],
    ledger: [{ turn: 0, label: 'Run start', delta: scenario.startingCash, cashAfter: scenario.startingCash }],
    pendingDisclosures: [],
    contractBoard: [],
    standingOfferBoard: [],
    rngState: seed >>> 0,
  };
}
