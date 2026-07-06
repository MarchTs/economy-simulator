// Core engine types. Scope: CORE tier minus multi-country, banking, IPO, inflation.
// See license-economy-game-design.md for the full doc these are derived from.

export type ResourceId = string;
export type CompanyId = string;
export type FacilityId = string;

export type Tier = 0 | 1 | 2 | 3;

export interface Resource {
  id: ResourceId;
  name: string;
  tier: Tier;
  basePrice: number;
  facility: string; // facility type required to produce this, e.g. 'farm' | 'brewery'
  shelfLifeTurns?: number; // undefined = doesn't spoil
}

export interface RecipeIngredient {
  ingredientId: ResourceId;
  qty: number;
}

export interface Recipe {
  id: string;
  output: ResourceId;
  outputQty: number;
  facility: string;
  inputs: RecipeIngredient[];
  firstDiscoveredTurn?: number; // starts the public-domain clock
  published: boolean;
  communityLevel: number;
  exclusiveTurnsLeft?: number; // counts down after "stay exclusive"; hits 0 → auto-published
}

// Raised right after a discovery: the discoverer decides whether the recipe
// goes public for free, stays exclusive on a timer, or is sold privately to
// one rival. Resolved via the 'resolveDisclosure' command; queued (not a
// single optional field) so a second discovery can't silently clobber a
// still-unresolved one.
export interface PendingDisclosure {
  recipeId: string;
}

// Per-company knowledge of recipes — knowledge is non-exclusive.
export interface CompanyKnowledge {
  knownRecipeIds: Set<string>;
  // A commission is either blind (find any newly-eligible recipe) or
  // ingredient-directed (find a recipe of the target tier made from the
  // chosen ingredients).
  activeCommission?: { ingredients?: ResourceId[]; blind?: boolean; turnsLeft: number; targetTier?: number };
  labLevel: number; // raises tinkering success chance
}

export type LicenseClass = 'open' | 'closed';

export interface LicenseDef {
  resourceId: ResourceId;
  class: LicenseClass;
  upfrontCost: number;
  renewalCost: number;
  renewalPeriod: number; // turns
  minReputation: number;
  quotaPerPeriod?: number; // units required per quotaPeriodTurns, undefined = no quota
  quotaPeriodTurns?: number;
}

export interface HeldLicense {
  resourceId: ResourceId;
  status: 'active' | 'suspended' | 'lapsed';
  suspendedTurnsLeft?: number;
  turnsUntilRenewal: number;
  unitsProducedThisPeriod: number;
  // Independent from turnsUntilRenewal — a quota-gated license's production
  // window (LicenseDef.quotaPeriodTurns) is its own cadence, not tied to the
  // renewal fee cycle. Undefined for licenses with no quota.
  turnsUntilQuotaCheck?: number;
}

export interface Facility {
  id: FacilityId;
  type: string; // 'farm' | 'malthouse' | 'brewery' | 'lab' | ...
  assignedResourceId: ResourceId; // which resource this instance is dedicated to producing
  capacityPerTurn: number; // base (level 1) capacity; effectiveCapacity() applies the level bonus
  level: number; // starts at 1; raised by leveling up
  levelUpTurnsLeft?: number; // set while upgrading; facility keeps running at its CURRENT level meanwhile
  buildTurnsLeft: number; // 0 = operational
  upkeepPerTurn: number;
  requiredWorkers: number;
  hiredWorkers: number;
  wageRatio: 1.0 | 1.2;
  condition: number; // 100 = perfect, degrades if unmaintained (higher level = slower degrade)
  maintenanceFunded: boolean;
  capacityUsedThisTick: number; // resets each tick; caps real-time production
  upkeepPrepaid: boolean; // true if this turn's upkeep+payroll was already paid early; runUpkeep skips the charge and resets it
}

export interface InventoryEntry {
  qty: number;
  ageTurns: number; // for perishable goods, tracked as a batch age (simplified: oldest-batch age)
}

export interface QuestContract {
  id: string;
  issuer: string;
  resourceId: ResourceId;
  qty: number;
  deadlineTurnsLeft: number;
  payout: number;
  reputationReward: number;
  penalty: number;
  lawsuitOnBreach: boolean;
  deliveredQty: number;
  boardTurnsLeft?: number; // set while sitting unaccepted on the contract board; cleared on accept
}

export interface SupplyContract {
  id: string;
  side: 'sell' | 'buy'; // from the player's perspective
  counterparty: string;
  resourceId: ResourceId;
  qtyPerTurn: number;
  price: number;
  turnsLeft: number;
  cancelFine: number;
  missedStreak: number;
  settledThisTurn: boolean; // true if sent/bought early via sendSupplyContractNow; runSupplyContracts skips it and resets the flag
}

