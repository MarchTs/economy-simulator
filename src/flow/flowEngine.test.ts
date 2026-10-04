import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/simScenarios';
import {
  applyFlowCommand,
  BUFFER_CAP,
  bufferCap,
  equity,
  FLOW_LOAN_OFFERS,
  FLOW_LOAN_TERM,
  FLOW_SETTLE_SEC,
  licenseCost,
  MONEY,
  NODE_RESALE_RATE,
  newFlowGame,
  nodeUpkeep,
  salePrice,
  START_CASH,
  STARTER_WALLET_FUND,
  SUPPLIER_UPKEEP,
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
const STARTER = FLOW_LOAN_OFFERS.find((o) => o.id === 'starter')!;
const budgetCount = (s: FlowState) => s.nodes.filter((n) => n.kind === 'budget').length;
const last = (s: FlowState) => s.nodes[s.nodes.length - 1];
// Buy a facility's license (and anything it needs first), then build it.
const build = (s: FlowState, facilityType: string, x = 300, y = 0) => {
  s = cmd(s, { kind: 'buyLicense', facilityType });
  return cmd(s, { kind: 'buildFacility', facilityType, x, y });
};

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

  it('a money wire moves everything it is given at once', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'market' ? { ...n, money: 1000 } : n)) };
    s = cmd(s, { kind: 'connect', from: market(s).id, to: budget(s).id });
    const cash = s.cash;
    s = run(s, 1);
    expect(market(s).money).toBe(0);
    expect(s.wires[0].movedLastSec).toBe(1000);
    expect(s.cash).toBe(cash + 1000);
  });

  it('money wires cannot be upgraded', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: market(s).id, to: budget(s).id });
    const cash = s.cash;
    s = cmd(s, { kind: 'upgradeWire', wireId: s.wires[0].id });
    expect(s.wires[0].level).toBe(1);
    expect(s.cash).toBe(cash);
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
    s = build(s, 'hop_yard', 0, 0);
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
    s = build(s, 'malthouse');
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
    expect(s.cash).toBe(BUDGET0); // the budget pays only for blocks it is wired into
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

  it('a wired budget pays upkeep, after any wallet', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: budget(s).id, to: farm(s).id });
    const cash = s.cash;
    s = run(s, FLOW_SETTLE_SEC);
    expect(farm(s).unpaid).toBe(0);
    expect(s.cash).toBe(cash - nodeUpkeep(farm(s), S));

    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    const cash2 = s.cash;
    const wallet2 = wallet(s).money;
    s = run(s, FLOW_SETTLE_SEC);
    expect(s.cash).toBe(cash2); // the wallet covered it
    expect(wallet(s).money).toBe(wallet2 - nodeUpkeep(farm(s), S) - nodeUpkeep(wallet(s), S));
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

  it('taking a loan pays it into the budget, and a wired budget repays it', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const b = last(s).id;
    expect(s.cash).toBe(BUDGET0 + STARTER.principal);
    expect(byId(s, b).money).toBe(0);
    expect(cmd(s, { kind: 'connect', from: b, to: budget(s).id }).wires).toHaveLength(0); // nothing to send
    s = cmd(s, { kind: 'connect', from: budget(s).id, to: b });
    const cash = s.cash;
    s = run(s, FLOW_SETTLE_SEC);
    expect(byId(s, b).loan!.balance).toBe(STARTER.totalRepay - STARTER.installmentPerCycle);
    expect(byId(s, b).loan!.arrears).toBe(0);
    expect(s.cash).toBe(cash - STARTER.installmentPerCycle);
  });

  it('paying a loan in full clears it, arrears and all, and needs the money', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const b = last(s).id;
    s = run(s, FLOW_SETTLE_SEC); // nothing repays it: one installment falls into arrears
    expect(byId(s, b).loan!.arrears).toBe(STARTER.installmentPerCycle);
    const owed = byId(s, b).loan!.balance + byId(s, b).loan!.arrears;
    expect(owed).toBe(STARTER.totalRepay);
    const poor = cmd({ ...s, cash: owed - 1 }, { kind: 'payOffLoan', nodeId: b });
    expect(poor.nodes.some((n) => n.id === b)).toBe(true); // refused
    const cash = s.cash;
    s = cmd(s, { kind: 'payOffLoan', nodeId: b });
    expect(s.nodes.some((n) => n.id === b)).toBe(false);
    expect(s.cash).toBe(cash - owed);
  });

  it('loans are repaid over twenty bills, costing what the classic game charges', () => {
    expect(FLOW_LOAN_TERM).toBe(20);
    expect(STARTER).toMatchObject({ principal: 500, installmentPerCycle: 30, termCycles: 20, totalRepay: 600 });
  });

  it('a loan nothing repays falls into arrears and blocks new loans', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    const b = s.nodes[s.nodes.length - 1].id;
    s = run(s, FLOW_SETTLE_SEC);
    expect(byId(s, b).loan!.arrears).toBe(STARTER.installmentPerCycle);
    const count = s.nodes.length;
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    expect(s.nodes.length).toBe(count);
    s = cmd(s, { kind: 'payArrears', nodeId: b });
    expect(byId(s, b).loan!.arrears).toBe(0);
  });
});

