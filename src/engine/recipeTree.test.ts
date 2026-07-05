import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/brewery/config';
import { buildRecipeTree } from './recipeTree';
import type { MarketEntry } from './types';

function marketFromBase(): Record<string, MarketEntry> {
  const m: Record<string, MarketEntry> = {};
  for (const r of breweryScenario.resources) m[r.id] = { price: r.basePrice, supply: 100, demand: 100 };
  return m;
}

describe('buildRecipeTree', () => {
  it('treats a tier-0 resource as a childless raw leaf', () => {
    const tree = buildRecipeTree('barley', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), new Set());
    expect(tree.root.children).toHaveLength(0);
    expect(tree.root.tier).toBe(0);
  });

  it('expands a multi-tier product recursively down to raw materials', () => {
    const tree = buildRecipeTree('bottled_beer', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), new Set());
    // bottled_beer = 1 keg_beer + 6 glass_bottle
    const childIds = tree.root.children.map((c) => c.resourceId).sort();
    expect(childIds).toEqual(['glass_bottle', 'keg_beer']);
    const glass = tree.root.children.find((c) => c.resourceId === 'glass_bottle')!;
    expect(glass.qty).toBe(6);
    // glass_bottle = 2 silica_sand → so 6 bottles need 12 silica
    const silica = glass.children.find((c) => c.resourceId === 'silica_sand')!;
    expect(silica.qty).toBe(12);
  });

  it('propagates quantities multiplicatively through the tree', () => {
    const tree = buildRecipeTree('bottled_beer', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), new Set());
    const keg = tree.root.children.find((c) => c.resourceId === 'keg_beer')!;
    // keg_beer = 3 malt + 1 hops + 1 yeast; 1 keg needed → 3 malt; malt = 2 barley → 6 barley
    const malt = keg.children.find((c) => c.resourceId === 'malt')!;
    expect(malt.qty).toBe(3);
    const barley = malt.children.find((c) => c.resourceId === 'barley')!;
    expect(barley.qty).toBe(6);
  });

  it('marks recipes as known only when in the knownRecipeIds set', () => {
    const known = new Set(['recipe_bottled_beer']);
    const tree = buildRecipeTree('bottled_beer', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), known);
    expect(tree.root.known).toBe(true);
    const keg = tree.root.children.find((c) => c.resourceId === 'keg_beer')!;
    expect(keg.known).toBe(false); // recipe_keg_beer not in the known set
  });

  it('computes raw material cost from leaf market prices when the tree is fully known', () => {
    // recipe_malt is the malt recipe; knowing it lets the cost recurse to barley.
    const known = new Set(['recipe_malt']);
    const tree = buildRecipeTree('malt', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), known);
    // malt = 2 barley @ base 4 = 8
    expect(tree.rawMaterialCost).toBe(8);
    expect(tree.buyDirectPrice).toBe(12); // malt base price
    expect(tree.hasUndiscovered).toBe(false);
  });

  it('flags undiscovered nodes and costs them at market instead of recursing', () => {
    // Nothing known: bottled_beer root is expanded for costing, but keg_beer and
    // glass_bottle are undiscovered → priced at market, not broken down.
    const tree = buildRecipeTree('bottled_beer', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), new Set());
    expect(tree.hasUndiscovered).toBe(true);
    // 1 keg_beer @ 75 + 6 glass_bottle @ 9 = 75 + 54 = 129
    expect(tree.rawMaterialCost).toBe(129);
  });

  it('recurses through a known intermediate but stops at an undiscovered one', () => {
    // Know bottled_beer + glass_bottle, but NOT keg_beer.
    const known = new Set(['recipe_bottled_beer', 'recipe_glass_bottle']);
    const tree = buildRecipeTree('bottled_beer', breweryScenario.resources, breweryScenario.recipes, marketFromBase(), known);
    // glass_bottle breaks down to silica (6 bottles → 12 silica @ 3 = 36);
    // keg_beer stays a market buy (1 @ 75). Total 75 + 36 = 111.
    expect(tree.rawMaterialCost).toBe(111);
    expect(tree.hasUndiscovered).toBe(true);
  });
});
