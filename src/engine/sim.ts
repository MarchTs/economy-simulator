// Owe & Grow — real-time educational tycoon engine.
// Two clocks: production accumulates every game-SECOND; obligations (contract
// deliveries, loan installments, tax) settle every SETTLE_INTERVAL_SEC seconds.
// Pure functions over a JSON-serializable GameState (for save/load + offline sim).
// Reuses the mulberry32 RNG from ./rng.
import { nextRandom, randomRange } from './rng';

// ---------------------------------------------------------------------------
// Scenario data shapes
// ---------------------------------------------------------------------------

export interface ProductDef {
  id: string;
  name: string;
  tier: number; // 0 raw → 3 finished
  facility: string; // facility type that produces it
  basePrice: number; // market anchor
  inputs: { id: string; qty: number }[]; // consumed per unit produced; empty for raw
}

export interface FacilityTypeDef {
  type: string;
  name: string;
  productId: string; // the one product this facility type makes
  buildCost: number;
  baseRatePerSec: number; // output units/second at level 1
  upkeepPerCycle: number; // per settleTick at level 1
}

export interface ScenarioConfig {
  id: string;
  name: string;
  blurb: string;
  products: ProductDef[];
  facilityTypes: FacilityTypeDef[];
  startingFacilityType: string; // the tier-0 facility you begin with
}

// ---------------------------------------------------------------------------
// Runtime state
// ---------------------------------------------------------------------------

export interface Facility {
  id: string;
  type: string;
  productId: string;
  level: number; // scales rate AND upkeep together
  invested: number; // total spent (build + level-ups) — resale is a fraction of this
  accumulator: number; // fractional units produced, not yet flushed to inventory
}

export interface Loan {
  id: string;
  label: string;
  principal: number;
  balance: number; // remaining to repay (principal + interest)
  installmentPerCycle: number;
  cyclesLeft: number;
}

export interface Contract {
  id: string;
  customer: string;
  productId: string;
  qtyPerCycle: number;
  pricePerUnit: number; // locked, above spot
  cyclesLeft: number;
  fromEvent: boolean;
}

// A time-limited contract offer pushed as a live event.
export interface OpportunityOffer {
  id: string;
  customer: string;
  productId: string;
  qtyPerCycle: number;
  pricePerUnit: number;
  durationCycles: number;
  expiresInSec: number;
}

// A duty created each settleTick, resolved by manager or manual click before
// the next settleTick — else it's missed (consequence applied).
export interface Obligation {
  id: string;
  kind: 'delivery' | 'installment' | 'taxPayment';
  refId: string; // contractId | loanId | ''
  label: string;
  amountG: number; // cash for installment/tax; sale value for delivery
  qty: number; // units for delivery; 0 otherwise
  productId: string; // for delivery; '' otherwise
}

export interface Managers {
  shipping: number; // each covers CONTRACTS_PER_MANAGER contracts
  finance: boolean; // auto-pays loan installments
  accountant: boolean; // auto-pays tax
}

export interface MarketEntry {
  price: number;
  history: number[]; // per cycle, capped
}

export interface LedgerEntry {
  cycle: number;
  label: string;
  deltaG: number;
}

export interface RunGoal {
  targetNetWorth: number;
  timeLimitSec: number;
}

export interface GoldState {
  price: number;
  history: number[];
  held: number;
  costBasis: number; // total g spent acquiring current holdings (for speculation P&L)
  realizedPnL: number; // locked-in gains/losses from past sells
  // Bubble dynamics: a run-up phase building toward a collapse.
  phase: 'calm' | 'bubble';
  phaseCyclesLeft: number;
}

export interface RunTotals {
  interestPaidG: number;
  taxPaidG: number;
  salariesPaidG: number;
  upkeepPaidG: number;
}

export interface GameState {
  scenarioId: string;
  clockSec: number; // game-seconds elapsed
  cycle: number; // settleTicks elapsed
  cash: number;
  inventory: Record<string, number>;
  facilities: Facility[];
  loans: Loan[];
  contracts: Contract[];
  opportunities: OpportunityOffer[];
  pendingObligations: Obligation[];
  managers: Managers;
  market: Record<string, MarketEntry>;
  gold: GoldState;
  loanArrears: number;
  taxDebt: number;
  cycleRevenueG: number; // sales income accrued this cycle (for profit tax)
  firstSaleMade: boolean; // gates tier-1 unlock
  ledger: LedgerEntry[];
  totals: RunTotals;
  runGoal: RunGoal | null; // null = sandbox
  rngState: number;
  nextId: number; // monotonic id source (kept in state for determinism)
  outcome: 'won' | 'timeUp' | null;
  wonAtSec: number | null;
}

