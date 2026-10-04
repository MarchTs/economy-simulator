import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/simScenarios';
import {
  applyFlowCommand,
  BUFFER_CAP,
  FLOW_SETTLE_SEC,
  newFlowGame,
  salePrice,
  START_CASH,
  tickFlow,
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

describe('new flow game', () => {
  it('starts with a farm, a market, no wires', () => {
    const s = newFlowGame(S, { seed: 1 });
    expect(s.cash).toBe(START_CASH);
    expect(s.nodes.map((n) => n.kind)).toEqual(['facility', 'market']);
    expect(s.wires).toHaveLength(0);
  });
});

describe('flow', () => {
  it('an unwired farm fills its output buffer then blocks', () => {
    const s = run(newFlowGame(S, { seed: 1 }), 20);
    expect(farm(s).outBuf).toBe(BUFFER_CAP);
    expect(farm(s).status).toBe('blocked');
    expect(s.cash).toBe(START_CASH);
  });

  it('wiring the farm to the market turns barley into cash', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    expect(s.wires).toHaveLength(1);
    expect(s.cash).toBe(START_CASH - WIRE_COST);
    s = run(s, 10);
    expect(s.cash).toBeGreaterThan(START_CASH - WIRE_COST);
    expect(s.totals.salesG).toBeGreaterThan(0);
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

describe('settlement + money', () => {
  it('charges upkeep every cycle', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = run(s, FLOW_SETTLE_SEC);
    expect(s.totals.upkeepG).toBeGreaterThan(0);
    expect(s.cash).toBeLessThan(START_CASH);
  });

  it('a supplier buys goods with cash and emits them', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'buildSupplier', productId: 'hops', x: 0, y: 300 });
    s = run(s, 3);
    const sup = s.nodes.find((n) => n.kind === 'supplier')!;
    expect(sup.outBuf).toBeGreaterThan(0);
    expect(s.totals.suppliesG).toBeGreaterThan(0);
  });

  it('missed loan payments become arrears', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter' });
    s = { ...s, cash: 0 };
    s = run(s, FLOW_SETTLE_SEC);
    expect(s.arrears).toBeGreaterThan(0);
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