// A board offer for a recurring "sell N/minute for T minutes" deal — the
// "long quest" per §3.7 Type 2. Accepting one creates a SupplyContract (sell
// side) so it settles via the same recurring auto-settle/breach logic.
export interface StandingOfferContract {
  id: string;
  issuer: string;
  resourceId: ResourceId;
  qtyPerTurn: number;
  price: number;
  turnsLeft: number; // contract duration once accepted
  boardTurnsLeft: number; // turns left before the unaccepted offer expires
}

export type EventKind = 'disaster' | 'lawsuit';

// Data-only (no embedded functions) so GameState stays JSON-serializable for save/load.
export type EffectPayload =
  | { type: 'productionHalt' }
  | { type: 'costMultiplier'; multiplier: number }
  | { type: 'supplyShift'; resourceId: ResourceId; multiplier: number }
  | { type: 'outputCut'; multiplier: number };

export interface ActiveEffect {
  id: string;
  kind: EventKind;
  label: string;
  turnsLeft: number;
  effect: EffectPayload;
}

export interface PendingLawsuit {
  eventId: string;
  label: string;
  settleCost: number;
  fightWinChance: number; // 0..1, modified by legal team
  fightLoseCost: number;
  reputationLossIfLose: number;
}

export type RivalPersonality = 'aggressive' | 'premium' | 'follower';

export interface RivalCompany {
  id: CompanyId;
  name: string;
  personality: RivalPersonality;
  cash: number;
  reputation: number;
  licenses: HeldLicense[];
  licenseSlots: number;
  knownRecipeIds: Set<string>;
  postedPrices: Record<ResourceId, number>;
  unitCost: Record<ResourceId, number>;
  cumulativeLoss: Record<ResourceId, number>;
}

export interface MarketEntry {
  price: number;
  supply: number;
  demand: number;
  priceHistory: number[]; // one entry per turn (oldest first), capped — feeds the per-resource price chart
}

export interface CompanyState {
  cash: number;
  reputation: number;
  inventory: Record<ResourceId, InventoryEntry>;
  licenses: HeldLicense[];
  licenseSlots: number;
  facilities: Facility[];
  knowledge: CompanyKnowledge;
  autoProduce: ResourceId[]; // outputs set to auto-produce each tick (real-time)
  questContracts: QuestContract[];
  supplyContracts: SupplyContract[];
  loans: Loan[];
  defenses: { insurance: boolean; legalTeam: boolean; safetyLevel: number };
  goldHeld: number; // units of Gold owned — a speculative asset, not part of any recipe chain
}

// Banking, per doc §6.9 "reduced to a single loan action" for the run format:
// one loan product (unsecured, flat rate), no fixed/floating/secured choice.
export interface Loan {
  id: string;
  principal: number;
  remaining: number; // principal + interest still owed
  paymentPerTurn: number;
  termTurnsLeft: number; // informational — payments continue past 0 if behind
  missedPayments: number;
}

export interface LedgerEntry {
  turn: number;
  label: string;
  delta: number;
  cashAfter: number;
}

export interface GameState {
  turn: number;
  player: CompanyState;
  rivals: RivalCompany[];
  recipes: Recipe[];
  market: Record<ResourceId, MarketEntry>;
  activeEffects: ActiveEffect[];
  ledger: LedgerEntry[];
  pendingLawsuit?: PendingLawsuit;
  pendingDisclosures: PendingDisclosure[]; // FIFO queue of unresolved discovery choices
  contractBoard: QuestContract[]; // seeded one-shot quest offers, not yet accepted (§3.7)
  standingOfferBoard: StandingOfferContract[]; // seeded recurring "long quest" offers, not yet accepted
  rngState: number; // mulberry32 seed/state
  gameOver?: { result: 'bankrupt' | 'won' | 'ipo'; turn: number };
  goldPrice: number; // current price per unit of Gold — universal across scenarios, not tied to any resource/recipe
  goldPriceHistory: number[]; // one entry per turn (oldest first), capped — feeds the price chart
}

// Player-submitted actions for a single turn, applied in the PLAYER step.
export interface PlayerActions {
  buy: { resourceId: ResourceId; qty: number }[];
  sell: { resourceId: ResourceId; qty: number }[];
  produce: { resourceId: ResourceId; qty: number; recipeId?: string }[];
  buyLicense?: ResourceId;
  dropLicense?: ResourceId;
  researchByIngredients?: ResourceId[];
  researchBlind?: boolean;
  tinker?: { inputs: RecipeIngredient[]; facility: string };
  hireFire?: { facilityId: FacilityId; targetWorkers: number };
  buildFacility?: { type: string };
  fundMaintenance?: { facilityId: FacilityId; funded: boolean };
  toggleInsurance?: boolean;
  toggleLegalTeam?: boolean;
  acceptQuestContract?: string;
  proposeSupplyContract?: {
    side: 'sell' | 'buy';
    resourceId: ResourceId;
    qtyPerTurn: number;
    price: number;
    turnsLeft: number;
  };
  cancelSupplyContract?: string;
  lawsuitDecision?: 'settle' | 'fight';
}