// ---------------------------------------------------------------------------
// Constants (the balance-pass knobs live here)
// ---------------------------------------------------------------------------

export const SETTLE_INTERVAL_SEC = 30;
export const PROFIT_TAX_RATE = 0.15;
export const PROPERTY_TAX_PER_LEVEL = 4; // g per facility-level per cycle
export const LATE_PENALTY_RATE = 0.1; // per cycle, on arrears / taxDebt
export const FACILITY_RESALE_RATE = 0.7;
export const CONTRACTS_PER_MANAGER = 5;
export const SHIPPING_SALARY = 14;
export const FINANCE_SALARY = 12;
export const ACCOUNTANT_SALARY = 12;
export const CONTRACT_PREMIUM = 1.25; // contract sell price vs spot
export const SPOT_SELL_FACTOR = 1.0; // spot sells at market price
export const HISTORY_CAP = 240;
export const LEVELUP_COST_FACTOR = 0.6; // level-up cost = buildCost * factor * level
// Tapping a facility instantly makes this many seconds' worth of its output.
// Deliberately small: mashing is a real early-game boost, but becomes
// irrelevant once facilities scale — the classic clicker arc.
export const CLICK_BOOST_SECONDS = 3;
export const RUN_TARGET_NET_WORTH = 1_000_000;
export const RUN_TIME_LIMIT_SEC = 3600; // one game-hour

// Gold
export const GOLD_START_PRICE = 100;
const GOLD_CALM_DRIFT = 0.01; // avg per cycle in calm phase
const GOLD_CALM_NOISE = 0.03;
const GOLD_BUBBLE_CHANCE = 0.06; // per cycle chance calm → bubble
const GOLD_BUBBLE_RUNUP = [0.08, 0.16] as const; // per-cycle gain during a bubble
const GOLD_BUBBLE_LEN = [4, 8] as const; // cycles the run-up lasts
const GOLD_CRASH = [0.4, 0.6] as const; // fraction wiped when a bubble pops

