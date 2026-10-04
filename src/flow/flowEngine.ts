// Owe & Flow — a node-and-wire spin-off of Owe & Grow.
// Same scenarios (products + facility types), but instead of a shared
// inventory, goods physically travel along wires the player draws between
// nodes. Sources make raw goods, processors turn inputs into outputs, and
// sinks (the Market) turn goods into cash. Throughput is limited by wire
// capacity, node buffers, and a market that pays less the more you flood it.
// Pure functions over a JSON-serializable FlowState, like the classic engine.
import { LOAN_OFFERS, type ScenarioConfig } from '../engine/sim';
import { nextRandom, randomRange } from '../engine/rng';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type NodeKind = 'facility' | 'market' | 'supplier';
export type NodeStatus = 'idle' | 'running' | 'starved' | 'blocked';

export interface FlowNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  facilityType: string | null; // facility nodes only
  productId: string | null; // what this node emits; null for the market
  level: number;
  invested: number;
  accumulator: number; // fractional output not yet made
  inBuf: Record<string, number>; // waiting inputs, per product
  outBuf: number; // finished goods waiting to leave
  status: NodeStatus;
  madeLastSec: number;
  soldLastSec: number; // market only: g earned last second
  rr: number; // round-robin cursor over outgoing wires
}

export interface Wire {
  id: string;
  from: string;
  to: string;
  productId: string;
  level: number;
  movedLastSec: number;
}

export interface FlowMarketEntry {
  price: number; // spot anchor, drifts each cycle
  glut: number; // recent units dumped on the market; decays every second
  history: number[];
}

export interface FlowLoan {
  id: string;
  label: string;
  balance: number;
  installmentPerCycle: number;
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
  cash: number;
  nodes: FlowNode[];
  wires: Wire[];
  market: Record<string, FlowMarketEntry>;
  loans: FlowLoan[];
  arrears: number;
  ledger: FlowLedgerEntry[];
  totals: { salesG: number; upkeepG: number; loanPaidG: number; suppliesG: number };
  goal: { targetNetWorth: number; timeLimitSec: number } | null;
  rngState: number;
  nextId: number;
  outcome: 'won' | 'timeUp' | null;
  wonAtSec: number | null;
}

// ---------------------------------------------------------------------------
// Balance knobs
// ---------------------------------------------------------------------------

export const FLOW_SETTLE_SEC = 30;
export const START_CASH = 600;
export const BUFFER_CAP = 10; // per input product, and for the output buffer
export const WIRE_COST = 25;
export const WIRE_BASE_RATE = 2; // units/second at wire level 1 (doubles per level)
export const WIRE_UPGRADE_BASE = 80; // × current level
export const MARKET_COST = 300;
export const SUPPLIER_COST = 250;
export const SUPPLIER_RATE = 1; // units/second at level 1
export const SUPPLIER_MARKUP = 1.15; // pays this × spot for what it buys
export const NODE_RESALE_RATE = 0.7;
export const LEVELUP_FACTOR = 0.6;
export const GLUT_DECAY = 0.05; // fraction of glut forgotten per second
export const DEMAND_BY_TIER = [60, 40, 25, 15]; // glut that halves the price
export const ARREARS_PENALTY = 0.1;
export const FLOW_GOAL_NET_WORTH = 50_000; // a naive greedy bot reaches ~27k without loans
export const FLOW_TIME_LIMIT_SEC = 1800;
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
  if (node.kind === 'supplier') return SUPPLIER_RATE * node.level;
  return 0;
}

export function nodeUpkeep(node: FlowNode, scenario: ScenarioConfig): number {
  if (node.kind === 'facility') return facilityDef(scenario, node.facilityType!).upkeepPerCycle * node.level;
  if (node.kind === 'supplier') return 4 * node.level;
  return 5;
}

export function nodeInputs(node: FlowNode, scenario: ScenarioConfig): { id: string; qty: number }[] {
  if (node.kind !== 'facility') return [];
  return product(scenario, node.productId!).inputs;
}

