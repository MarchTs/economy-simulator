// Owe & Flow — a node-and-wire spin-off of Owe & Grow.
// Same scenarios (products + facility types), but instead of a shared
// inventory, goods physically travel along wires the player draws between
// nodes. Sources make raw goods, processors turn inputs into outputs, and
// sinks (the Market) turn goods into cash. Throughput is limited by wire
// capacity, node buffers, and a market that pays less the more you flood it.
//
// Money is on the board too. The Budget is the global cash every build is
// paid from; place as many Budget blocks as you like, they all show that one balance. Wallets hold money; a Wallet or the Budget pays the upkeep of
// the blocks wired to it, and a block nobody pays stops. A Borrower is a
// loan: it pushes its principal down a money wire, and collects each
// installment from the Wallet or Budget wired into it. Money wires either
// FLOW (into a Wallet or the Budget, continuously, with no limit) or PAY
// (into any other block, drawn only when a bill falls due).
// Pure functions over a JSON-serializable FlowState, like the classic engine.
import { LOAN_OFFERS, type LoanOffer, type ScenarioConfig } from '../engine/sim';
import { nextRandom, randomRange } from '../engine/rng';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type NodeKind = 'facility' | 'market' | 'supplier' | 'budget' | 'wallet' | 'borrower';
export type NodeStatus = 'idle' | 'running' | 'starved' | 'blocked' | 'unpaid';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  facilityType: string | null; // facility nodes only
  productId: string | null; // the good this node emits; null for the market and money blocks
  level: number;
  invested: number;
  accumulator: number; // fractional output not yet made
  inBuf: Record<string, number>; // waiting inputs, per product
  outBuf: number; // finished goods waiting to leave
  status: NodeStatus;
  madeLastSec: number;
  soldLastSec: number; // market only: g earned last second
  rr: number; // round-robin cursor over outgoing wires
  money: number; // wallet balance, market takings not yet collected, borrower principal not yet sent
  unpaid: number; // upkeep owed and not yet paid; the block stops while this is > 0
  loan: FlowLoan | null; // borrower only
  demand: number; // supplier only: units/second the player has it buy
}

export interface Wire {
  id: string;
  from: string;
  to: string;
  productId: string; // a good, or MONEY
  level: number;
  movedLastSec: number; // units for goods, gold for money
}

export interface FlowMarketEntry {
  price: number; // spot anchor, drifts each cycle
  glut: number; // recent units dumped on the market; decays every second
  history: number[];
}

export interface FlowLoan {
  label: string;
  balance: number; // still to fall due
  installmentPerCycle: number;
  arrears: number; // fell due and was not paid; grows every bill
}

export interface FlowLedgerEntry {
  sec: number;
  label: string;
  deltaG: number;
}

export interface FlowState {
  scenarioId: string;
  clockSec: number;
  cycle: number;
  cash: number; // the Budget's balance
  nodes: FlowNode[];
  wires: Wire[];
  market: Record<string, FlowMarketEntry>;
  ledger: FlowLedgerEntry[];
  totals: { salesG: number; upkeepG: number; loanPaidG: number; suppliesG: number };
  rngState: number;
  nextId: number;
}

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

export const FLOW_SETTLE_SEC = 30;
export const START_CASH = 600;
export const BUFFER_CAP = 10; // per input product, and for the output buffer; × level for a facility
export const WIRE_COST = 25;
export const WIRE_BASE_RATE = 2; // units/second at wire level 1 (doubles per level)
export const WIRE_UPGRADE_BASE = 80; // × current level
export const MARKET_COST = 300;
export const SUPPLIER_COST = 250;
export const SUPPLIER_DEFAULT_DEMAND = 1; // units/second a new supplier buys
export const SUPPLIER_MAX_DEMAND = 20;
export const SUPPLIER_MARKUP = 1.15; // pays this × spot for what it buys
export const NODE_RESALE_RATE = 0.7;
export const LEVELUP_FACTOR = 0.6;
export const GLUT_DECAY = 0.05; // fraction of glut forgotten per second
export const DEMAND_BY_TIER = [60, 40, 25, 15]; // glut that halves the price
export const ARREARS_PENALTY = 0.1;
export const MONEY = '$money'; // the productId a money wire carries
export const WALLET_COST = 100;
export const WALLET_UPKEEP = 2;
export const MARKET_UPKEEP = 5;
export const SUPPLIER_UPKEEP = 4; // per unit/second of demand, rounded up
export const STARTER_WALLET_FUND = 100;
const EPS = 1e-9;
export const FLOW_LOAN_TERM = 20; // bills

