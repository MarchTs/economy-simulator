import type { LicenseDef, Recipe, Resource } from '../../engine/types';
import type { FacilityTypeDef, ScenarioConfig } from '../types';

// Data per license-economy-game-design.md §2.9 "Bakery" (cake dataset) —
// the doc's tutorial scenario: low capex, cheap licenses, and the only
// scenario that teaches perishability (shelfLifeTurns + runPerishable
// write-offs, both already generic engine features).
const resources: Resource[] = [
  { id: 'wheat', name: 'Wheat', tier: 0, basePrice: 3, facility: 'farm' },
  { id: 'sugarcane', name: 'Sugarcane', tier: 0, basePrice: 4, facility: 'farm' },
  { id: 'egg', name: 'Egg', tier: 0, basePrice: 5, facility: 'farm' },
  { id: 'milk', name: 'Milk', tier: 0, basePrice: 4, facility: 'farm' },
  { id: 'cocoa', name: 'Cocoa', tier: 0, basePrice: 9, facility: 'farm' },
  { id: 'strawberry', name: 'Strawberry', tier: 0, basePrice: 6, facility: 'farm' },

  { id: 'flour', name: 'Flour', tier: 1, basePrice: 8, facility: 'mill' },
  { id: 'sugar', name: 'Sugar', tier: 1, basePrice: 9, facility: 'sugar_mill' },
  { id: 'butter', name: 'Butter', tier: 1, basePrice: 10, facility: 'dairy' },
  { id: 'cream', name: 'Cream', tier: 1, basePrice: 7, facility: 'dairy', shelfLifeTurns: 3 },
  { id: 'chocolate', name: 'Chocolate', tier: 1, basePrice: 22, facility: 'chocolate_factory' },

  { id: 'sponge_base', name: 'Sponge Base', tier: 2, basePrice: 30, facility: 'bakery_kitchen' },
  { id: 'frosting', name: 'Frosting', tier: 2, basePrice: 20, facility: 'bakery_kitchen' },

  { id: 'butter_cake', name: 'Butter Cake', tier: 3, basePrice: 70, facility: 'cake_shop', shelfLifeTurns: 2 },
  { id: 'chocolate_cake', name: 'Chocolate Cake', tier: 3, basePrice: 90, facility: 'cake_shop', shelfLifeTurns: 2 },
  {
    id: 'strawberry_cream_cake',
    name: 'Strawberry Cream Cake',
    tier: 3,
    basePrice: 85,
    facility: 'cake_shop',
    shelfLifeTurns: 2,
  },
  {
    id: 'wedding_cake',
    name: 'Wedding Cake',
    tier: 3,
    basePrice: 300,
    facility: 'cake_shop',
    shelfLifeTurns: 2,
  },
];

