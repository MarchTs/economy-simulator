import type { LicenseDef, Recipe, Resource } from '../engine/types';

export interface FacilityTypeDef {
  type: string;
  buildCost: number;
  buildTurns: number;
  baseCapacity: number;
  upkeepPerTurn: number;
  workersForFullCapacity: number;
  standardWage: number;
}

export interface ScenarioConfig {
  id: string;
  name: string;
  resources: Resource[];
  recipes: Recipe[];
  licenses: LicenseDef[];
  facilityTypes: FacilityTypeDef[];
  startingCash: number;
  startingFacility: { type: string };
  startingLicenseResourceId: ResourceIdChoice;
  startingKnownRecipeIds: string[];
}

// The scenario offers a small set of valid starting licenses (tier 0 goods);
// the player picks one at run start.
export type ResourceIdChoice = string[];