// The classic game's loans, repaid over FLOW_LOAN_TERM bills: same amount
// borrowed, same total repaid, bigger installments.
export const FLOW_LOAN_OFFERS: LoanOffer[] = LOAN_OFFERS.map((o) => {
  const installmentPerCycle = Math.ceil(o.totalRepay / FLOW_LOAN_TERM);
  return { ...o, installmentPerCycle, termCycles: FLOW_LOAN_TERM, totalRepay: installmentPerCycle * FLOW_LOAN_TERM };
});
const HISTORY_CAP = 120;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function genId(state: FlowState, prefix: string): string {
  return `${prefix}_${state.nextId++}`;
}

function addLedger(state: FlowState, label: string, deltaG: number) {
  state.ledger.push({ sec: state.clockSec, label, deltaG });
  if (state.ledger.length > 300) state.ledger.shift();
}

export function product(scenario: ScenarioConfig, id: string) {
  return scenario.products.find((p) => p.id === id)!;
}

export function facilityDef(scenario: ScenarioConfig, type: string) {
  return scenario.facilityTypes.find((f) => f.type === type)!;
}

// Units/second a node can emit at its level (0 for the market).
export function nodeRate(node: FlowNode, scenario: ScenarioConfig): number {
  if (node.kind === 'facility') return facilityDef(scenario, node.facilityType!).baseRatePerSec * node.level;
  if (node.kind === 'supplier') return node.demand;
  return 0;
}

export function nodeUpkeep(node: FlowNode, scenario: ScenarioConfig): number {
  if (node.kind === 'facility') return facilityDef(scenario, node.facilityType!).upkeepPerCycle * node.level;
  if (node.kind === 'supplier') return Math.ceil(SUPPLIER_UPKEEP * node.demand);
  if (node.kind === 'market') return MARKET_UPKEEP;
  if (node.kind === 'wallet') return WALLET_UPKEEP;
  return 0; // the Budget and Borrowers cost nothing to keep
}

// Only facilities level up; a supplier is tuned by its demand instead.
export function isUpgradable(node: FlowNode): boolean {
  return node.kind === 'facility';
}

// Every block emits at most one thing: a good, or money.
export function outputOf(node: FlowNode): string | null {
  if (node.kind === 'facility' || node.kind === 'supplier') return node.productId;
  return MONEY;
}

// The input rows a block's card shows, top to bottom. `*goods` is the market's
// any-good port; MONEY is the port a payer's wire lands on (or money arrives on).
export function inputRows(node: FlowNode, scenario: ScenarioConfig): string[] {
  if (node.kind === 'facility') return [...product(scenario, node.productId!).inputs.map((i) => i.id), MONEY];
  if (node.kind === 'market') return ['*goods', MONEY];
  return [MONEY];
}

// A money wire into a Wallet or the Budget moves money; into anything else it pays that block's bills.
export function isPayLink(state: FlowState, w: Wire): boolean {
  if (w.productId !== MONEY) return false;
  const to = state.nodes.find((n) => n.id === w.to);
  return !!to && to.kind !== 'wallet' && to.kind !== 'budget';
}

export function nodeInputs(node: FlowNode, scenario: ScenarioConfig): { id: string; qty: number }[] {
  if (node.kind !== 'facility') return [];
  return product(scenario, node.productId!).inputs;
}

// A facility works in batches that grow with its level: an L2 Malthouse turns
// 4 Barley into 2 Malt at the same batches per second as an L1 turns 2 into 1.
export function batchSize(node: FlowNode): number {
  return node.kind === 'facility' ? node.level : 1;
}

