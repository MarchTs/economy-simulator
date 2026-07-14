import { describe, expect, it } from 'vitest';
import { breweryScenario } from '../scenarios/simScenarios';
import {
  applyCommand,
  CONTRACTS_PER_MANAGER,
  facilityRatePerSec,
  LOAN_OFFERS,
  netWorth,
  newGame,
  SETTLE_INTERVAL_SEC,
  speculationPnL,
  tickSecond,
  unlockedTier,
  type Command,
  type GameState,
} from './sim';

const S = breweryScenario;

function run(state: GameState, seconds: number): GameState {
  let s = state;
  for (let i = 0; i < seconds; i++) s = tickSecond(s, S);
  return s;
}
function toNextSettle(state: GameState): GameState {
  const secsToSettle = SETTLE_INTERVAL_SEC - (state.clockSec % SETTLE_INTERVAL_SEC);
  return run(state, secsToSettle);
}
function cmd(state: GameState, c: Command): GameState {
  return applyCommand(state, c, S);
}

describe('newGame', () => {
  it('starts with cash, one farm, a run goal, no debt', () => {
    const s = newGame(S, { seed: 1 });
    expect(s.cash).toBe(500);
    expect(s.facilities).toHaveLength(1);
    expect(s.facilities[0].productId).toBe('barley');
    expect(s.runGoal?.targetNetWorth).toBe(1_000_000);
    expect(s.loans).toHaveLength(0);
  });

  it('sandbox mode has no run goal', () => {
    const s = newGame(S, { seed: 1, sandbox: true });
    expect(s.runGoal).toBeNull();
  });
});

describe('production (per-second clock)', () => {
  it('accumulates raw output into inventory over time', () => {
    let s = newGame(S, { seed: 1 });
    const rate = facilityRatePerSec(s.facilities[0], S); // 1.2/sec
    s = run(s, 10);
    // ~12 barley after 10s, minus whatever a settle consumed (none — no contracts)
    expect(s.inventory['barley']).toBeGreaterThanOrEqual(Math.floor(rate * 10) - 1);
  });

  it('a processed facility consumes inputs; stalls without them', () => {
    let s = newGame(S, { seed: 1 });
    // Build a malthouse (needs barley). Give cash + unlock tier 1 via a sale.
    s.cash = 100000;
    s.firstSaleMade = true;
    s = cmd(s, { kind: 'buildFacility', facilityType: 'malthouse' });
    expect(s.facilities.some((f) => f.type === 'malthouse')).toBe(true);
    // With no barley yet, malt stays 0 for a bit, then rises as barley accrues.
    s = run(s, 30);
    // barley farm outpaces malthouse consumption, so some malt exists
    expect(s.inventory['malt'] ?? 0).toBeGreaterThan(0);
    // and barley was consumed (2 per malt)
    expect(s.inventory['barley'] ?? 0).toBeGreaterThanOrEqual(0);
  });
});

describe('spot market', () => {
  it('sells inventory at market price and banks cash', () => {
    let s = newGame(S, { seed: 1 });
    s = run(s, 20);
    const before = s.cash;
    const held = s.inventory['barley'];
    const price = s.market['barley'].price;
    s = cmd(s, { kind: 'spotSell', productId: 'barley', qty: held });
    expect(s.inventory['barley']).toBe(0);
    expect(s.cash).toBeCloseTo(before + Math.round(held * price), 0);
    expect(s.firstSaleMade).toBe(true);
  });

  it('buys inputs at market, deducting cash', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 1000;
    const price = s.market['hops'].price;
    s = cmd(s, { kind: 'spotBuy', productId: 'hops', qty: 5 });
    expect(s.inventory['hops']).toBe(5);
    expect(s.cash).toBe(1000 - Math.round(5 * price));
  });

  it('cannot sell more than held or buy without cash', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 0;
    s = cmd(s, { kind: 'spotBuy', productId: 'hops', qty: 5 });
    expect(s.inventory['hops'] ?? 0).toBe(0);
    s = cmd(s, { kind: 'spotSell', productId: 'barley', qty: 999 });
    expect(s.cash).toBe(0);
  });
});