describe('levels and demand', () => {
  it('an upgraded facility works in bigger batches and holds more', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 100_000 };
    s = build(s, 'malthouse');
    const mh = s.nodes[s.nodes.length - 1].id;
    s = cmd(s, { kind: 'connect', from: budget(s).id, to: mh });
    s = cmd(s, { kind: 'levelUp', nodeId: mh });
    // Hand it exactly three units of barley: an L2 batch needs four, so nothing is made.
    s = { ...s, nodes: s.nodes.map((n) => (n.id === mh ? { ...n, inBuf: { barley: 3 } } : n)) };
    s = run(s, 3);
    expect(byId(s, mh).outBuf).toBe(0);
    s = { ...s, nodes: s.nodes.map((n) => (n.id === mh ? { ...n, inBuf: { barley: 4 } } : n)) };
    s = run(s, 2);
    expect(byId(s, mh).inBuf.barley).toBe(0);
    expect(byId(s, mh).outBuf).toBe(2);
    expect(bufferCap(byId(s, mh))).toBe(2 * BUFFER_CAP); // a bigger batch always fits
  });

  it('a supplier buys at the demand it is set to, and pays upkeep for it', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'buildSupplier', productId: 'hops', x: 0, y: 300 });
    const sup = s.nodes[s.nodes.length - 1].id;
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: sup });
    s = cmd(s, { kind: 'setDemand', nodeId: sup, demand: 3 });
    expect(nodeUpkeep(byId(s, sup), S)).toBe(3 * SUPPLIER_UPKEEP);
    s = { ...s, nodes: s.nodes.map((n) => (n.id === wallet(s).id ? { ...n, money: 10_000 } : n)) };
    s = run(s, 1);
    expect(byId(s, sup).madeLastSec).toBe(3);
    s = cmd(s, { kind: 'levelUp', nodeId: sup });
    expect(byId(s, sup).level).toBe(1); // demand replaces upgrades
    s = cmd(s, { kind: 'setDemand', nodeId: sup, demand: 0 });
    s = run(s, 1);
    expect(byId(s, sup).status).toBe('idle');
    expect(nodeUpkeep(byId(s, sup), S)).toBe(0);
  });
});

describe('budget blocks', () => {
  it('any number of budget blocks share one balance, and the last one stays', () => {
    let s = newFlowGame(S, { seed: 1 });
    const cash = s.cash;
    s = cmd(s, { kind: 'buildBudget', x: 0, y: 0 });
    s = cmd(s, { kind: 'buildBudget', x: 0, y: 0 });
    expect(budgetCount(s)).toBe(3);
    expect(s.cash).toBe(cash); // free to place
    const extra = s.nodes[s.nodes.length - 1].id;
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'market' ? { ...n, money: 100 } : n)) };
    s = cmd(s, { kind: 'connect', from: market(s).id, to: extra });
    s = run(s, 1);
    expect(s.cash).toBe(cash - WIRE_COST + 100); // collected by any block, lands in the one balance
    for (const n of s.nodes.filter((x) => x.kind === 'budget')) s = cmd(s, { kind: 'sellNode', nodeId: n.id });
    expect(budgetCount(s)).toBe(1);
  });
});