export function levelUpCost(node: FlowNode, scenario: ScenarioConfig): number {
  const base =
    node.kind === 'facility' ? facilityDef(scenario, node.facilityType!).buildCost : node.kind === 'supplier' ? SUPPLIER_COST : MARKET_COST;
  return Math.round(base * LEVELUP_FACTOR * node.level);
}

export function wireCapacity(w: Wire): number {
  return WIRE_BASE_RATE * 2 ** (w.level - 1);
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

// Can a wire carrying `productId` plug into `to`?
export function accepts(to: FlowNode, productId: string, scenario: ScenarioConfig): boolean {
  if (to.kind === 'market') return true;
  return nodeInputs(to, scenario).some((i) => i.id === productId);
}

export function canConnect(state: FlowState, scenario: ScenarioConfig, fromId: string, toId: string): string | null {
  if (fromId === toId) return "A node can't feed itself";
  const from = state.nodes.find((n) => n.id === fromId);
  const to = state.nodes.find((n) => n.id === toId);
  if (!from || !to) return 'Missing node';
  if (!from.productId) return 'The market has no output';
  if (!accepts(to, from.productId, scenario)) return `${to.kind === 'facility' ? facilityDef(scenario, to.facilityType!).name : 'That node'} doesn't use ${product(scenario, from.productId).name}`;
  if (state.wires.some((w) => w.from === fromId && w.to === toId)) return 'Already connected';
  if (state.cash < WIRE_COST) return `Need ${WIRE_COST}g for a wire`;
  return null;
}

export function debt(state: FlowState): number {
  return state.loans.reduce((s, l) => s + l.balance, 0) + state.arrears;
}

export function netWorth(state: FlowState, scenario: ScenarioConfig): number {
  let goods = 0;
  for (const n of state.nodes) {
    if (n.productId) goods += n.outBuf * state.market[n.productId].price;
    for (const [id, q] of Object.entries(n.inBuf)) goods += q * state.market[id].price;
  }
  const assets = state.nodes.reduce((s, n) => s + n.invested * NODE_RESALE_RATE, 0);
  void scenario;
  return Math.round(state.cash + goods + assets - debt(state));
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
  };
}

// ---------------------------------------------------------------------------
// New game
// ---------------------------------------------------------------------------

export function newFlowGame(scenario: ScenarioConfig, opts: { seed: number; sandbox?: boolean }): FlowState {
  const market: Record<string, FlowMarketEntry> = {};
  for (const p of scenario.products) market[p.id] = { price: p.basePrice, glut: 0, history: [p.basePrice] };
  const state: FlowState = {
    scenarioId: scenario.id,
    clockSec: 0,
    cycle: 0,
    cash: START_CASH,
    nodes: [],
    wires: [],
    market,
    loans: [],
    arrears: 0,
    ledger: [],
    totals: { salesG: 0, upkeepG: 0, loanPaidG: 0, suppliesG: 0 },
    goal: opts.sandbox ? null : { targetNetWorth: FLOW_GOAL_NET_WORTH, timeLimitSec: FLOW_TIME_LIMIT_SEC },
    rngState: opts.seed >>> 0,
    nextId: 1,
    outcome: null,
    wonAtSec: null,
  };
  const start = facilityDef(scenario, scenario.startingFacilityType);
  state.nodes.push(makeNode(state, 'facility', 80, 160, start.type, start.productId, start.buildCost));
  state.nodes.push(makeNode(state, 'market', 620, 160, null, null, 0));
  addLedger(state, 'Drag from the farm’s output port to the Market to start selling', 0);
  return state;
}

// ---------------------------------------------------------------------------
// The per-second tick: produce → transport → sell → settle
// ---------------------------------------------------------------------------