// One batch's inputs at the node's level.
export function batchInputs(node: FlowNode, scenario: ScenarioConfig): { id: string; qty: number }[] {
  return nodeInputs(node, scenario).map((i) => ({ id: i.id, qty: i.qty * batchSize(node) }));
}

// How much of each input, and of its output, a node can hold. Grows with a
// facility's level so a batch always fits.
export function bufferCap(node: FlowNode): number {
  if (node.kind === 'supplier') return Math.max(BUFFER_CAP, Math.ceil(node.demand)); // a second's buying always fits
  return BUFFER_CAP * batchSize(node);
}

export function levelUpCost(node: FlowNode, scenario: ScenarioConfig): number {
  return Math.round(facilityDef(scenario, node.facilityType!).buildCost * LEVELUP_FACTOR * node.level);
}

// Goods wires carry a few units a second; money wires carry any amount, so they never upgrade.
export function wireCapacity(w: Wire): number {
  return w.productId === MONEY ? Infinity : WIRE_BASE_RATE * 2 ** (w.level - 1);
}

export function wireUpgradeCost(w: Wire): number {
  return WIRE_UPGRADE_BASE * w.level;
}

// What one unit fetches at the market right now, after the glut discount.
export function salePrice(state: FlowState, scenario: ScenarioConfig, productId: string): number {
  const m = state.market[productId];
  const demand = DEMAND_BY_TIER[product(scenario, productId).tier] ?? 15;
  return m.price / (1 + m.glut / demand);
}

export function nodeName(node: FlowNode, scenario: ScenarioConfig): string {
  if (node.kind === 'facility') return facilityDef(scenario, node.facilityType!).name;
  if (node.kind === 'supplier') return `${product(scenario, node.productId!).name} Supplier`;
  if (node.kind === 'market') return 'Market';
  if (node.kind === 'budget') return 'Budget';
  if (node.kind === 'wallet') return 'Wallet';
  return `${node.loan!.label} loan`;
}

// Why `from`'s output can't plug into `to`, or null when it can. Ignores cost and duplicates.
export function connectRule(from: FlowNode, to: FlowNode, scenario: ScenarioConfig): string | null {
  if (from.id === to.id) return "A block can't feed itself";
  const out = outputOf(from)!;
  if (out !== MONEY) {
    if (to.kind === 'market') return null;
    if (to.kind === 'facility' && nodeInputs(to, scenario).some((i) => i.id === out)) return null;
    if (to.kind === 'wallet' || to.kind === 'budget' || to.kind === 'borrower') return 'Goods turn into money at a Market first';
    return `${nodeName(to, scenario)} doesn't use ${product(scenario, out).name}`;
  }
  if (from.kind === 'budget') {
    if (to.kind === 'wallet') return "A wire would drain the Budget. Fund the Wallet from its panel";
    return null; // a block's upkeep, or a Borrower's installments
  }
  if (from.kind === 'wallet') {
    if (to.kind === 'wallet') return "Wallets don't feed each other. Move money through the Budget";
    return null; // a block's upkeep, a Borrower's installments, or a sweep into the Budget
  }
  // Market takings and borrowed principal can only be collected.
  if (to.kind === 'wallet' || to.kind === 'budget') return null;
  return from.kind === 'market' ? 'Market takings go to a Wallet or the Budget' : 'Borrowed money goes to a Wallet or the Budget';
}

export function canConnect(state: FlowState, scenario: ScenarioConfig, fromId: string, toId: string): string | null {
  const from = state.nodes.find((n) => n.id === fromId);
  const to = state.nodes.find((n) => n.id === toId);
  if (!from || !to) return 'Missing block';
  const why = connectRule(from, to, scenario);
  if (why) return why;
  if (state.wires.some((w) => w.from === fromId && w.to === toId)) return 'Already connected';
  if (state.cash < WIRE_COST) return `Need ${WIRE_COST}g for a wire`;
  return null;
}

