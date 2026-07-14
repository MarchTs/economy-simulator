import type { ScenarioConfig } from '../engine/sim';

// Owe & Grow scenarios. Each keeps a clean 4-tier flagship chain the player
// builds up (one buildable facility per tier), plus a couple of side inputs
// that are cheapest to buy at market but could be produced too — the
// vertical-integration lesson. Rates are per-second; facilities scale rate and
// upkeep with level. No licenses, no quotas.

export const breweryScenario: ScenarioConfig = {
  id: 'brewery',
  name: 'Brewery',
  blurb: 'Barley to bottled beer. Grow grain, malt it, brew it, bottle it.',
  products: [
    { id: 'barley', name: 'Barley', tier: 0, facility: 'farm', basePrice: 4, inputs: [] },
    { id: 'hops', name: 'Hops', tier: 1, facility: 'hop_yard', basePrice: 12, inputs: [] },
    { id: 'glass_bottle', name: 'Glass Bottle', tier: 1, facility: 'glassworks', basePrice: 6, inputs: [] },
    { id: 'malt', name: 'Malt', tier: 1, facility: 'malthouse', basePrice: 14, inputs: [{ id: 'barley', qty: 2 }] },
    { id: 'keg_beer', name: 'Keg Beer', tier: 2, facility: 'brewery', basePrice: 90, inputs: [{ id: 'malt', qty: 3 }, { id: 'hops', qty: 1 }] },
    { id: 'bottled_beer', name: 'Bottled Beer', tier: 3, facility: 'packaging_plant', basePrice: 260, inputs: [{ id: 'keg_beer', qty: 1 }, { id: 'glass_bottle', qty: 4 }] },
  ],
  facilityTypes: [
    { type: 'farm', name: 'Barley Farm', productId: 'barley', buildCost: 300, baseRatePerSec: 1.2, upkeepPerCycle: 6 },
    { type: 'hop_yard', name: 'Hop Yard', productId: 'hops', buildCost: 500, baseRatePerSec: 0.6, upkeepPerCycle: 8 },
    { type: 'glassworks', name: 'Glassworks', productId: 'glass_bottle', buildCost: 500, baseRatePerSec: 1.5, upkeepPerCycle: 8 },
    { type: 'malthouse', name: 'Malthouse', productId: 'malt', buildCost: 900, baseRatePerSec: 0.7, upkeepPerCycle: 14 },
    { type: 'brewery', name: 'Brewery', productId: 'keg_beer', buildCost: 2600, baseRatePerSec: 0.25, upkeepPerCycle: 34 },
    { type: 'packaging_plant', name: 'Packaging Plant', productId: 'bottled_beer', buildCost: 6000, baseRatePerSec: 0.2, upkeepPerCycle: 60 },
  ],
  startingFacilityType: 'farm',
};

export const bakeryScenario: ScenarioConfig = {
  id: 'bakery',
  name: 'Bakery',
  blurb: 'Wheat to wedding cakes. Mill flour, whip a sponge, ice the cake.',
  products: [
    { id: 'wheat', name: 'Wheat', tier: 0, facility: 'wheat_farm', basePrice: 3, inputs: [] },
    { id: 'egg', name: 'Egg', tier: 1, facility: 'henhouse', basePrice: 5, inputs: [] },
    { id: 'sugar', name: 'Sugar', tier: 1, facility: 'sugar_mill', basePrice: 4, inputs: [] },
    { id: 'flour', name: 'Flour', tier: 1, facility: 'mill', basePrice: 10, inputs: [{ id: 'wheat', qty: 2 }] },
    { id: 'sponge_base', name: 'Sponge Base', tier: 2, facility: 'kitchen', basePrice: 70, inputs: [{ id: 'flour', qty: 2 }, { id: 'egg', qty: 2 }] },
    { id: 'butter_cake', name: 'Butter Cake', tier: 3, facility: 'cake_shop', basePrice: 240, inputs: [{ id: 'sponge_base', qty: 1 }, { id: 'sugar', qty: 3 }] },
  ],
  facilityTypes: [
    { type: 'wheat_farm', name: 'Wheat Farm', productId: 'wheat', buildCost: 250, baseRatePerSec: 1.4, upkeepPerCycle: 5 },
    { type: 'henhouse', name: 'Henhouse', productId: 'egg', buildCost: 450, baseRatePerSec: 0.8, upkeepPerCycle: 7 },
    { type: 'sugar_mill', name: 'Sugar Mill', productId: 'sugar', buildCost: 450, baseRatePerSec: 1.4, upkeepPerCycle: 7 },
    { type: 'mill', name: 'Flour Mill', productId: 'flour', buildCost: 800, baseRatePerSec: 0.8, upkeepPerCycle: 12 },
    { type: 'kitchen', name: 'Bakery Kitchen', productId: 'sponge_base', buildCost: 2400, baseRatePerSec: 0.3, upkeepPerCycle: 30 },
    { type: 'cake_shop', name: 'Cake Shop', productId: 'butter_cake', buildCost: 5500, baseRatePerSec: 0.22, upkeepPerCycle: 55 },
  ],
  startingFacilityType: 'wheat_farm',
};

export const SCENARIOS: ScenarioConfig[] = [breweryScenario, bakeryScenario];
