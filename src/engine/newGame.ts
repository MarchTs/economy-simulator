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

function makeRivals(scenario: ScenarioConfig): RivalCompany[] {
  return RIVAL_NAMES.map((r, i) => ({
    id: `rival_${i + 1}`,
    name: r.name,
    personality: r.personality,
    cash: 4000,
    reputation: 50,
    licenses: [
      { resourceId: 'malt', status: 'active', turnsUntilRenewal: 5, unitsProducedThisPeriod: 0 },
    ],
    knownRecipeIds: new Set(scenario.recipes.filter((rc) => rc.published).map((rc) => rc.id)),
    postedPrices: { malt: 12 },
    unitCost: { malt: 9 },
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
    autoProduce: [],
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