export function borrowers(state: FlowState): FlowNode[] {
  return state.nodes.filter((n) => n.kind === 'borrower');
}

export function debt(state: FlowState): number {
  return borrowers(state).reduce((s, n) => s + n.loan!.balance + n.loan!.arrears, 0);
}

export function hasArrears(state: FlowState): boolean {
  return borrowers(state).some((n) => n.loan!.arrears > 0);
}

// Who pays `node`'s bills, with the wire each payment shows on: its Wallets
// first, the Budget last, so a wired Budget is the fallback. A Wallet pays its own upkeep.
type Payer = { node: FlowNode; wire: Wire | null };
export function payersOf(state: FlowState, node: FlowNode): Payer[] {
  if (node.kind === 'wallet') return [{ node, wire: null }];
  if (node.kind === 'budget') return [];
  const out: Payer[] = [];
  for (const w of state.wires) {
    if (w.to !== node.id || w.productId !== MONEY) continue;
    const from = state.nodes.find((n) => n.id === w.from);
    if (from && (from.kind === 'wallet' || from.kind === 'budget')) out.push({ node: from, wire: w });
  }
  return out.sort((a, b) => Number(a.node.kind === 'budget') - Number(b.node.kind === 'budget'));
}

function balanceOf(state: FlowState, n: FlowNode): number {
  return n.kind === 'budget' ? state.cash : n.money;
}

function payable(state: FlowState, payers: Payer[]): number {
  return payers.reduce((s, p) => s + Math.max(0, balanceOf(state, p.node)), 0);
}

// Take up to `amount` from the payers in wire order; returns what was taken.
function draw(state: FlowState, payers: Payer[], amount: number): number {
  let taken = 0;
  for (const p of payers) {
    const give = Math.min(amount - taken, Math.max(0, balanceOf(state, p.node)));
    if (give <= EPS) continue;
    if (p.node.kind === 'budget') state.cash -= give;
    else p.node.money -= give;
    if (p.wire) p.wire.movedLastSec += give;
    taken += give;
    if (amount - taken <= EPS) break;
  }
  return taken;
}

// What a Wallet keeps back from a sweep into the Budget: the next bill for everything it pays.
export function walletReserve(state: FlowState, wallet: FlowNode, scenario: ScenarioConfig): number {
  let r = nodeUpkeep(wallet, scenario) + wallet.unpaid;
  for (const w of state.wires) {
    if (w.from !== wallet.id || !isPayLink(state, w)) continue;
    const to = state.nodes.find((n) => n.id === w.to)!;
    r += to.kind === 'borrower' ? Math.min(to.loan!.installmentPerCycle, to.loan!.balance) + to.loan!.arrears : nodeUpkeep(to, scenario) + to.unpaid;
  }
  return r;
}

function makeNode(state: FlowState, kind: NodeKind, x: number, y: number, facilityType: string | null, productId: string | null, invested: number): FlowNode {
  return {
    id: genId(state, 'node'),
    kind,
    x,
    y,
    facilityType,
    productId,
    level: 1,
    invested,
    accumulator: 0,
    inBuf: {},
    outBuf: 0,
    status: 'idle',
    madeLastSec: 0,
    soldLastSec: 0,
    rr: 0,
    money: 0,
    unpaid: 0,
    loan: null,
    demand: 0,
  };
}

// ---------------------------------------------------------------------------
// New game
// ---------------------------------------------------------------------------

