import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/simScenarios';
import {
  applyFlowCommand,
  BUFFER_CAP,
  FLOW_SETTLE_SEC,
  MONEY,
  MONEY_WIRE_RATE,
  newFlowGame,
  nodeUpkeep,
  salePrice,
  START_CASH,
  STARTER_WALLET_FUND,
  tickFlow,
  WALLET_COST,
  WIRE_BASE_RATE,
  WIRE_COST,
  type FlowCommand,
  type FlowState,
} from './flowEngine';

const S = breweryScenario;
const run = (s: FlowState, secs: number) => {
  for (let i = 0; i < secs; i++) s = tickFlow(s, S);
  return s;
};
const cmd = (s: FlowState, c: FlowCommand) => applyFlowCommand(s, c, S);
const farm = (s: FlowState) => s.nodes.find((n) => n.productId === 'barley')!;
const market = (s: FlowState) => s.nodes.find((n) => n.kind === 'market')!;
const wallet = (s: FlowState) => s.nodes.find((n) => n.kind === 'wallet')!;
const budget = (s: FlowState) => s.nodes.find((n) => n.kind === 'budget')!;
const byId = (s: FlowState, id: string) => s.nodes.find((n) => n.id === id)!;
const BUDGET0 = START_CASH - STARTER_WALLET_FUND;

describe('new flow game', () => {
  it('starts with a farm, a market, a funded wallet, the budget and no wires', () => {
    const s = newFlowGame(S, { seed: 1 });
    expect(s.nodes.map((n) => n.kind)).toEqual(['facility', 'market', 'wallet', 'budget']);
    expect(s.cash).toBe(BUDGET0);
    expect(wallet(s).money).toBe(STARTER_WALLET_FUND);
    expect(s.wires).toHaveLength(0);
  });
});

