import type { LicenseDef, Recipe, Resource } from '../../engine/types';
import type { FacilityTypeDef, ScenarioConfig } from '../types';

// Data per license-economy-game-design.md §2.5. Tier-0 resources have no
// Recipe entry (raw extraction: license + facility + workers only, per §3).
const resources: Resource[] = [
  { id: 'barley', name: 'Barley', tier: 0, basePrice: 4, facility: 'farm' },
  { id: 'hops', name: 'Hops', tier: 0, basePrice: 12, facility: 'farm' },
  { id: 'rice', name: 'Rice', tier: 0, basePrice: 3, facility: 'farm' },
  { id: 'silica_sand', name: 'Silica Sand', tier: 0, basePrice: 3, facility: 'quarry' },
  { id: 'aluminum_ore', name: 'Aluminum Ore', tier: 0, basePrice: 6, facility: 'quarry' },

  { id: 'malt', name: 'Malt', tier: 1, basePrice: 12, facility: 'malthouse' },
  { id: 'yeast_culture', name: 'Yeast Culture', tier: 1, basePrice: 8, facility: 'lab' },
  { id: 'glass_bottle', name: 'Glass Bottle', tier: 1, basePrice: 9, facility: 'glassworks' },
  { id: 'aluminum_can', name: 'Aluminum Can', tier: 1, basePrice: 8, facility: 'can_plant' },

  { id: 'keg_beer', name: 'Keg Beer', tier: 2, basePrice: 75, facility: 'brewery' },
  {
    id: 'keg_beer_rice',
    name: 'Keg Beer (rice variant)',
    tier: 2,
    basePrice: 55,
    facility: 'brewery',
  },

  {
    id: 'bottled_beer',
    name: 'Bottled Beer',
    tier: 3,
    basePrice: 160,
    facility: 'packaging_plant',
    shelfLifeTurns: 12,
  },
  {
    id: 'canned_beer',
    name: 'Canned Beer',
    tier: 3,
    basePrice: 145,
    facility: 'packaging_plant',
    shelfLifeTurns: 12,
  },
];

// Tier-0 "extraction recipes": no inputs, unlocked by research/discovery.
// Discovering one lets you extract that raw material (and reveals it on the market).
const extractionRecipes: Recipe[] = [
  { id: 'recipe_extract_barley', output: 'barley', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_hops', output: 'hops', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_rice', output: 'rice', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_silica_sand', output: 'silica_sand', outputQty: 1, facility: 'quarry', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_aluminum_ore', output: 'aluminum_ore', outputQty: 1, facility: 'quarry', inputs: [], published: false, communityLevel: 0 },
];