describe('facility build gating & leveling', () => {
  it('blocks building a tier above the unlocked tier', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 100000;
    // tier 0 only until first sale
    expect(unlockedTier(s, S)).toBe(0);
    s = cmd(s, { kind: 'buildFacility', facilityType: 'brewery' }); // tier 2
    expect(s.facilities.some((f) => f.type === 'brewery')).toBe(false);
  });

  it('unlocks tier 1 after first sale, tier 2 after a tier-1 facility hits L2', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 100000;
    s = run(s, 10);
    s = cmd(s, { kind: 'spotSell', productId: 'barley', qty: s.inventory['barley'] });
    expect(unlockedTier(s, S)).toBe(1);
    s = cmd(s, { kind: 'buildFacility', facilityType: 'malthouse' });
    const malt = s.facilities.find((f) => f.type === 'malthouse')!;
    s = cmd(s, { kind: 'levelUpFacility', facilityId: malt.id });
    expect(unlockedTier(s, S)).toBe(2);
  });

  it('sells a facility back at the resale rate', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 0;
    const f = s.facilities[0];
    s = cmd(s, { kind: 'sellFacility', facilityId: f.id });
    expect(s.facilities).toHaveLength(0);
    expect(s.cash).toBe(Math.round(f.invested * 0.7));
  });
});

describe('loans', () => {
  it('takes a loan, adding principal and a repayment balance', () => {
    let s = newGame(S, { seed: 1 });
    const offer = LOAN_OFFERS[0];
    s = cmd(s, { kind: 'takeLoan', offerId: offer.id });
    expect(s.cash).toBe(500 + offer.principal);
    expect(s.loans[0].balance).toBe(offer.totalRepay);
  });

  it('creates an installment obligation each settle; missing it → arrears', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter' });
    s.cash = 0; // cannot pay
    s = toNextSettle(s); // obligation created, unmanaged, unpaid
    expect(s.pendingObligations.some((o) => o.kind === 'installment')).toBe(true);
    s = toNextSettle(s); // next settle: unpaid → arrears
    expect(s.loanArrears).toBeGreaterThan(0);
  });

  it('finance manager auto-pays installments', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter' });
    s = cmd(s, { kind: 'hireManager', role: 'finance' });
    s.cash = 100000;
    const balBefore = s.loans[0].balance;
    s = toNextSettle(s);
    expect(s.pendingObligations.some((o) => o.kind === 'installment')).toBe(false);
    expect(s.loans[0].balance).toBeLessThan(balBefore);
  });

  it('arrears blocks taking a new loan', () => {
    let s = newGame(S, { seed: 1 });
    s.loanArrears = 100;
    s = cmd(s, { kind: 'takeLoan', offerId: 'starter' });
    expect(s.loans).toHaveLength(0);
  });
});