describe('flow', () => {
  it('an unwired farm fills its output buffer then blocks', () => {
    const s = run(newFlowGame(S, { seed: 1 }), 20);
    expect(farm(s).outBuf).toBe(BUFFER_CAP);
    expect(farm(s).status).toBe('blocked');
    expect(s.cash).toBe(BUDGET0);
  });

  it('a market holds its takings until a money wire collects them into the budget', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    expect(s.cash).toBe(BUDGET0 - WIRE_COST);
    s = run(s, 10);
    expect(s.totals.salesG).toBeGreaterThan(0);
    expect(market(s).money).toBeCloseTo(s.totals.salesG, 6);
    expect(s.cash).toBe(BUDGET0 - WIRE_COST);
    s = cmd(s, { kind: 'connect', from: market(s).id, to: budget(s).id });
    expect(s.wires[1].productId).toBe(MONEY);
    s = run(s, 3);
    expect(market(s).money).toBeLessThan(5);
    expect(s.cash).toBeGreaterThan(BUDGET0 - 2 * WIRE_COST + s.totals.salesG - 5);
  });

  it('a money wire caps how much gold it moves per second', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'market' ? { ...n, money: 1000 } : n)) };
    s = cmd(s, { kind: 'connect', from: market(s).id, to: budget(s).id });
    const cash = s.cash;
    s = run(s, 1);
    expect(s.wires[0].movedLastSec).toBeCloseTo(MONEY_WIRE_RATE, 6);
    expect(s.cash).toBeCloseTo(cash + MONEY_WIRE_RATE, 6);
  });

  it('wire capacity caps throughput per second', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = run(s, 10); // farm buffer full
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    s = run(s, 1);
    expect(s.wires[0].movedLastSec).toBe(WIRE_BASE_RATE);
    s = cmd(s, { kind: 'upgradeWire', wireId: s.wires[0].id });
    s = run(s, 1);
    expect(s.wires[0].movedLastSec).toBe(WIRE_BASE_RATE * 2);
  });

  it('rejects wires to nodes that cannot use the good', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 10_000 };
    s = cmd(s, { kind: 'buildFacility', facilityType: 'hop_yard', x: 0, y: 0 });
    const hops = s.nodes.find((n) => n.productId === 'hops')!;
    const before = s.wires.length;
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: hops.id });
    expect(s.wires.length).toBe(before);
  });

  it('keeps goods and money on their own wires', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 10_000 };
    s = cmd(s, { kind: 'buildWallet', fund: 0, x: 0, y: 0 });
    const w2 = s.nodes[s.nodes.length - 1];
    const tryWire = (from: string, to: string) => cmd(s, { kind: 'connect', from, to }).wires.length;
    expect(tryWire(farm(s).id, wallet(s).id)).toBe(0); // goods into a wallet
    expect(tryWire(budget(s).id, wallet(s).id)).toBe(0); // the budget never drains into a wallet
    expect(tryWire(wallet(s).id, w2.id)).toBe(0); // wallet to wallet
    expect(tryWire(market(s).id, farm(s).id)).toBe(0); // takings can't pay upkeep directly
    expect(tryWire(wallet(s).id, farm(s).id)).toBe(1); // a wallet pays a block's upkeep
    expect(tryWire(wallet(s).id, budget(s).id)).toBe(1); // a wallet sweeps into the budget
  });

  it('a processor consumes wired inputs and starves without them', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 10_000 };
    s = cmd(s, { kind: 'buildFacility', facilityType: 'malthouse', x: 300, y: 0 });
    const malt = s.nodes.find((n) => n.productId === 'malt')!;
    s = run(s, 3);
    expect(s.nodes.find((n) => n.id === malt.id)!.status).toBe('starved');
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: malt.id });
    s = run(s, 15);
    const m = s.nodes.find((n) => n.id === malt.id)!;
    expect(m.outBuf).toBeGreaterThan(0);
  });

  it('a split output feeds both branches evenly', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 10_000 };
    s = cmd(s, { kind: 'buildMarket', x: 600, y: 400 });
    const m2 = s.nodes[s.nodes.length - 1];
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: m2.id });
    s = run(s, 10); // buffer fills faster than... no: 1.2/s < 4/s total capacity
    const total = s.wires.reduce((a, w) => a + w.movedLastSec, 0);
    expect(total).toBeLessThanOrEqual(2);
    let moved = [0, 0];
    for (let i = 0; i < 20; i++) {
      s = run(s, 1);
      moved = moved.map((v, k) => v + s.wires[k].movedLastSec);
    }
    expect(Math.abs(moved[0] - moved[1])).toBeLessThanOrEqual(1);
  });
});

describe('market saturation', () => {
  it('flooding a product lowers what it sells for, then recovers', () => {
    let s = newFlowGame(S, { seed: 1 });
    const fresh = salePrice(s, S, 'barley');
    s = { ...s, market: { ...s.market, barley: { ...s.market.barley, glut: 60 } } };
    expect(salePrice(s, S, 'barley')).toBeCloseTo(fresh / 2, 5);
    s = run(s, 60);
    expect(salePrice(s, S, 'barley')).toBeGreaterThan(fresh * 0.9);
  });
});

describe('upkeep', () => {
  it('a block nobody pays for stops at the bill', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = run(s, FLOW_SETTLE_SEC);
    expect(farm(s).unpaid).toBe(nodeUpkeep(farm(s), S));
    expect(farm(s).status).toBe('unpaid');
    s = run(s, 1);
    expect(farm(s).madeLastSec).toBe(0);
    expect(s.cash).toBe(BUDGET0); // the budget never pays upkeep
  });

  it('a wired wallet pays the upkeep, and pays its own', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    s = run(s, FLOW_SETTLE_SEC);
    expect(farm(s).unpaid).toBe(0);
    expect(farm(s).status).not.toBe('unpaid');
    expect(wallet(s).money).toBe(STARTER_WALLET_FUND - nodeUpkeep(farm(s), S) - nodeUpkeep(wallet(s), S));
  });

  it('a stopped block restarts once its wallet has money again', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    s = cmd(s, { kind: 'transferMoney', nodeId: wallet(s).id, amount: -STARTER_WALLET_FUND });
    expect(wallet(s).money).toBe(0);
    s = run(s, FLOW_SETTLE_SEC);
    expect(farm(s).status).toBe('unpaid');
    s = cmd(s, { kind: 'transferMoney', nodeId: wallet(s).id, amount: 50 });
    s = run(s, 2);
    expect(farm(s).unpaid).toBe(0);
    expect(farm(s).status).not.toBe('unpaid');
  });

  it('a wallet sweeping into the budget keeps back its next bill', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: budget(s).id });
    s = run(s, 10);
    expect(wallet(s).money).toBe(nodeUpkeep(farm(s), S) + nodeUpkeep(wallet(s), S));
  });
});