export function tickFlow(prev: FlowState, scenario: ScenarioConfig): FlowState {
  const state = structuredClone(prev);
  if (state.outcome) return state;
  state.clockSec += 1;

  // 1. Production.
  for (const n of state.nodes) {
    n.madeLastSec = 0;
    n.soldLastSec = 0;
    if (n.kind === 'market') continue;
    const room = BUFFER_CAP - n.outBuf;
    if (room <= 0) {
      n.status = 'blocked';
      n.accumulator = 0;
      continue;
    }
    n.accumulator += nodeRate(n, scenario);
    let want = Math.min(room, Math.floor(n.accumulator));
    if (want <= 0) {
      n.status = n.status === 'idle' ? 'running' : n.status;
      continue;
    }
    if (n.kind === 'supplier') {
      const unit = state.market[n.productId!].price * SUPPLIER_MARKUP;
      want = Math.min(want, Math.floor(state.cash / unit));
      const cost = Math.round(unit * want);
      state.cash -= cost;
      state.totals.suppliesG += cost;
    } else {
      for (const inp of nodeInputs(n, scenario)) want = Math.min(want, Math.floor((n.inBuf[inp.id] ?? 0) / inp.qty));
      for (const inp of nodeInputs(n, scenario)) n.inBuf[inp.id] = (n.inBuf[inp.id] ?? 0) - inp.qty * want;
    }
    n.outBuf += want;
    n.madeLastSec = want;
    n.accumulator -= want;
    if (want === 0) {
      n.accumulator = 0;
      n.status = 'starved';
    } else n.status = 'running';
  }

  // 2. Transport: each node pushes its output down its wires, one unit at a
  // time round-robin, so a split feeds every branch evenly.
  for (const w of state.wires) w.movedLastSec = 0;
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  for (const n of state.nodes) {
    const outs = state.wires.filter((w) => w.from === n.id);
    if (outs.length === 0 || n.outBuf <= 0) continue;
    let progress = true;
    while (n.outBuf > 0 && progress) {
      progress = false;
      for (let k = 0; k < outs.length && n.outBuf > 0; k++) {
        const w = outs[(n.rr + k) % outs.length];
        if (w.movedLastSec >= wireCapacity(w)) continue;
        const to = byId.get(w.to)!;
        if (to.kind === 'market') {
          const earned = salePrice(state, scenario, w.productId);
          state.market[w.productId].glut += 1;
          state.cash += earned;
          state.totals.salesG += earned;
          to.soldLastSec += earned;
        } else {
          if ((to.inBuf[w.productId] ?? 0) >= BUFFER_CAP) continue;
          to.inBuf[w.productId] = (to.inBuf[w.productId] ?? 0) + 1;
        }
        n.outBuf -= 1;
        w.movedLastSec += 1;
        progress = true;
      }
      n.rr = (n.rr + 1) % outs.length;
    }
  }
  for (const n of state.nodes) if (n.kind === 'market') n.status = n.soldLastSec > 0 ? 'running' : 'idle';

  // 3. The market slowly forgets a glut.
  for (const m of Object.values(state.market)) m.glut *= 1 - GLUT_DECAY;

  // 4. Settlement.
  if (state.clockSec % FLOW_SETTLE_SEC === 0) settle(state, scenario);

  // 5. Goal.
  if (state.goal && !state.outcome) {
    if (netWorth(state, scenario) >= state.goal.targetNetWorth) {
      state.outcome = 'won';
      state.wonAtSec = state.clockSec;
    } else if (state.clockSec >= state.goal.timeLimitSec) state.outcome = 'timeUp';
  }
  return state;
}