const recipes: Recipe[] = [
  ...extractionRecipes,
  {
    id: 'recipe_malt',
    output: 'malt',
    outputQty: 1,
    facility: 'malthouse',
    inputs: [{ ingredientId: 'barley', qty: 2 }],
    published: true,
    communityLevel: 0,
  },
  {
    id: 'recipe_glass_bottle',
    output: 'glass_bottle',
    outputQty: 1,
    facility: 'glassworks',
    inputs: [{ ingredientId: 'silica_sand', qty: 2 }],
    published: true,
    communityLevel: 0,
  },
  {
    id: 'recipe_aluminum_can',
    output: 'aluminum_can',
    outputQty: 1,
    facility: 'can_plant',
    inputs: [{ ingredientId: 'aluminum_ore', qty: 1 }],
    published: true,
    communityLevel: 0,
  },
  {
    id: 'recipe_keg_beer',
    output: 'keg_beer',
    outputQty: 1,
    facility: 'brewery',
    inputs: [
      { ingredientId: 'malt', qty: 3 },
      { ingredientId: 'hops', qty: 1 },
      { ingredientId: 'yeast_culture', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_keg_beer_rice',
    output: 'keg_beer_rice',
    outputQty: 1,
    facility: 'brewery',
    inputs: [
      { ingredientId: 'malt', qty: 2 },
      { ingredientId: 'rice', qty: 1 },
      { ingredientId: 'yeast_culture', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_bottled_beer',
    output: 'bottled_beer',
    outputQty: 1,
    facility: 'packaging_plant',
    inputs: [
      { ingredientId: 'keg_beer', qty: 1 },
      { ingredientId: 'glass_bottle', qty: 6 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_canned_beer',
    output: 'canned_beer',
    outputQty: 1,
    facility: 'packaging_plant',
    inputs: [
      { ingredientId: 'keg_beer', qty: 1 },
      { ingredientId: 'aluminum_can', qty: 6 },
    ],
    published: false,
    communityLevel: 0,
  },
];

// Note: yeast_culture has a facility ('lab') but no recipe — produced from
// nothing but carries a contamination event risk (§2.5), modeled as a disaster.

const licenses: LicenseDef[] = [
  { resourceId: 'barley', class: 'open', upfrontCost: 50, renewalCost: 10, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'hops', class: 'open', upfrontCost: 60, renewalCost: 12, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'rice', class: 'open', upfrontCost: 40, renewalCost: 8, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'silica_sand', class: 'open', upfrontCost: 40, renewalCost: 8, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'aluminum_ore', class: 'open', upfrontCost: 55, renewalCost: 11, renewalPeriod: 5, minReputation: 0 },

  { resourceId: 'malt', class: 'closed', upfrontCost: 350, renewalCost: 45, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'yeast_culture', class: 'closed', upfrontCost: 300, renewalCost: 40, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'glass_bottle', class: 'closed', upfrontCost: 400, renewalCost: 50, renewalPeriod: 5, minReputation: 10 },
  { resourceId: 'aluminum_can', class: 'closed', upfrontCost: 400, renewalCost: 50, renewalPeriod: 5, minReputation: 10 },

  {
    resourceId: 'keg_beer',
    class: 'closed',
    upfrontCost: 5000,
    renewalCost: 400,
    renewalPeriod: 5,
    minReputation: 50,
    quotaPerPeriod: 20,
    quotaPeriodTurns: 10,
  },
  {
    resourceId: 'keg_beer_rice',
    class: 'closed',
    upfrontCost: 3500,
    renewalCost: 300,
    renewalPeriod: 5,
    minReputation: 35,
    quotaPerPeriod: 15,
    quotaPeriodTurns: 10,
  },
  { resourceId: 'bottled_beer', class: 'closed', upfrontCost: 800, renewalCost: 100, renewalPeriod: 5, minReputation: 30 },
  { resourceId: 'canned_beer', class: 'closed', upfrontCost: 800, renewalCost: 100, renewalPeriod: 5, minReputation: 30 },
];

const facilityTypes: FacilityTypeDef[] = [
  { type: 'farm', buildCost: 300, buildTurns: 2, baseCapacity: 20, upkeepPerTurn: 5, workersForFullCapacity: 2, standardWage: 8 },
  { type: 'quarry', buildCost: 400, buildTurns: 2, baseCapacity: 20, upkeepPerTurn: 6, workersForFullCapacity: 2, standardWage: 9 },
  { type: 'malthouse', buildCost: 800, buildTurns: 3, baseCapacity: 15, upkeepPerTurn: 10, workersForFullCapacity: 3, standardWage: 12 },
  { type: 'lab', buildCost: 600, buildTurns: 2, baseCapacity: 10, upkeepPerTurn: 8, workersForFullCapacity: 2, standardWage: 14 },
  { type: 'glassworks', buildCost: 900, buildTurns: 3, baseCapacity: 15, upkeepPerTurn: 10, workersForFullCapacity: 3, standardWage: 12 },
  { type: 'can_plant', buildCost: 900, buildTurns: 3, baseCapacity: 15, upkeepPerTurn: 10, workersForFullCapacity: 3, standardWage: 12 },
  { type: 'brewery', buildCost: 5000, buildTurns: 6, baseCapacity: 10, upkeepPerTurn: 50, workersForFullCapacity: 6, standardWage: 20 },
  { type: 'packaging_plant', buildCost: 1500, buildTurns: 4, baseCapacity: 12, upkeepPerTurn: 20, workersForFullCapacity: 4, standardWage: 15 },
];

export const breweryScenario: ScenarioConfig = {
  id: 'brewery',
  name: 'Brewery',
  resources,
  recipes,
  licenses,
  facilityTypes,
  startingCash: 1000,
  startingFacility: { type: 'farm' },
  startingLicenseResourceId: ['barley'],
  startingKnownRecipeIds: ['recipe_extract_barley'],
};
