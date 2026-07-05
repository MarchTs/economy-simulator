import type { MarketEntry, Recipe, Resource, ResourceId } from './types';

export interface RecipeTreeNode {
  resourceId: ResourceId;
  name: string;
  tier: number;
  qty: number; // quantity of THIS node needed to make one unit of the root
  facility: string;
  recipeId?: string; // the recipe used to expand this node (undefined for raw tier-0)
  known: boolean; // is the recipe known to the player? (raw materials are always "known")
  marketPrice: number;
  children: RecipeTreeNode[];
  cyclic?: boolean; // guard flag if a cycle was detected
}

export interface RecipeTreeResult {
  root: RecipeTreeNode;
  rawMaterialCost: number; // cost to make the root, buying raw leaves + undiscovered intermediates at market
  buyDirectPrice: number; // market price of the root itself
  hasUndiscovered: boolean; // true if any node in the tree has an undiscovered recipe
}

interface BuildCtx {
  resources: Map<ResourceId, Resource>;
  recipesByOutput: Map<ResourceId, Recipe[]>;
  market: Record<ResourceId, MarketEntry>;
  knownRecipeIds: Set<string>;
}

function buildNode(
  resourceId: ResourceId,
  qty: number,
  ctx: BuildCtx,
  visited: Set<ResourceId>
): RecipeTreeNode {
  const resource = ctx.resources.get(resourceId);
  const name = resource?.name ?? resourceId;
  const tier = resource?.tier ?? 0;
  const marketPrice = ctx.market[resourceId]?.price ?? resource?.basePrice ?? 0;
  const recipes = ctx.recipesByOutput.get(resourceId) ?? [];
  const recipe = recipes[0]; // first recipe is the canonical one for the tree view

  // Leaf: no recipe (raw material) or a cycle would form.
  if (!recipe) {
    return {
      resourceId,
      name,
      tier,
      qty,
      facility: resource?.facility ?? '',
      known: true,
      marketPrice,
      children: [],
    };
  }
  if (visited.has(resourceId)) {
    return {
      resourceId,
      name,
      tier,
      qty,
      facility: recipe.facility,
      recipeId: recipe.id,
      known: ctx.knownRecipeIds.has(recipe.id),
      marketPrice,
      children: [],
      cyclic: true,
    };
  }

  const nextVisited = new Set(visited);
  nextVisited.add(resourceId);
  const children = recipe.inputs.map((input) =>
    buildNode(input.ingredientId, input.qty * qty, ctx, nextVisited)
  );

  return {
    resourceId,
    name,
    tier,
    qty,
    facility: recipe.facility,
    recipeId: recipe.id,
    known: ctx.knownRecipeIds.has(recipe.id),
    marketPrice,
    children,
  };
}

// Cost to make the root: recurse into KNOWN recipes down to raw leaves, but stop
// at undiscovered intermediates and price them at market (you'd have to buy them,
// not make them). This also avoids leaking hidden recipe internals into the cost.
function sumRawCost(node: RecipeTreeNode, isRoot: boolean): number {
  const expandable = node.children.length > 0;
  // An undiscovered intermediate is treated as bought at market (a cost leaf).
  // The root itself is always "expanded" for costing — that's the whole point.
  if (!expandable || (!node.known && !isRoot)) {
    return node.marketPrice * node.qty;
  }
  return node.children.reduce((sum, c) => sum + sumRawCost(c, false), 0);
}

function anyUndiscovered(node: RecipeTreeNode): boolean {
  if (node.children.length > 0 && !node.known) return true;
  return node.children.some(anyUndiscovered);
}

export function buildRecipeTree(
  resourceId: ResourceId,
  resources: Resource[],
  recipes: Recipe[],
  market: Record<ResourceId, MarketEntry>,
  knownRecipeIds: Set<string>
): RecipeTreeResult {
  const ctx: BuildCtx = {
    resources: new Map(resources.map((r) => [r.id, r])),
    recipesByOutput: new Map(),
    market,
    knownRecipeIds,
  };
  for (const recipe of recipes) {
    const list = ctx.recipesByOutput.get(recipe.output) ?? [];
    list.push(recipe);
    ctx.recipesByOutput.set(recipe.output, list);
  }

  const root = buildNode(resourceId, 1, ctx, new Set());
  return {
    root,
    rawMaterialCost: sumRawCost(root, true),
    buyDirectPrice: market[resourceId]?.price ?? ctx.resources.get(resourceId)?.basePrice ?? 0,
    hasUndiscovered: anyUndiscovered(root),
  };
}