function settle(state: FlowState, scenario: ScenarioConfig) {
  state.cycle += 1;
  const upkeep = state.nodes.reduce((s, n) => s + nodeUpkeep(n, scenario), 0);
  state.cash -= upkeep;
  state.totals.upkeepG += upkeep;
  addLedger(state, 'Upkeep', -upkeep);

  if (state.arrears > 0) state.arrears = Math.round(state.arrears * (1 + ARREARS_PENALTY));
  for (const l of state.loans) {
    const pay = Math.min(l.installmentPerCycle, l.balance);
    l.balance -= pay;
    if (state.cash >= pay) {
      state.cash -= pay;
      state.totals.loanPaidG += pay;
      addLedger(state, `${l.label} loan payment`, -pay);
    } else {
      state.arrears += pay;
      addLedger(state, `Missed ${l.label} payment → arrears`, 0);
    }
  }
  state.loans = state.loans.filter((l) => l.balance > 0);

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

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export type FlowCommand =
  | { kind: 'buildFacility'; facilityType: string; x: number; y: number }
  | { kind: 'buildMarket'; x: number; y: number }
  | { kind: 'buildSupplier'; productId: string; x: number; y: number }
  | { kind: 'connect'; from: string; to: string }
  | { kind: 'removeWire'; wireId: string }
  | { kind: 'upgradeWire'; wireId: string }
  | { kind: 'levelUp'; nodeId: string }
  | { kind: 'sellNode'; nodeId: string }
  | { kind: 'takeLoan'; offerId: string }
  | { kind: 'payArrears' };

export function applyFlowCommand(prev: FlowState, cmd: FlowCommand, scenario: ScenarioConfig): FlowState {
  const state = structuredClone(prev);
  if (state.outcome) return state;
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
      state.nodes.push(makeNode(state, 'supplier', cmd.x, cmd.y, null, cmd.productId, SUPPLIER_COST));
      break;
    }
    case 'connect': {
      if (canConnect(state, scenario, cmd.from, cmd.to)) break;
      const from = state.nodes.find((n) => n.id === cmd.from)!;
      state.cash -= WIRE_COST;
      state.wires.push({ id: genId(state, 'wire'), from: cmd.from, to: cmd.to, productId: from.productId!, level: 1, movedLastSec: 0 });
      break;
    }
    case 'removeWire': {
      state.wires = state.wires.filter((w) => w.id !== cmd.wireId);
      break;
    }
    case 'upgradeWire': {
      const w = state.wires.find((x) => x.id === cmd.wireId);
      if (!w || !spend(wireUpgradeCost(w), `Upgraded a ${product(scenario, w.productId).name} line`)) break;
      w.level += 1;
      break;
    }
    case 'levelUp': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n || n.kind === 'market') break;
      const cost = levelUpCost(n, scenario);
      if (!spend(cost, `Upgraded to L${n.level + 1}`)) break;
      n.level += 1;
      n.invested += cost;
      break;
    }
    case 'sellNode': {
      const n = state.nodes.find((x) => x.id === cmd.nodeId);
      if (!n) break;
      const proceeds = Math.round(n.invested * NODE_RESALE_RATE);
      state.nodes = state.nodes.filter((x) => x.id !== n.id);
      state.wires = state.wires.filter((w) => w.from !== n.id && w.to !== n.id);
      state.cash += proceeds;
      addLedger(state, 'Sold a node', proceeds);
      break;
    }
    case 'takeLoan': {
      if (state.arrears > 0) break;
      const offer = LOAN_OFFERS.find((o) => o.id === cmd.offerId);
      if (!offer) break;
      state.cash += offer.principal;
      state.loans.push({ id: genId(state, 'loan'), label: offer.label, balance: offer.totalRepay, installmentPerCycle: offer.installmentPerCycle });
      addLedger(state, `Took ${offer.label} loan`, offer.principal);
      break;
    }
    case 'payArrears': {
      const pay = Math.min(state.arrears, state.cash);
      if (pay <= 0) break;
      state.cash -= pay;
      state.arrears -= pay;
      addLedger(state, 'Paid arrears', -pay);
      break;
    }
  }
  return state;
}

// Dragging is UI-only and fires on every pointer move, so it skips the deep clone.
export function moveNode(state: FlowState, nodeId: string, x: number, y: number): FlowState {
  return { ...state, nodes: state.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) };
}
