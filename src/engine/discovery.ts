import type { GameState, ResourceId } from './types';

// A resource counts as "discovered" if the player knows a recipe that makes
// it (including tier-0 extraction), it's an ingredient of a recipe they know,
// they're already holding some, or they hold a license for it. Shared by the
// Market table's visibility filter and contract-board generation so neither
// can drift out of sync with the other — contracts should never reference a
// resource the player wouldn't even see in their own market list.
export function makeDiscoveryChecker(state: GameState): (resourceId: ResourceId) => boolean {
  const known = state.player.knowledge.knownRecipeIds;
  const knownOutputs = new Set<ResourceId>();
  const ingredientsOfKnown = new Set<ResourceId>();
  for (const rec of state.recipes) {
    if (!known.has(rec.id)) continue;
    knownOutputs.add(rec.output);
    for (const inp of rec.inputs) ingredientsOfKnown.add(inp.ingredientId);
  }
  const heldIds = new Set(
    Object.keys(state.player.inventory).filter((id) => (state.player.inventory[id]?.qty ?? 0) > 0)
  );
  const licensedIds = new Set(state.player.licenses.map((l) => l.resourceId));

  return (resourceId: ResourceId) =>
    knownOutputs.has(resourceId) ||
    ingredientsOfKnown.has(resourceId) ||
    heldIds.has(resourceId) ||
    licensedIds.has(resourceId);
}
