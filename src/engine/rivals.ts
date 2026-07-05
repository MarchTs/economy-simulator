import type { RivalCompany } from './types';

// Each rival re-prices once per turn based on personality and its own unit cost.
export function repriceRival(rival: RivalCompany, resourceId: string, marketPrice: number): number {
  const cost = rival.unitCost[resourceId] ?? marketPrice * 0.7;
  switch (rival.personality) {
    case 'aggressive':
      return Math.max(cost * 1.02, marketPrice * 0.95);
    case 'premium':
      return marketPrice * 1.08;
    case 'follower':
    default:
      return marketPrice;
  }
}