describe('equity and bankruptcy', () => {
  it('equity is money, goods and resale value, less debt', () => {
    let s = newFlowGame(S, { seed: 1 });
    const goods = 7 * s.market.barley.price;
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'facility' ? { ...n, outBuf: 7 } : n.kind === 'market' ? { ...n, money: 40 } : n)) };
    const resale = s.nodes.reduce((a, n) => a + n.invested * NODE_RESALE_RATE, 0);
    expect(equity(s)).toBeCloseTo(BUDGET0 + STARTER_WALLET_FUND + 40 + goods + resale, 6);
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter', x: 0, y: 0 });
    expect(equity(s)).toBeCloseTo(BUDGET0 + STARTER_WALLET_FUND + 40 + goods + resale + STARTER.principal - STARTER.totalRepay, 6);
  });

  it('one bill below zero is a warning, and recovering clears it', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'empire', x: 0, y: 0 });
    s = { ...s, cash: 0 };
    s = run(s, FLOW_SETTLE_SEC);
    expect(equity(s)).toBeLessThan(0);
    expect(s.insolvent).toBe(true);
    expect(s.bankruptcy).toBeNull();
    s = { ...s, cash: 20_000 };
    s = run(s, FLOW_SETTLE_SEC);
    expect(s.insolvent).toBe(false);
    expect(s.bankruptcy).toBeNull();
  });

  it('a second bill below zero liquidates, keeping the cheapest farm and market', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 100_000 };
    s = build(s, 'malthouse');
    s = cmd(s, { kind: 'buildFacility', facilityType: 'farm', x: 300, y: 300 });
    s = cmd(s, { kind: 'buildMarket', x: 600, y: 300 });
    const starterFarm = farm(s).id;
    const starterMarket = market(s).id; // cost nothing, so it is the cheapest
    s = cmd(s, { kind: 'takeLoan', offerId: 'empire', x: 0, y: 0 });
    s = { ...s, cash: 0 };
    s = run(s, 2 * FLOW_SETTLE_SEC);
    expect(s.bankruptcy).not.toBeNull();
    expect(s.bankruptcy!.sold).toEqual(['Malthouse', 'Barley Farm', 'Market']); // most valuable first
    expect(s.bankruptcy!.forgivenG).toBeGreaterThan(0);
    expect(s.nodes.some((n) => n.kind === 'borrower')).toBe(false);
    expect(s.nodes.filter((n) => n.kind !== 'budget').map((n) => n.id).sort()).toEqual([starterFarm, starterMarket, wallet(s).id].sort());
    expect(wallet(s).money).toBe(STARTER_WALLET_FUND);
    expect(s.insolvent).toBe(false);
    expect(equity(s)).toBeGreaterThanOrEqual(0);
  });
});