export function newFlowGame(scenario: ScenarioConfig, opts: { seed: number }): FlowState {
  const market: Record<string, FlowMarketEntry> = {};
  for (const p of scenario.products) market[p.id] = { price: p.basePrice, glut: 0, history: [p.basePrice] };
  const state: FlowState = {
    scenarioId: scenario.id,
    clockSec: 0,
    cycle: 0,
    cash: START_CASH - STARTER_WALLET_FUND,
    nodes: [],
    wires: [],
    market,
    ledger: [],
    totals: { salesG: 0, upkeepG: 0, loanPaidG: 0, suppliesG: 0 },
    rngState: opts.seed >>> 0,
    nextId: 1,
  };
  const start = facilityDef(scenario, scenario.startingFacilityType);
  state.nodes.push(makeNode(state, 'facility', 80, 160, start.type, start.productId, start.buildCost));
  state.nodes.push(makeNode(state, 'market', 620, 160, null, null, 0));
  const wallet = makeNode(state, 'wallet', 80, 420, null, null, 0);
  wallet.money = STARTER_WALLET_FUND;
  state.nodes.push(wallet);
  state.nodes.push(makeNode(state, 'budget', 620, 420, null, null, 0));
  addLedger(state, 'Wire the Wallet into the Farm and the Market so their upkeep gets paid', 0);
  addLedger(state, 'Then Farm → Market to sell, and Market → Budget to collect', 0);
  return state;
}

// ---------------------------------------------------------------------------
// The per-second tick: produce → transport → sell → settle
// ---------------------------------------------------------------------------

export function tickFlow(prev: FlowState, scenario: ScenarioConfig): FlowState {
  const state = structuredClone(prev);
  state.clockSec += 1;
  for (const w of state.wires) w.movedLastSec = 0;

  // 0. A block that couldn't pay its upkeep tries again every second.
  for (const n of state.nodes) {
    if (n.unpaid <= EPS) continue;
    const paid = draw(state, payersOf(state, n), n.unpaid);
    n.unpaid = Math.max(0, n.unpaid - paid);
    state.totals.upkeepG += paid;
  }

  // 1. Production.
  for (const n of state.nodes) {
    n.madeLastSec = 0;
    n.soldLastSec = 0;
    if (n.unpaid > EPS) {
      n.status = 'unpaid';
      n.accumulator = 0;
      continue;
    }
    if (n.kind !== 'facility' && n.kind !== 'supplier') {
      if (n.kind !== 'market') n.status = 'running';
      continue;
    }
    if (nodeRate(n, scenario) <= 0) {
      n.status = 'idle'; // a supplier set to buy nothing
      n.accumulator = 0;
      continue;
    }
    // Work in whole batches; the accumulator counts batches, not units.
    const batch = batchSize(n);
    const room = Math.floor((bufferCap(n) - n.outBuf) / batch);
    if (room <= 0) {
      n.status = 'blocked';
      n.accumulator = 0;
      continue;
    }
    n.accumulator += nodeRate(n, scenario) / batch;
    let want = Math.min(room, Math.floor(n.accumulator));
    if (want <= 0) {
      n.status = n.status === 'idle' ? 'running' : n.status;
      continue;
    }
    if (n.kind === 'supplier') {
      // A supplier buys its stock with the money of whoever pays for it.
      const payers = payersOf(state, n);
      const unit = state.market[n.productId!].price * SUPPLIER_MARKUP;
      want = Math.min(want, Math.floor(payable(state, payers) / unit));
      const cost = draw(state, payers, unit * want);
      state.totals.suppliesG += cost;
    } else {
      const inputs = batchInputs(n, scenario);
      for (const inp of inputs) want = Math.min(want, Math.floor((n.inBuf[inp.id] ?? 0) / inp.qty));
      for (const inp of inputs) n.inBuf[inp.id] = (n.inBuf[inp.id] ?? 0) - inp.qty * want;
    }
    n.outBuf += want * batch;
    n.madeLastSec = want * batch;
    n.accumulator -= want;
    if (want === 0) {
      n.accumulator = 0;
      n.status = 'starved';
    } else n.status = 'running';
  }

  // 2. Transport: each node pushes its output down its wires, one unit at a
  // time round-robin, so a split feeds every branch evenly.
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  for (const n of state.nodes) {
    const outs = state.wires.filter((w) => w.from === n.id && w.productId !== MONEY);
    if (outs.length === 0 || n.outBuf <= 0) continue;
    let progress = true;
    while (n.outBuf > 0 && progress) {
      progress = false;
      for (let k = 0; k < outs.length && n.outBuf > 0; k++) {
        const w = outs[(n.rr + k) % outs.length];
        if (w.movedLastSec >= wireCapacity(w)) continue;
        const to = byId.get(w.to)!;
        if (to.kind === 'market') {
          if (to.unpaid > EPS) continue; // a stopped market buys nothing
          const earned = salePrice(state, scenario, w.productId);
          state.market[w.productId].glut += 1;
          to.money += earned; // waits in the market until a money wire collects it
          state.totals.salesG += earned;
          to.soldLastSec += earned;
        } else {
          if ((to.inBuf[w.productId] ?? 0) >= bufferCap(to)) continue;
          to.inBuf[w.productId] = (to.inBuf[w.productId] ?? 0) + 1;
        }
        n.outBuf -= 1;
        w.movedLastSec += 1;
        progress = true;
      }
      n.rr = (n.rr + 1) % outs.length;
    }
  }
  for (const n of state.nodes) if (n.kind === 'market' && n.unpaid <= EPS) n.status = n.soldLastSec > 0 ? 'running' : 'idle';

  // 3. Money moves along its flow wires (into Wallets and the Budget) all at
  // once, split evenly between them. A Wallet keeps back its next bill.
  for (const n of state.nodes) {
    if (n.kind !== 'market' && n.kind !== 'wallet' && n.kind !== 'borrower') continue;
    const send = n.kind === 'wallet' ? Math.max(0, n.money - walletReserve(state, n, scenario)) : n.money;
    const flows = state.wires.filter((w) => w.from === n.id && w.productId === MONEY && !isPayLink(state, w));
    if (send <= EPS || !flows.length) continue;
    const share = send / flows.length;
    for (const w of flows) {
      const to = byId.get(w.to)!;
      if (to.kind === 'budget') state.cash += share;
      else to.money += share;
      w.movedLastSec = share;
    }
    n.money -= send;
  }

  // 4. The market slowly forgets a glut.
  for (const m of Object.values(state.market)) m.glut *= 1 - GLUT_DECAY;

  // 5. Settlement.
  if (state.clockSec % FLOW_SETTLE_SEC === 0) settle(state, scenario);
  return state;
}