describe('wallets and loans', () => {
  it('opening a wallet funds it from the budget', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'buildWallet', fund: 150, x: 0, y: 0 });
    expect(s.nodes[s.nodes.length - 1].money).toBe(150);
    expect(s.cash).toBe(BUDGET0 - WALLET_COST - 150);
  });

  it('transfers never overdraw either side', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'transferMoney', nodeId: wallet(s).id, amount: 1_000_000 });
    expect(s.cash).toBe(0);
    expect(wallet(s).money).toBe(START_CASH);
    s = cmd(s, { kind: 'transferMoney', nodeId: wallet(s).id, amount: -1_000_000 });
    expect(wallet(s).money).toBe(0);
    expect(s.cash).toBe(START_CASH);
  });

  it('a supplier buys stock with its wallet’s money', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'buildSupplier', productId: 'hops', x: 0, y: 300 });
    const sup = s.nodes[s.nodes.length - 1].id;
    s = run(s, 2);
    expect(byId(s, sup).outBuf).toBe(0); // no wallet, no stock
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: sup });
    const cash = s.cash;
    s = run(s, 3);
    expect(byId(s, sup).outBuf).toBeGreaterThan(0);
    expect(wallet(s).money).toBeLessThan(STARTER_WALLET_FUND);
    expect(s.cash).toBe(cash);
  });

  it('a borrower sends its principal down a wire and collects installments', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const b = s.nodes[s.nodes.length - 1].id;
    expect(byId(s, b).money).toBe(500);
    s = cmd(s, { kind: 'connect', from: b, to: budget(s).id });
    s = cmd(s, { kind: 'connect', from: budget(s).id, to: b });
    const cash = s.cash;
    s = run(s, FLOW_SETTLE_SEC);
    expect(byId(s, b).money).toBe(0);
    expect(byId(s, b).loan!.balance).toBe(600 - 15);
    expect(byId(s, b).loan!.arrears).toBe(0);
    expect(s.cash).toBe(cash + 500 - 15);
  });

  it('a loan nothing repays falls into arrears and blocks new loans', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const b = s.nodes[s.nodes.length - 1].id;
    s = run(s, FLOW_SETTLE_SEC);
    expect(byId(s, b).loan!.arrears).toBe(15);
    const count = s.nodes.length;
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    expect(s.nodes.length).toBe(count);
    s = cmd(s, { kind: 'payArrears', nodeId: b });
    expect(byId(s, b).loan!.arrears).toBe(0);
  });
});

describe('selling', () => {
  it('the budget and loans cannot be sold', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const count = s.nodes.length;
    s = cmd(s, { kind: 'sellNode', nodeId: budget(s).id });
    s = cmd(s, { kind: 'sellNode', nodeId: s.nodes[s.nodes.length - 1].id });
    expect(s.nodes.length).toBe(count);
  });

  it('selling a wallet returns its balance to the budget', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'sellNode', nodeId: wallet(s).id });
    expect(s.cash).toBe(START_CASH);
  });

  it('selling a node refunds part of it and drops its wires', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    const cash = s.cash;
    s = cmd(s, { kind: 'sellNode', nodeId: farm(s).id });
    expect(s.wires).toHaveLength(0);
    expect(s.cash).toBeGreaterThan(cash);
  });
});