// Loan catalog (installments sized so total = principal * (1+rate))
export interface LoanOffer {
  id: string;
  label: string;
  principal: number;
  installmentPerCycle: number;
  termCycles: number;
  totalRepay: number;
}
export const LOAN_OFFERS: LoanOffer[] = [
  { id: 'starter', label: 'Starter', principal: 500, installmentPerCycle: 15, termCycles: 40, totalRepay: 600 },
  { id: 'growth', label: 'Growth', principal: 2000, installmentPerCycle: 55, termCycles: 44, totalRepay: 2420 },
  { id: 'empire', label: 'Empire', principal: 8000, installmentPerCycle: 210, termCycles: 48, totalRepay: 10080 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clone<T>(v: T): T {
  return structuredClone(v);
}

function genId(state: GameState, prefix: string): string {
  const id = `${prefix}_${state.nextId}`;
  state.nextId += 1;
  return id;
}

function pushHistory(arr: number[], v: number) {
  arr.push(v);
  if (arr.length > HISTORY_CAP) arr.shift();
}

function addLedger(state: GameState, label: string, deltaG: number) {
  state.ledger.push({ cycle: state.cycle, label, deltaG });
  if (state.ledger.length > 2000) state.ledger.shift();
}

export function productById(scenario: ScenarioConfig, id: string): ProductDef {
  return scenario.products.find((p) => p.id === id)!;
}

export function facilityTypeDef(scenario: ScenarioConfig, type: string): FacilityTypeDef {
  return scenario.facilityTypes.find((f) => f.type === type)!;
}

export function facilityRatePerSec(f: Facility, scenario: ScenarioConfig): number {
  return facilityTypeDef(scenario, f.type).baseRatePerSec * f.level;
}

export function facilityUpkeep(f: Facility, scenario: ScenarioConfig): number {
  return facilityTypeDef(scenario, f.type).upkeepPerCycle * f.level;
}

export function levelUpCost(f: Facility, scenario: ScenarioConfig): number {
  return Math.round(facilityTypeDef(scenario, f.type).buildCost * LEVELUP_COST_FACTOR * f.level);
}

// Per-unit margin at current market prices: the product's spot price minus the
// spot cost of its inputs. For a raw product (no inputs) that's the full price.
// This is the value a facility adds per unit it makes.
export function unitMargin(state: GameState, scenario: ScenarioConfig, productId: string): number {
  const def = productById(scenario, productId);
  const revenue = state.market[productId].price;
  const inputCost = def.inputs.reduce((s, inp) => s + inp.qty * (state.market[inp.id]?.price ?? 0), 0);
  return revenue - inputCost;
}

// The highest tier the player may build into yet. Tier 0 always; tier N unlocks
// once ANY facility making a tier N-1 product reaches level 2 (per the plan's
// progression table), with the extra rule that tier 1 needs a first sale first.
export function unlockedTier(state: GameState, scenario: ScenarioConfig): number {
  const hasMatureTier = (t: number) =>
    state.facilities.some((f) => productById(scenario, f.productId).tier === t && f.level >= 2);
  let tier = 0;
  if (state.firstSaleMade) tier = 1;
  if (hasMatureTier(1)) tier = Math.max(tier, 2);
  if (hasMatureTier(2)) tier = Math.max(tier, 3);
  return Math.min(3, tier);
}

export function managerSalaryTotal(state: GameState): number {
  return (
    state.managers.shipping * SHIPPING_SALARY +
    (state.managers.finance ? FINANCE_SALARY : 0) +
    (state.managers.accountant ? ACCOUNTANT_SALARY : 0)
  );
}

export function upkeepTotal(state: GameState, scenario: ScenarioConfig): number {
  return state.facilities.reduce((s, f) => s + facilityUpkeep(f, scenario), 0);
}

export function propertyTaxTotal(state: GameState): number {
  return state.facilities.reduce((s, f) => s + PROPERTY_TAX_PER_LEVEL * f.level, 0);
}

export function outstandingDebt(state: GameState): number {
  return state.loans.reduce((s, l) => s + l.balance, 0) + state.loanArrears + state.taxDebt;
}

export function inventoryValue(state: GameState): number {
  return Object.entries(state.inventory).reduce((s, [id, qty]) => {
    const m = state.market[id];
    return s + (m ? m.price * qty : 0);
  }, 0);
}

export function facilityAssetValue(state: GameState): number {
  return state.facilities.reduce((s, f) => s + f.invested * FACILITY_RESALE_RATE, 0);
}

export function goldValue(state: GameState): number {
  return state.gold.held * state.gold.price;
}

export function netWorth(state: GameState): number {
  return Math.round(
    state.cash + inventoryValue(state) + facilityAssetValue(state) + goldValue(state) - outstandingDebt(state)
  );
}

// ---------------------------------------------------------------------------
// New game
// ---------------------------------------------------------------------------

export interface NewGameOpts {
  seed: number;
  sandbox?: boolean;
}

export function newGame(scenario: ScenarioConfig, opts: NewGameOpts): GameState {
  const market: Record<string, MarketEntry> = {};
  for (const p of scenario.products) market[p.id] = { price: p.basePrice, history: [p.basePrice] };

  const startFacDef = facilityTypeDef(scenario, scenario.startingFacilityType);
  const startFacility: Facility = {
    id: 'facility_0',
    type: startFacDef.type,
    productId: startFacDef.productId,
    level: 1,
    invested: startFacDef.buildCost,
    accumulator: 0,
  };

  return {
    scenarioId: scenario.id,
    clockSec: 0,
    cycle: 0,
    cash: 500,
    inventory: {},
    facilities: [startFacility],
    loans: [],
    contracts: [],
    opportunities: [],
    pendingObligations: [],
    managers: { shipping: 0, finance: false, accountant: false },
    market,
    gold: {
      price: GOLD_START_PRICE,
      history: [GOLD_START_PRICE],
      held: 0,
      costBasis: 0,
      realizedPnL: 0,
      phase: 'calm',
      phaseCyclesLeft: 0,
    },
    loanArrears: 0,
    taxDebt: 0,
    cycleRevenueG: 0,
    firstSaleMade: false,
    ledger: [{ cycle: 0, label: 'Opened for business', deltaG: 0 }],
    totals: { interestPaidG: 0, taxPaidG: 0, salariesPaidG: 0, upkeepPaidG: 0 },
    runGoal: opts.sandbox ? null : { targetNetWorth: RUN_TARGET_NET_WORTH, timeLimitSec: RUN_TIME_LIMIT_SEC },
    rngState: opts.seed >>> 0,
    nextId: 1,
    outcome: null,
    wonAtSec: null,
  };
}

// ---------------------------------------------------------------------------
// The per-second clock: production + opportunity expiry + run-goal check
// ---------------------------------------------------------------------------

export function tickSecond(prev: GameState, scenario: ScenarioConfig): GameState {
  const state = clone(prev);
  if (state.outcome) return state;

  state.clockSec += 1;

  // Production: each facility makes rate units this second, consuming inputs.
  for (const f of state.facilities) {
    const rate = facilityRatePerSec(f, scenario);
    f.accumulator += rate;
    const wholeWanted = Math.floor(f.accumulator);
    if (wholeWanted <= 0) continue;
    const made = produceUpTo(state, scenario, f.productId, wholeWanted);
    f.accumulator -= made;
    // If inputs ran out, drop the leftover fractional intent so it doesn't
    // silently bank unlimited production for when inputs return.
    if (made < wholeWanted) f.accumulator = 0;
  }

  // Opportunity offers tick down and expire (penalty-free).
  state.opportunities = state.opportunities.filter((o) => {
    o.expiresInSec -= 1;
    return o.expiresInSec > 0;
  });

  // Occasionally spawn a new opportunity offer.
  maybeSpawnOpportunity(state, scenario);

  // Settlement every SETTLE_INTERVAL_SEC seconds.
  if (state.clockSec % SETTLE_INTERVAL_SEC === 0) settle(state, scenario);

  // Run-goal check.
  if (!state.outcome && state.runGoal) {
    if (netWorth(state) >= state.runGoal.targetNetWorth) {
      state.outcome = 'won';
      state.wonAtSec = state.clockSec;
      addLedger(state, `Reached ${state.runGoal.targetNetWorth.toLocaleString()}g — you win!`, 0);
    } else if (state.clockSec >= state.runGoal.timeLimitSec) {
      state.outcome = 'timeUp';
      addLedger(state, `Time's up at ${netWorth(state).toLocaleString()}g net worth`, 0);
    }
  }

  return state;
}

// Make up to `want` units of productId into inventory, consuming inputs from
// inventory (buying nothing). Returns units actually made.
function produceUpTo(state: GameState, scenario: ScenarioConfig, productId: string, want: number): number {
  const def = productById(scenario, productId);
  if (def.inputs.length === 0) {
    state.inventory[productId] = (state.inventory[productId] ?? 0) + want;
    return want;
  }
  // Bound by each input's availability.
  let canMake = want;
  for (const inp of def.inputs) {
    const have = state.inventory[inp.id] ?? 0;
    canMake = Math.min(canMake, Math.floor(have / inp.qty));
  }
  if (canMake <= 0) return 0;
  for (const inp of def.inputs) state.inventory[inp.id] -= inp.qty * canMake;
  state.inventory[productId] = (state.inventory[productId] ?? 0) + canMake;
  return canMake;
}

function maybeSpawnOpportunity(state: GameState, scenario: ScenarioConfig) {
  // Roughly one offer every ~40s, capped at 3 on screen.
  if (state.opportunities.length >= 3) return;
  const roll = nextRandom(state.rngState);
  state.rngState = roll.nextState;
  if (roll.value > 1 / 40) return;

  // Offer a product the player can actually produce (has a facility for),
  // biased toward higher tiers (juicier).
  const producible = [...new Set(state.facilities.map((f) => f.productId))];
  if (producible.length === 0) return;
  const pick = nextRandom(state.rngState);
  state.rngState = pick.nextState;
  const productId = producible[Math.floor(pick.value * producible.length)];
  const spot = state.market[productId].price;

  const qtyRoll = randomRange(state.rngState, 1.5, 3.0);
  state.rngState = qtyRoll.nextState;
  const priceRoll = randomRange(state.rngState, 1.4, 1.9); // premium above spot, better than a page contract
  state.rngState = priceRoll.nextState;
  const durRoll = randomRange(state.rngState, 8, 20);
  state.rngState = durRoll.nextState;

  const baseQty = Math.max(2, Math.round(estimateOutputPerCycle(state, scenario, productId) * qtyRoll.value));
  const offer: OpportunityOffer = {
    id: genId(state, 'opp'),
    customer: randomCustomer(state),
    productId,
    qtyPerCycle: baseQty,
    pricePerUnit: Math.round(spot * priceRoll.value),
    durationCycles: Math.round(durRoll.value),
    expiresInSec: 90,
  };
  state.opportunities.push(offer);
  addLedger(state, `Opportunity: ${offer.customer} wants ${offer.qtyPerCycle} ${productById(scenario, productId).name}/cycle`, 0);
}

function randomCustomer(state: GameState): string {
  const names = ['Local Co-op', 'Regional Distributor', 'City Market', 'The Corner Shop', 'Grand Hotel', 'Festival Buyer'];
  const r = nextRandom(state.rngState);
  state.rngState = r.nextState;
  return names[Math.floor(r.value * names.length)];
}

export function estimateOutputPerCycle(state: GameState, scenario: ScenarioConfig, productId: string): number {
  return state.facilities
    .filter((f) => f.productId === productId)
    .reduce((s, f) => s + facilityRatePerSec(f, scenario) * SETTLE_INTERVAL_SEC, 0);
}

// ---------------------------------------------------------------------------
// Settlement (every 30 game-seconds)
// ---------------------------------------------------------------------------

function settle(state: GameState, scenario: ScenarioConfig) {
  state.cycle += 1;

  // 1. Penalize obligations left unresolved from last cycle.
  for (const o of state.pendingObligations) {
    if (o.kind === 'delivery') {
      const c = state.contracts.find((x) => x.id === o.refId);
      if (c) {
        state.contracts = state.contracts.filter((x) => x.id !== c.id);
        addLedger(state, `Missed delivery — ${c.customer} walked`, 0);
      }
    } else if (o.kind === 'installment') {
      state.loanArrears += o.amountG;
      addLedger(state, `Missed loan payment → arrears`, 0);
    } else if (o.kind === 'taxPayment') {
      state.taxDebt += o.amountG;
      addLedger(state, `Missed tax → tax debt`, 0);
    }
  }
  state.pendingObligations = [];

  // 2. Automatic recurring costs: manager salaries + facility upkeep.
  const salaries = managerSalaryTotal(state);
  const upkeep = upkeepTotal(state, scenario);
  if (salaries > 0) {
    state.cash -= salaries;
    state.totals.salariesPaidG += salaries;
    addLedger(state, 'Manager salaries', -salaries);
  }
  if (upkeep > 0) {
    state.cash -= upkeep;
    state.totals.upkeepPaidG += upkeep;
    addLedger(state, 'Facility upkeep', -upkeep);
  }

  // 3. Arrears / tax-debt late penalties.
  if (state.loanArrears > 0) state.loanArrears = Math.round(state.loanArrears * (1 + LATE_PENALTY_RATE));
  if (state.taxDebt > 0) state.taxDebt = Math.round(state.taxDebt * (1 + LATE_PENALTY_RATE));

  // 4. Market drift + gold bubble.
  driftMarket(state, scenario);
  advanceGold(state);

  // 5. Assess this cycle's tax (on profit earned during the cycle + property).
  const profit = state.cycleRevenueG - salaries - upkeep;
  const profitTax = Math.max(0, Math.round(profit * PROFIT_TAX_RATE));
  const propertyTax = propertyTaxTotal(state);
  const taxDue = profitTax + propertyTax;
  state.cycleRevenueG = 0;

  // 6. Create this cycle's obligations.
  const obligations: ObligationWork[] = [];
  for (const c of state.contracts) {
    c.cyclesLeft -= 1;
    obligations.push({
      id: genId(state, 'ob'),
      kind: 'delivery',
      refId: c.id,
      label: `Deliver ${c.qtyPerCycle} ${productById(scenario, c.productId).name} to ${c.customer}`,
      amountG: c.qtyPerCycle * c.pricePerUnit,
      qty: c.qtyPerCycle,
      productId: c.productId,
    });
  }
  for (const l of state.loans) {
    if (l.balance <= 0) continue;
    const pay = Math.min(l.installmentPerCycle, l.balance);
    obligations.push({
      id: genId(state, 'ob'),
      kind: 'installment',
      refId: l.id,
      label: `Loan payment — ${l.label}`,
      amountG: pay,
      qty: 0,
      productId: '',
    });
  }
  if (taxDue > 0) {
    obligations.push({
      id: genId(state, 'ob'),
      kind: 'taxPayment',
      refId: '',
      label: `Tax (profit ${profitTax}g + property ${propertyTax}g)`,
      amountG: taxDue,
      qty: 0,
      productId: '',
    });
  }

  // 7. Auto-resolve via managers, in priority order.
  const shippingCapacity = state.managers.shipping * CONTRACTS_PER_MANAGER;
  let deliveriesHandled = 0;
  for (const o of obligations) {
    if (o.kind === 'delivery' && deliveriesHandled < shippingCapacity) {
      if (resolveObligation(state, scenario, o)) {
        o.resolved = true;
        deliveriesHandled += 1;
      }
    } else if (o.kind === 'installment' && state.managers.finance) {
      if (resolveObligation(state, scenario, o)) o.resolved = true;
    } else if (o.kind === 'taxPayment' && state.managers.accountant) {
      if (resolveObligation(state, scenario, o)) o.resolved = true;
    }
  }

  // 8. Remaining obligations wait for manual resolution.
  state.pendingObligations = obligations.filter((o) => !o.resolved).map(stripResolved);

  // Expire finished contracts (after their last delivery was scheduled).
  state.contracts = state.contracts.filter((c) => c.cyclesLeft >= 0);

  // Retire fully-repaid loans.
  state.loans = state.loans.filter((l) => l.balance > 0);
}

// Internal marker while auto-resolving.
type ObligationWork = Obligation & { resolved?: boolean };
function stripResolved(o: ObligationWork): Obligation {
  const { resolved: _r, ...rest } = o;
  return rest;
}

// Resolve one obligation (deduct/deliver). Returns false if it can't be done
// right now (insufficient inventory for a delivery, insufficient cash for a
// payment) — caller leaves it pending.
function resolveObligation(state: GameState, scenario: ScenarioConfig, o: Obligation): boolean {
  if (o.kind === 'delivery') {
    const have = state.inventory[o.productId] ?? 0;
    if (have < o.qty) return false;
    state.inventory[o.productId] -= o.qty;
    state.cash += o.amountG;
    state.cycleRevenueG += o.amountG;
    markFirstSale(state);
    addLedger(state, `Delivered ${o.qty} ${productById(scenario, o.productId).name}`, o.amountG);
    return true;
  }
  if (o.kind === 'installment') {
    if (state.cash < o.amountG) return false;
    const loan = state.loans.find((l) => l.id === o.refId);
    if (!loan) return true; // loan gone; nothing owed
    state.cash -= o.amountG;
    loan.balance = Math.max(0, loan.balance - o.amountG);
    loan.cyclesLeft = Math.max(0, loan.cyclesLeft - 1);
    const interestPortion = Math.round(o.amountG * (1 - loan.principal / (loan.principal + interestOf(loan))));
    state.totals.interestPaidG += Math.max(0, interestPortion);
    addLedger(state, `Loan payment — ${loan.label}`, -o.amountG);
    return true;
  }
  // taxPayment
  if (state.cash < o.amountG) return false;
  state.cash -= o.amountG;
  state.totals.taxPaidG += o.amountG;
  addLedger(state, `Paid tax`, -o.amountG);
  return true;
}

function interestOf(loan: Loan): number {
  const offer = LOAN_OFFERS.find((o) => o.label === loan.label);
  return offer ? offer.totalRepay - offer.principal : Math.round(loan.principal * 0.2);
}

function markFirstSale(state: GameState) {
  if (!state.firstSaleMade) {
    state.firstSaleMade = true;
    addLedger(state, 'First sale — new products unlocked', 0);
  }
}

function driftMarket(state: GameState, scenario: ScenarioConfig) {
  for (const p of scenario.products) {
    const m = state.market[p.id];
    const r = randomRange(state.rngState, -0.04, 0.04);
    state.rngState = r.nextState;
    let price = m.price * (1 + r.value);
    price = Math.max(p.basePrice * 0.4, Math.min(p.basePrice * 3, price));
    m.price = Math.round(price * 100) / 100;
    pushHistory(m.history, m.price);
  }
}

function advanceGold(state: GameState) {
  const g = state.gold;
  if (g.phase === 'calm') {
    const drift = randomRange(state.rngState, GOLD_CALM_DRIFT - GOLD_CALM_NOISE, GOLD_CALM_DRIFT + GOLD_CALM_NOISE);
    state.rngState = drift.nextState;
    g.price = Math.max(10, g.price * (1 + drift.value));
    const roll = nextRandom(state.rngState);
    state.rngState = roll.nextState;
    if (roll.value < GOLD_BUBBLE_CHANCE) {
      const len = randomRange(state.rngState, GOLD_BUBBLE_LEN[0], GOLD_BUBBLE_LEN[1]);
      state.rngState = len.nextState;
      g.phase = 'bubble';
      g.phaseCyclesLeft = Math.round(len.value);
      addLedger(state, 'Gold is rallying hard…', 0);
    }
  } else {
    const up = randomRange(state.rngState, GOLD_BUBBLE_RUNUP[0], GOLD_BUBBLE_RUNUP[1]);
    state.rngState = up.nextState;
    g.price = g.price * (1 + up.value);
    g.phaseCyclesLeft -= 1;
    if (g.phaseCyclesLeft <= 0) {
      const crash = randomRange(state.rngState, GOLD_CRASH[0], GOLD_CRASH[1]);
      state.rngState = crash.nextState;
      const before = g.price;
      g.price = Math.max(10, g.price * (1 - crash.value));
      g.phase = 'calm';
      addLedger(state, `Gold bubble popped — ${Math.round(crash.value * 100)}% wiped out`, 0);
      void before;
    }
  }
  g.price = Math.round(g.price * 100) / 100;
  pushHistory(g.history, g.price);
}

// ---------------------------------------------------------------------------
// Commands (instant player actions between ticks)
// ---------------------------------------------------------------------------

export type Command =
  | { kind: 'clickBoost'; facilityId: string }
  | { kind: 'spotSell'; productId: string; qty: number }
  | { kind: 'spotBuy'; productId: string; qty: number }
  | { kind: 'buildFacility'; facilityType: string }
  | { kind: 'levelUpFacility'; facilityId: string }
  | { kind: 'sellFacility'; facilityId: string }
  | { kind: 'takeLoan'; offerId: string }
  | { kind: 'payArrears' }
  | { kind: 'payTaxDebt' }
  | { kind: 'hireManager'; role: 'shipping' | 'finance' | 'accountant' }
  | { kind: 'fireManager'; role: 'shipping' | 'finance' | 'accountant' }
  | { kind: 'acceptOpportunity'; offerId: string }
  | { kind: 'signStandingContract'; productId: string; qtyPerCycle: number; cycles: number }
  | { kind: 'resolveObligation'; obligationId: string }
  | { kind: 'buyGold'; qty: number }
  | { kind: 'sellGold'; qty: number };

export function applyCommand(prev: GameState, cmd: Command, scenario: ScenarioConfig): GameState {
  const state = clone(prev);
  if (state.outcome) return state;

  switch (cmd.kind) {
    case 'clickBoost': {
      const f = state.facilities.find((x) => x.id === cmd.facilityId);
      if (!f) break;
      const want = Math.max(1, Math.round(facilityRatePerSec(f, scenario) * CLICK_BOOST_SECONDS));
      produceUpTo(state, scenario, f.productId, want);
      break;
    }
    case 'spotSell': {
      const have = state.inventory[cmd.productId] ?? 0;
      const qty = Math.min(cmd.qty, have);
      if (qty <= 0) break;
      const proceeds = Math.round(qty * state.market[cmd.productId].price * SPOT_SELL_FACTOR);
      state.inventory[cmd.productId] -= qty;
      state.cash += proceeds;
      state.cycleRevenueG += proceeds;
      markFirstSale(state);
      addLedger(state, `Sold ${qty} ${productById(scenario, cmd.productId).name} at market`, proceeds);
      break;
    }
    case 'spotBuy': {
      if (cmd.qty <= 0) break;
      const cost = Math.round(cmd.qty * state.market[cmd.productId].price);
      if (state.cash < cost) break;
      state.cash -= cost;
      state.inventory[cmd.productId] = (state.inventory[cmd.productId] ?? 0) + cmd.qty;
      addLedger(state, `Bought ${cmd.qty} ${productById(scenario, cmd.productId).name} at market`, -cost);
      break;
    }
    case 'buildFacility': {
      const def = facilityTypeDef(scenario, cmd.facilityType);
      if (state.taxDebt > 0) break; // tax debt blocks new facilities
      const product = productById(scenario, def.productId);
      if (product.tier > unlockedTier(state, scenario)) break;
      if (state.cash < def.buildCost) break;
      state.cash -= def.buildCost;
      state.facilities.push({
        id: genId(state, 'facility'),
        type: def.type,
        productId: def.productId,
        level: 1,
        invested: def.buildCost,
        accumulator: 0,
      });
      addLedger(state, `Built ${def.name}`, -def.buildCost);
      break;
    }
    case 'levelUpFacility': {
      const f = state.facilities.find((x) => x.id === cmd.facilityId);
      if (!f) break;
      const cost = levelUpCost(f, scenario);
      if (state.cash < cost) break;
      state.cash -= cost;
      f.level += 1;
      f.invested += cost;
      addLedger(state, `Upgraded ${facilityTypeDef(scenario, f.type).name} to L${f.level}`, -cost);
      break;
    }
    case 'sellFacility': {
      const idx = state.facilities.findIndex((x) => x.id === cmd.facilityId);
      if (idx < 0) break;
      const f = state.facilities[idx];
      const proceeds = Math.round(f.invested * FACILITY_RESALE_RATE);
      state.facilities.splice(idx, 1);
      state.cash += proceeds;
      addLedger(state, `Sold ${facilityTypeDef(scenario, f.type).name} for ${proceeds}g`, proceeds);
      break;
    }
    case 'takeLoan': {
      if (state.loanArrears > 0) break; // arrears blocks new loans
      const offer = LOAN_OFFERS.find((o) => o.id === cmd.offerId);
      if (!offer) break;
      state.cash += offer.principal;
      state.loans.push({
        id: genId(state, 'loan'),
        label: offer.label,
        principal: offer.principal,
        balance: offer.totalRepay,
        installmentPerCycle: offer.installmentPerCycle,
        cyclesLeft: offer.termCycles,
      });
      addLedger(state, `Took ${offer.label} loan (+${offer.principal}g)`, offer.principal);
      break;
    }
    case 'payArrears': {
      const pay = Math.min(state.loanArrears, state.cash);
      if (pay <= 0) break;
      state.cash -= pay;
      state.loanArrears -= pay;
      addLedger(state, `Paid loan arrears`, -pay);
      break;
    }
    case 'payTaxDebt': {
      const pay = Math.min(state.taxDebt, state.cash);
      if (pay <= 0) break;
      state.cash -= pay;
      state.taxDebt -= pay;
      state.totals.taxPaidG += pay;
      addLedger(state, `Paid tax debt`, -pay);
      break;
    }
    case 'hireManager': {
      if (cmd.role === 'shipping') {
        state.managers.shipping += 1;
        addLedger(state, `Hired a Shipping Manager`, 0);
      } else if (cmd.role === 'finance' && !state.managers.finance) {
        state.managers.finance = true;
        addLedger(state, `Hired a Finance Manager`, 0);
      } else if (cmd.role === 'accountant' && !state.managers.accountant) {
        state.managers.accountant = true;
        addLedger(state, `Hired an Accountant`, 0);
      }
      break;
    }
    case 'fireManager': {
      if (cmd.role === 'shipping' && state.managers.shipping > 0) state.managers.shipping -= 1;
      else if (cmd.role === 'finance') state.managers.finance = false;
      else if (cmd.role === 'accountant') state.managers.accountant = false;
      break;
    }
    case 'acceptOpportunity': {
      const idx = state.opportunities.findIndex((o) => o.id === cmd.offerId);
      if (idx < 0) break;
      const o = state.opportunities[idx];
      state.opportunities.splice(idx, 1);
      state.contracts.push({
        id: genId(state, 'contract'),
        customer: o.customer,
        productId: o.productId,
        qtyPerCycle: o.qtyPerCycle,
        pricePerUnit: o.pricePerUnit,
        cyclesLeft: o.durationCycles,
        fromEvent: true,
      });
      addLedger(state, `Signed ${o.customer} (${o.qtyPerCycle}/cycle @ ${o.pricePerUnit}g)`, 0);
      break;
    }
    case 'signStandingContract': {
      const spot = state.market[cmd.productId].price;
      state.contracts.push({
        id: genId(state, 'contract'),
        customer: 'Market Contract',
        productId: cmd.productId,
        qtyPerCycle: cmd.qtyPerCycle,
        pricePerUnit: Math.round(spot * CONTRACT_PREMIUM),
        cyclesLeft: cmd.cycles,
        fromEvent: false,
      });
      addLedger(state, `Signed a standing contract for ${cmd.qtyPerCycle} ${productById(scenario, cmd.productId).name}/cycle`, 0);
      break;
    }
    case 'resolveObligation': {
      const idx = state.pendingObligations.findIndex((o) => o.id === cmd.obligationId);
      if (idx < 0) break;
      const o = state.pendingObligations[idx];
      if (resolveObligation(state, scenario, o)) state.pendingObligations.splice(idx, 1);
      break;
    }
    case 'buyGold': {
      if (cmd.qty <= 0) break;
      const cost = Math.round(cmd.qty * state.gold.price);
      if (state.cash < cost) break;
      state.cash -= cost;
      state.gold.held += cmd.qty;
      state.gold.costBasis += cost;
      addLedger(state, `Bought ${cmd.qty} gold`, -cost);
      break;
    }
    case 'sellGold': {
      const qty = Math.min(cmd.qty, state.gold.held);
      if (qty <= 0) break;
      const proceeds = Math.round(qty * state.gold.price);
      const basisPortion = state.gold.held > 0 ? Math.round((state.gold.costBasis * qty) / state.gold.held) : 0;
      state.gold.held -= qty;
      state.gold.costBasis -= basisPortion;
      state.gold.realizedPnL += proceeds - basisPortion;
      state.cash += proceeds;
      addLedger(state, `Sold ${qty} gold`, proceeds);
      break;
    }
  }

  return state;
}

// Speculation P&L = realized + unrealized on current holdings.
export function speculationPnL(state: GameState): number {
  const unrealized = goldValue(state) - state.gold.costBasis;
  return Math.round(state.gold.realizedPnL + unrealized);
}