function settle(state: FlowState, scenario: ScenarioConfig) {
  state.cycle += 1;

  // Upkeep: every block bills the Wallets and Budget wired into it; whatever they can't cover stops it.
  let paidUpkeep = 0;
  let stopped = 0;
  const budgetBefore = state.cash;
  for (const n of state.nodes) {
    const due = nodeUpkeep(n, scenario);
    if (due <= 0) continue;
    n.unpaid += due;
    const paid = draw(state, payersOf(state, n), n.unpaid);
    n.unpaid = Math.max(0, n.unpaid - paid);
    paidUpkeep += paid;
    if (n.unpaid > EPS) {
      n.status = 'unpaid';
      stopped += 1;
    }
  }
  state.totals.upkeepG += paidUpkeep;
  // Ledger amounts track the Budget, so wallet-paid upkeep is named rather than counted.
  const fromBudget = budgetBefore - state.cash;
  if (paidUpkeep - fromBudget > EPS) addLedger(state, `Wallets paid ${Math.round(paidUpkeep - fromBudget)}g upkeep`, 0);
  if (fromBudget > EPS) addLedger(state, 'Upkeep from Budget', -fromBudget);
  if (stopped) addLedger(state, `${stopped} block${stopped > 1 ? 's' : ''} unpaid and stopped`, 0);

  // Loans: each Borrower collects its installment from whatever is wired into it.
  for (const n of borrowers(state)) {
    const l = n.loan!;
    if (l.arrears > 0) l.arrears = Math.round(l.arrears * (1 + ARREARS_PENALTY));
    const due = Math.min(l.installmentPerCycle, l.balance);
    l.balance -= due;
    l.arrears += due;
    const paid = draw(state, payersOf(state, n), l.arrears);
    l.arrears = Math.max(0, l.arrears - paid);
    state.totals.loanPaidG += paid;
    if (l.arrears > EPS) addLedger(state, `Missed ${l.label} payment → arrears ${Math.round(l.arrears)}g`, 0);
    if (l.balance <= EPS && l.arrears <= EPS) retireBorrower(state, n);
  }

  for (const p of scenario.products) {
    const m = state.market[p.id];
    const r = randomRange(state.rngState, -0.05, 0.05);
    state.rngState = r.nextState;
    m.price = Math.round(Math.max(p.basePrice * 0.5, Math.min(p.basePrice * 2, m.price * (1 + r.value))) * 100) / 100;
    m.history.push(m.price);
    if (m.history.length > HISTORY_CAP) m.history.shift();
  }
  // Keep the rng moving even with an empty scenario, for determinism.
  state.rngState = nextRandom(state.rngState).nextState;
}