// Tier-0 "extraction recipes": no inputs, unlocked by research/discovery,
// same convention as the Brewery scenario.
const extractionRecipes: Recipe[] = [
  { id: 'recipe_extract_wheat', output: 'wheat', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_sugarcane', output: 'sugarcane', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_egg', output: 'egg', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_milk', output: 'milk', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_cocoa', output: 'cocoa', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
  { id: 'recipe_extract_strawberry', output: 'strawberry', outputQty: 1, facility: 'farm', inputs: [], published: false, communityLevel: 0 },
];

const recipes: Recipe[] = [
  ...extractionRecipes,
  {
    id: 'recipe_flour',
    output: 'flour',
    outputQty: 1,
    facility: 'mill',
    inputs: [{ ingredientId: 'wheat', qty: 2 }],
    published: true,
    communityLevel: 0,
  },
  {
    id: 'recipe_sugar',
    output: 'sugar',
    outputQty: 1,
    facility: 'sugar_mill',
    inputs: [{ ingredientId: 'sugarcane', qty: 2 }],
    published: true,
    communityLevel: 0,
  },
  {
    id: 'recipe_butter',
    output: 'butter',
    outputQty: 1,
    facility: 'dairy',
    inputs: [{ ingredientId: 'milk', qty: 2 }],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_cream',
    output: 'cream',
    outputQty: 1,
    facility: 'dairy',
    inputs: [{ ingredientId: 'milk', qty: 1 }],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_chocolate',
    output: 'chocolate',
    outputQty: 1,
    facility: 'chocolate_factory',
    inputs: [
      { ingredientId: 'cocoa', qty: 2 },
      { ingredientId: 'sugar', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_sponge_base',
    output: 'sponge_base',
    outputQty: 1,
    facility: 'bakery_kitchen',
    inputs: [
      { ingredientId: 'flour', qty: 2 },
      { ingredientId: 'egg', qty: 2 },
      { ingredientId: 'sugar', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_frosting',
    output: 'frosting',
    outputQty: 1,
    facility: 'bakery_kitchen',
    inputs: [
      { ingredientId: 'butter', qty: 1 },
      { ingredientId: 'sugar', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_butter_cake',
    output: 'butter_cake',
    outputQty: 1,
    facility: 'cake_shop',
    inputs: [
      { ingredientId: 'sponge_base', qty: 1 },
      { ingredientId: 'frosting', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_chocolate_cake',
    output: 'chocolate_cake',
    outputQty: 1,
    facility: 'cake_shop',
    inputs: [
      { ingredientId: 'sponge_base', qty: 1 },
      { ingredientId: 'chocolate', qty: 1 },
      { ingredientId: 'frosting', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_strawberry_cream_cake',
    output: 'strawberry_cream_cake',
    outputQty: 1,
    facility: 'cake_shop',
    inputs: [
      { ingredientId: 'sponge_base', qty: 1 },
      { ingredientId: 'cream', qty: 1 },
      { ingredientId: 'strawberry', qty: 2 },
    ],
    published: false,
    communityLevel: 0,
  },
  {
    id: 'recipe_wedding_cake',
    output: 'wedding_cake',
    outputQty: 1,
    facility: 'cake_shop',
    inputs: [
      { ingredientId: 'sponge_base', qty: 3 },
      { ingredientId: 'frosting', qty: 2 },
      { ingredientId: 'strawberry', qty: 1 },
    ],
    published: false,
    communityLevel: 0,
  },
];

const licenses: LicenseDef[] = [
  { resourceId: 'wheat', class: 'open', upfrontCost: 30, renewalCost: 5, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'sugarcane', class: 'open', upfrontCost: 30, renewalCost: 5, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'egg', class: 'open', upfrontCost: 35, renewalCost: 6, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'milk', class: 'open', upfrontCost: 35, renewalCost: 6, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'cocoa', class: 'open', upfrontCost: 45, renewalCost: 8, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'strawberry', class: 'open', upfrontCost: 40, renewalCost: 7, renewalPeriod: 5, minReputation: 0 },

  { resourceId: 'flour', class: 'closed', upfrontCost: 150, renewalCost: 20, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'sugar', class: 'closed', upfrontCost: 150, renewalCost: 20, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'butter', class: 'closed', upfrontCost: 180, renewalCost: 25, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'cream', class: 'closed', upfrontCost: 160, renewalCost: 22, renewalPeriod: 5, minReputation: 0 },
  { resourceId: 'chocolate', class: 'closed', upfrontCost: 220, renewalCost: 30, renewalPeriod: 5, minReputation: 5 },

  { resourceId: 'sponge_base', class: 'closed', upfrontCost: 300, renewalCost: 40, renewalPeriod: 5, minReputation: 10 },
  { resourceId: 'frosting', class: 'closed', upfrontCost: 250, renewalCost: 35, renewalPeriod: 5, minReputation: 10 },

  { resourceId: 'butter_cake', class: 'closed', upfrontCost: 500, renewalCost: 60, renewalPeriod: 5, minReputation: 15 },
  { resourceId: 'chocolate_cake', class: 'closed', upfrontCost: 600, renewalCost: 70, renewalPeriod: 5, minReputation: 15 },
  { resourceId: 'strawberry_cream_cake', class: 'closed', upfrontCost: 550, renewalCost: 65, renewalPeriod: 5, minReputation: 15 },
  { resourceId: 'wedding_cake', class: 'closed', upfrontCost: 900, renewalCost: 100, renewalPeriod: 5, minReputation: 40 },
];

const facilityTypes: FacilityTypeDef[] = [
  { type: 'farm', buildCost: 200, buildTurns: 2, baseCapacity: 20, upkeepPerTurn: 4, workersForFullCapacity: 2, standardWage: 6 },
  { type: 'mill', buildCost: 300, buildTurns: 2, baseCapacity: 15, upkeepPerTurn: 5, workersForFullCapacity: 2, standardWage: 7 },
  { type: 'sugar_mill', buildCost: 300, buildTurns: 2, baseCapacity: 15, upkeepPerTurn: 5, workersForFullCapacity: 2, standardWage: 7 },
  { type: 'dairy', buildCost: 350, buildTurns: 2, baseCapacity: 15, upkeepPerTurn: 6, workersForFullCapacity: 2, standardWage: 8 },
  { type: 'chocolate_factory', buildCost: 400, buildTurns: 3, baseCapacity: 12, upkeepPerTurn: 7, workersForFullCapacity: 2, standardWage: 9 },
  { type: 'bakery_kitchen', buildCost: 450, buildTurns: 3, baseCapacity: 12, upkeepPerTurn: 8, workersForFullCapacity: 3, standardWage: 10 },
  { type: 'cake_shop', buildCost: 600, buildTurns: 3, baseCapacity: 10, upkeepPerTurn: 10, workersForFullCapacity: 3, standardWage: 12 },
];

export const bakeryScenario: ScenarioConfig = {
  id: 'bakery',
  name: 'Bakery',
  resources,
  recipes,
  licenses,
  facilityTypes,
  startingCash: 600,
  startingFacility: { type: 'farm' },
  startingLicenseResourceId: ['wheat'],
  startingKnownRecipeIds: ['recipe_extract_wheat'],
  researchCost: 40,
};