describe('distribution', () => {
  // A farm (1.2/s, less than one wire carries) wired to two markets, both paid by the budget.
  const twoMarkets = () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 100_000 };
    s = cmd(s, { kind: 'buildMarket', x: 600, y: 400 });
    const m2 = last(s).id;
    for (const id of [farm(s).id, market(s).id, m2]) s = cmd(s, { kind: 'connect', from: budget(s).id, to: id });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: market(s).id });
    s = cmd(s, { kind: 'connect', from: farm(s).id, to: m2 });
    return s;
  };
  const moved = (s: FlowState, secs: number) => {
    const tot = [0, 0];
    for (let i = 0; i < secs; i++) {
      s = run(s, 1);
      s.wires.filter((w) => w.from === farm(s).id).forEach((w, k) => (tot[k] += w.movedLastSec));
    }
    return tot;
  };

  it('balance splits evenly; priority fills the top wire first', () => {
    const [a, b] = moved(twoMarkets(), 40);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    let s = twoMarkets();
    s = cmd(s, { kind: 'setDistribution', nodeId: farm(s).id, mode: 'priority' });
    const [top, bottom] = moved(s, 40);
    expect(top).toBeGreaterThan(40);
    expect(bottom).toBe(0);
  });

  it('a switched-off wire carries nothing, and moving a wire changes the order', () => {
    let s = twoMarkets();
    s = cmd(s, { kind: 'setDistribution', nodeId: farm(s).id, mode: 'priority' });
    const [w1, w2] = s.wires.filter((w) => w.from === farm(s).id);
    s = cmd(s, { kind: 'toggleWire', wireId: w1.id });
    expect(moved(s, 20)[0]).toBe(0);
    s = cmd(s, { kind: 'toggleWire', wireId: w1.id });
    s = cmd(s, { kind: 'moveWire', wireId: w1.id, dir: 1 });
    expect(s.wires.filter((w) => w.from === farm(s).id).map((w) => w.id)).toEqual([w2.id, w1.id]);
  });

  it('a switched-off payment link pays nothing', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    s = cmd(s, { kind: 'toggleWire', wireId: s.wires[0].id });
    s = run(s, FLOW_SETTLE_SEC);
    expect(farm(s).status).toBe('unpaid');
  });

  it('a short wallet pays its blocks top to bottom', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: market(s).id });
    s = cmd(s, { kind: 'connect', from: wallet(s).id, to: farm(s).id });
    // Enough for the wallet's own upkeep and one block, not both.
    const own = nodeUpkeep(wallet(s), S);
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'wallet' ? { ...n, money: own + nodeUpkeep(market(s), S) } : n)) };
    let t = run(s, FLOW_SETTLE_SEC);
    expect(market(t).unpaid).toBe(0);
    expect(farm(t).status).toBe('unpaid');
    s = cmd(s, { kind: 'moveWire', wireId: s.wires[1].id, dir: -1 }); // farm to the top
    s = { ...s, nodes: s.nodes.map((n) => (n.kind === 'wallet' ? { ...n, money: own + nodeUpkeep(farm(s), S) } : n)) };
    t = run(s, FLOW_SETTLE_SEC);
    expect(farm(t).unpaid).toBe(0);
    expect(market(t).status).toBe('unpaid');
  });
});

describe('licenses', () => {
  it('a facility cannot be built until its license is bought', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 100_000 };
    const count = s.nodes.length;
    s = cmd(s, { kind: 'buildFacility', facilityType: 'hop_yard', x: 0, y: 0 });
    expect(s.nodes.length).toBe(count);
    const cash = s.cash;
    s = cmd(s, { kind: 'buyLicense', facilityType: 'hop_yard' });
    expect(s.cash).toBe(cash - licenseCost(S, 'hop_yard'));
    s = cmd(s, { kind: 'buildFacility', facilityType: 'hop_yard', x: 0, y: 0 });
    expect(s.nodes.length).toBe(count + 1);
  });

  it('a license needs the licenses of its inputs first, and the money', () => {
    let s = newFlowGame(S, { seed: 1 });
    s = { ...s, cash: 100_000 };
    s = cmd(s, { kind: 'buyLicense', facilityType: 'brewery' }); // needs Malthouse and Hop Yard
    expect(s.licenses).not.toContain('brewery');
    s = cmd(s, { kind: 'buyLicense', facilityType: 'malthouse' });
    s = cmd(s, { kind: 'buyLicense', facilityType: 'hop_yard' });
    s = cmd({ ...s, cash: licenseCost(S, 'brewery') - 1 }, { kind: 'buyLicense', facilityType: 'brewery' });
    expect(s.licenses).not.toContain('brewery');
    s = cmd({ ...s, cash: licenseCost(S, 'brewery') }, { kind: 'buyLicense', facilityType: 'brewery' });
    expect(s.licenses).toContain('brewery');
    expect(s.cash).toBe(0);
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