// A paid-off loan leaves the board; any principal it never sent goes to the Budget.
function retireBorrower(state: FlowState, n: FlowNode) {
  state.cash += n.money;
  state.nodes = state.nodes.filter((x) => x.id !== n.id);
  state.wires = state.wires.filter((w) => w.from !== n.id && w.to !== n.id);
  addLedger(state, `Paid off the ${n.loan!.label} loan`, n.money);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type FlowCommand =
  | { kind: 'buildFacility'; facilityType: string; x: number; y: number }
  | { kind: 'buildMarket'; x: number; y: number }
  | { kind: 'buildSupplier'; productId: string; x: number; y: number }
  | { kind: 'buildWallet'; fund: number; x: number; y: number }
  | { kind: 'setDemand'; nodeId: string; demand: number } // supplier: units/second to buy
  | { kind: 'buildBudget'; x: number; y: number }
  | { kind: 'transferMoney'; nodeId: string; amount: number } // + Budget → Wallet, − Wallet → Budget
  | { kind: 'connect'; from: string; to: string }
  | { kind: 'removeWire'; wireId: string }
  | { kind: 'upgradeWire'; wireId: string }
  | { kind: 'levelUp'; nodeId: string }
  | { kind: 'sellNode'; nodeId: string }
  | { kind: 'takeLoan'; offerId: string; x: number; y: number }
  | { kind: 'payArrears'; nodeId: string }; // from the Budget

export function applyFlowCommand(prev: FlowState, cmd: FlowCommand, scenario: ScenarioConfig): FlowState {
  const state = structuredClone(prev);
  const spend = (cost: number, label: string) => {
    if (state.cash < cost) return false;
    state.cash -= cost;
    addLedger(state, label, -cost);
    return true;
  };

  switch (cmd.kind) {
    case 'buildFacility': {
      const def = facilityDef(scenario, cmd.facilityType);
      if (!def || !spend(def.buildCost, `Built ${def.name}`)) break;
      state.nodes.push(makeNode(state, 'facility', cmd.x, cmd.y, def.type, def.productId, def.buildCost));
      break;
    }
    case 'buildMarket': {
      if (!spend(MARKET_COST, 'Opened a market stall')) break;
      state.nodes.push(makeNode(state, 'market', cmd.x, cmd.y, null, null, MARKET_COST));
      break;
    }
    case 'buildSupplier': {
      if (!state.market[cmd.productId]) break;
      if (!spend(SUPPLIER_COST, `Signed a ${product(scenario, cmd.productId).name} supplier`)) break;
      const sup = makeNode(state, 'supplier', cmd.x, cmd.y, null, cmd.productId, SUPPLIER_COST);
      sup.demand = SUPPLIER_DEFAULT_DEMAND;
      state.nodes.push(sup);
      break;
    }
    case 'setDemand': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n || n.kind !== 'supplier' || !Number.isFinite(cmd.demand)) break;
      n.demand = Math.max(0, Math.min(SUPPLIER_MAX_DEMAND, Math.round(cmd.demand * 10) / 10));
      break;
    }
    case 'buildWallet': {
      if (!spend(WALLET_COST, 'Opened a wallet')) break;
      const fund = Math.max(0, Math.min(state.cash, Math.round(cmd.fund) || 0));
      const wallet = makeNode(state, 'wallet', cmd.x, cmd.y, null, null, WALLET_COST);
      wallet.money = fund;
      state.cash -= fund;
      state.nodes.push(wallet);
      if (fund > 0) addLedger(state, 'Funded the new wallet', -fund);
      break;
    }
    case 'buildBudget': {
      // Free: another window onto the same global cash, so wires needn't cross the board.
      state.nodes.push(makeNode(state, 'budget', cmd.x, cmd.y, null, null, 0));
      break;
    }
    case 'transferMoney': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n || n.kind !== 'wallet') break;
      const amount = Math.round(cmd.amount) || 0;
      const moved = amount > 0 ? Math.min(amount, state.cash) : -Math.min(-amount, n.money);
      if (Math.abs(moved) <= EPS) break;
      state.cash -= moved;
      n.money += moved;
      addLedger(state, moved > 0 ? 'Moved money into a wallet' : 'Moved money out of a wallet', -moved);
      break;
    }
    case 'connect': {
      if (canConnect(state, scenario, cmd.from, cmd.to)) break;
      const from = state.nodes.find((n) => n.id === cmd.from)!;
      state.cash -= WIRE_COST;
      state.wires.push({ id: genId(state, 'wire'), from: cmd.from, to: cmd.to, productId: outputOf(from)!, level: 1, movedLastSec: 0 });
      break;
    }
    case 'removeWire': {
      state.wires = state.wires.filter((w) => w.id !== cmd.wireId);
      break;
    }
    case 'upgradeWire': {
      const w = state.wires.find((x) => x.id === cmd.wireId);
      if (!w || w.productId === MONEY || !spend(wireUpgradeCost(w), `Upgraded a ${product(scenario, w.productId).name} line`)) break;
      w.level += 1;
      break;
    }
    case 'levelUp': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n || !isUpgradable(n)) break;
      const cost = levelUpCost(n, scenario);
      if (!spend(cost, `Upgraded to L${n.level + 1}`)) break;
      n.level += 1;
      n.invested += cost;
      break;
    }
    case 'sellNode': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n || n.kind === 'borrower') break; // a loan is repaid, not sold
      if (n.kind === 'budget' && state.nodes.filter((x) => x.kind === 'budget').length <= 1) break; // keep one Budget on the board
      const proceeds = Math.round(n.invested * NODE_RESALE_RATE + n.money);
      state.nodes = state.nodes.filter((x) => x.id !== n.id);
      state.wires = state.wires.filter((w) => w.from !== n.id && w.to !== n.id);
      state.cash += proceeds;
      if (n.kind !== 'budget') addLedger(state, 'Sold a node', proceeds);
      break;
    }
    case 'takeLoan': {
      if (hasArrears(state)) break;
      const offer = FLOW_LOAN_OFFERS.find((o) => o.id === cmd.offerId);
      if (!offer) break;
      const b = makeNode(state, 'borrower', cmd.x, cmd.y, null, null, 0);
      b.money = offer.principal;
      b.loan = { label: offer.label, balance: offer.totalRepay, installmentPerCycle: offer.installmentPerCycle, arrears: 0 };
      state.nodes.push(b);
      addLedger(state, `Took a ${offer.label} loan of ${offer.principal}g. Wire its Borrower to a Wallet or the Budget`, 0);
      break;
    }
    case 'payArrears': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n?.loan) break;
      const pay = Math.min(n.loan.arrears, state.cash);
      if (pay <= EPS) break;
      state.cash -= pay;
      n.loan.arrears -= pay;
      state.totals.loanPaidG += pay;
      addLedger(state, `Paid ${n.loan.label} arrears`, -pay);
      if (n.loan.balance <= EPS && n.loan.arrears <= EPS) retireBorrower(state, n);
      break;
    }
  }
  return state;
}

// Dragging is UI-only and fires on every pointer move, so it skips the deep clone.
export function moveNode(state: FlowState, nodeId: string, x: number, y: number): FlowState {
  return { ...state, nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) };
}