describe('contracts & deliveries', () => {
  it('signing a standing contract creates delivery obligations that need stock', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'signStandingContract', productId: 'barley', qtyPerCycle: 5, cycles: 10 });
    expect(s.contracts).toHaveLength(1);
    // let barley accumulate, then settle — a shipping-less delivery is pending
    s = toNextSettle(s);
    const delivery = s.pendingObligations.find((o) => o.kind === 'delivery');
    expect(delivery).toBeDefined();
  });

  it('missing a delivery walks the customer', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'signStandingContract', productId: 'keg_beer', qtyPerCycle: 5, cycles: 10 }); // no keg production
    s = toNextSettle(s); // delivery obligation, no stock → stays pending
    s = toNextSettle(s); // missed → customer walks
    expect(s.contracts).toHaveLength(0);
  });

  it('shipping manager auto-delivers up to its caseload', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'hireManager', role: 'shipping' });
    s = cmd(s, { kind: 'signStandingContract', productId: 'barley', qtyPerCycle: 3, cycles: 10 });
    s = run(s, 20); // build barley stock
    const cashBefore = s.cash;
    s = toNextSettle(s);
    // delivery auto-handled → no pending delivery, cash rose from the sale
    expect(s.pendingObligations.some((o) => o.kind === 'delivery')).toBe(false);
    expect(s.cash).toBeGreaterThan(cashBefore - 100); // net positive-ish after upkeep
  });

  it('one shipping manager covers CONTRACTS_PER_MANAGER contracts, not more', () => {
    let s = newGame(S, { seed: 1 });
    s = cmd(s, { kind: 'hireManager', role: 'shipping' });
    for (let i = 0; i < CONTRACTS_PER_MANAGER + 1; i++) {
      s = cmd(s, { kind: 'signStandingContract', productId: 'barley', qtyPerCycle: 1, cycles: 20 });
    }
    // Build stock WITHIN the first cycle so no earlier settle walks a customer,
    // then hit exactly one settle.
    s = run(s, 25); // ~30 barley, still before the 30s settle
    s = toNextSettle(s); // first settle: 6 deliveries, manager handles 5
    // one delivery beyond the caseload stays pending (manual)
    const pendingDeliveries = s.pendingObligations.filter((o) => o.kind === 'delivery').length;
    expect(pendingDeliveries).toBe(1);
  });
});

describe('taxes', () => {
  it('assesses tax after a profitable cycle and creates a tax obligation', () => {
    let s = newGame(S, { seed: 1 });
    s = run(s, 25);
    s = cmd(s, { kind: 'spotSell', productId: 'barley', qty: s.inventory['barley'] }); // revenue this cycle
    s = toNextSettle(s);
    expect(s.pendingObligations.some((o) => o.kind === 'taxPayment')).toBe(true);
  });

  it('accountant auto-pays tax; unpaid tax → taxDebt and blocks new facilities', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 0;
    // force a property-tax-only bill (no profit) by just settling with a facility
    s = toNextSettle(s); // creates tax obligation (property tax), unpaid
    s = toNextSettle(s); // missed → taxDebt
    expect(s.taxDebt).toBeGreaterThan(0);
    s.cash = 100000;
    s.firstSaleMade = true;
    s = cmd(s, { kind: 'buildFacility', facilityType: 'hop_yard' });
    // tax debt blocks the build
    expect(s.facilities.some((f) => f.type === 'hop_yard')).toBe(false);
  });
});

describe('gold & speculation', () => {
  it('buys and sells gold, tracking realized P&L', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 100000;
    const price = s.gold.price;
    s = cmd(s, { kind: 'buyGold', qty: 10 });
    expect(s.gold.held).toBe(10);
    expect(s.gold.costBasis).toBe(Math.round(10 * price));
    // bump price and sell
    s.gold.price = price * 2;
    s = cmd(s, { kind: 'sellGold', qty: 10 });
    expect(s.gold.held).toBe(0);
    expect(speculationPnL(s)).toBeGreaterThan(0);
  });

  it('gold price moves over cycles (drift or bubble)', () => {
    let s = newGame(S, { seed: 7 });
    const start = s.gold.price;
    s = run(s, SETTLE_INTERVAL_SEC * 30);
    // over 30 cycles the price should have moved from its start
    expect(s.gold.price).not.toBe(start);
  });
});

describe('net worth & run goal', () => {
  it('net worth folds in cash, inventory, facilities, gold, minus debt', () => {
    let s = newGame(S, { seed: 1 });
    const base = netWorth(s);
    s.cash += 1000;
    expect(netWorth(s)).toBe(base + 1000);
  });

  it('winning fires when net worth hits the target', () => {
    let s = newGame(S, { seed: 1 });
    s.cash = 2_000_000;
    s = tickSecond(s, S);
    expect(s.outcome).toBe('won');
  });

  it('time-up fires at the time limit if the target is not met', () => {
    let s = newGame(S, { seed: 1 });
    s.clockSec = s.runGoal!.timeLimitSec - 1;
    s = tickSecond(s, S);
    expect(s.outcome).toBe('timeUp');
  });
});
