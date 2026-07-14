import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  applyCommand,
  CONTRACTS_PER_MANAGER,
  facilityRatePerSec,
  facilityTypeDef,
  facilityUpkeep,
  goldValue,
  levelUpCost,
  LOAN_OFFERS,
  managerSalaryTotal,
  netWorth,
  newGame,
  productById,
  SETTLE_INTERVAL_SEC,
  speculationPnL,
  tickSecond,
  unlockedTier,
  upkeepTotal,
  ACCOUNTANT_SALARY,
  FINANCE_SALARY,
  SHIPPING_SALARY,
  type Command,
  type GameState,
  type ScenarioConfig,
} from './engine/sim';
import { SCENARIOS } from './scenarios/simScenarios';
import { PriceChart } from './ui/PriceChart';

const SEED = 1234;
const fmt = (n: number) => Math.round(n).toLocaleString();
const mmss = (sec: number) => {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

export default function App() {
  const [pick, setPick] = useState<{ scenario: ScenarioConfig; sandbox: boolean } | null>(null);

  if (!pick) {
    return (
      <div className="picker">
        <h1 className="brand">Owe &amp; Grow</h1>
        <p className="tagline">Grow a business. Borrow to grow faster — if you can carry the payments.</p>
        <div className="scenario-cards">
          {SCENARIOS.map((s) => (
            <div key={s.id} className="scenario-card">
              <h2>{s.name}</h2>
              <p>{s.blurb}</p>
              <div className="scenario-actions">
                <button className="primary" onClick={() => setPick({ scenario: s, sandbox: false })}>
                  Race to 1,000,000g
                </button>
                <button onClick={() => setPick({ scenario: s, sandbox: true })}>Sandbox</button>
              </div>
            </div>
          ))}
        </div>
        <p className="picker-note">Reach one million net worth within a game-hour. A pure saver can't — that's the lesson.</p>
      </div>
    );
  }

  return <Game key={pick.scenario.id + pick.sandbox} scenario={pick.scenario} sandbox={pick.sandbox} onExit={() => setPick(null)} />;
}

type Tab = 'production' | 'market' | 'bank' | 'managers' | 'gold' | 'log';
const TABS: { id: Tab; label: string }[] = [
  { id: 'production', label: 'Production' },
  { id: 'market', label: 'Market' },
  { id: 'bank', label: 'Bank' },
  { id: 'managers', label: 'Managers' },
  { id: 'gold', label: 'Gold' },
  { id: 'log', label: 'Log' },
];

function Game({ scenario, sandbox, onExit }: { scenario: ScenarioConfig; sandbox: boolean; onExit: () => void }) {
  const [state, setState] = useState<GameState>(() => newGame(scenario, { seed: SEED, sandbox }));
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [tab, setTab] = useState<Tab>('production');
  const [goldQty, setGoldQty] = useState(1);

  const speedRef = useRef(speed);
  speedRef.current = speed;
  const pausedRef = useRef(paused);
  pausedRef.current = paused || !!state.outcome;

  // Real-time loop: advance game-seconds at the current speed. 1 game-second =
  // 1 real second at x1. tickSecond internally settles every 30 game-seconds.
  useEffect(() => {
    const acc = { ms: 0 };
    let last = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (pausedRef.current) return;
      acc.ms += dt * speedRef.current;
      let steps = 0;
      while (acc.ms >= 1000 && steps < 30) {
        acc.ms -= 1000;
        steps += 1;
      }
      if (steps > 0) {
        setState((prev) => {
          let s = prev;
          for (let i = 0; i < steps; i++) s = tickSecond(s, scenario);
          return s;
        });
      }
    }, 120);
    return () => clearInterval(id);
  }, [scenario]);

  const cmd = (c: Command) => setState((s) => applyCommand(s, c, scenario));

  const nw = useMemo(() => netWorth(state), [state]);
  const secToSettle = SETTLE_INTERVAL_SEC - (state.clockSec % SETTLE_INTERVAL_SEC);
  const goalPct = state.runGoal ? Math.min(100, (nw / state.runGoal.targetNetWorth) * 100) : 0;
  const timeLeft = state.runGoal ? Math.max(0, state.runGoal.timeLimitSec - state.clockSec) : 0;
  const incomePerCycle = estimateIncomePerCycle(state, scenario);

  return (
    <div className="game">
      <header className="topbar">
        <div className="brand-block">
          <span className="brand-sm">Owe &amp; Grow</span>
          <span className="scenario-tag">{scenario.name}</span>
        </div>

        <div className="goal-block">
          <div className="goal-row">
            <span className="nw-label">Net worth</span>
            <span className="nw-value">{fmt(nw)}g</span>
            {state.runGoal && <span className="goal-target">/ {fmt(state.runGoal.targetNetWorth)}g</span>}
          </div>
          {state.runGoal && (
            <div className="goal-bar">
              <div className="goal-fill" style={{ width: `${goalPct}%` }} />
            </div>
          )}
        </div>

        <div className="stat-cluster">
          <div className="stat">
            <span className="stat-label">Cash</span>
            <span className="stat-value">{fmt(state.cash)}g</span>
          </div>
          <div className="stat">
            <span className="stat-label">{sandbox ? 'Elapsed' : 'Time left'}</span>
            <span className="stat-value">{sandbox ? mmss(state.clockSec) : mmss(timeLeft)}</span>
          </div>
        </div>

        <div className="clock-controls">
          {[1, 1.5, 2].map((sp) => (
            <button key={sp} className={`speed ${speed === sp ? 'active' : ''}`} onClick={() => setSpeed(sp)}>
              {sp}×
            </button>
          ))}
          <button className="pause" onClick={() => setPaused((p) => !p)}>
            {paused ? '▶' : '❚❚'}
          </button>
          <button onClick={onExit}>Quit</button>
        </div>
      </header>

      <div className="settle-strip">
        <span className="settle-label">Next settlement in {secToSettle}s</span>
        <div className="settle-bar">
          <div className="settle-fill" style={{ width: `${((SETTLE_INTERVAL_SEC - secToSettle) / SETTLE_INTERVAL_SEC) * 100}%` }} />
        </div>
        <span className="income-hint">~{fmt(incomePerCycle)}g income / cycle</span>
      </div>

      <div className="main">
        <section className="ops-col">
          <h2 className="col-head">Due now</h2>
          <div className="ops-scroll">
            {state.pendingObligations.length === 0 && state.opportunities.length === 0 && (
              <p className="all-clear">All clear — production is humming. Sell surplus, expand, or wait for the next cycle.</p>
            )}

            {state.opportunities.map((o) => (
              <div key={o.id} className="offer-card">
                <div className="offer-head">
                  <span className="offer-tag">Opportunity</span>
                  <span className="offer-expire">{o.expiresInSec}s</span>
                </div>
                <p className="offer-body">
                  <b>{o.customer}</b> wants <b>{o.qtyPerCycle} {productById(scenario, o.productId).name}</b> / cycle @ {o.pricePerUnit}g
                  <span className="offer-sub"> for {o.durationCycles} cycles</span>
                </p>
                <button className="primary" onClick={() => cmd({ kind: 'acceptOpportunity', offerId: o.id })}>
                  Sign · {fmt(o.qtyPerCycle * o.pricePerUnit)}g/cycle
                </button>
              </div>
            ))}

            {state.pendingObligations.map((o) => {
              const canDo =
                o.kind === 'delivery'
                  ? (state.inventory[o.productId] ?? 0) >= o.qty
                  : state.cash >= o.amountG;
              return (
                <div key={o.id} className={`ob-card ob-${o.kind}`}>
                  <p className="ob-label">{o.label}</p>
                  <button
                    className="primary"
                    disabled={!canDo}
                    onClick={() => cmd({ kind: 'resolveObligation', obligationId: o.id })}
                  >
                    {o.kind === 'delivery' ? `Ship · +${fmt(o.amountG)}g` : o.kind === 'installment' ? `Pay · ${fmt(o.amountG)}g` : `Pay tax · ${fmt(o.amountG)}g`}
                  </button>
                  {!canDo && <span className="ob-warn">{o.kind === 'delivery' ? 'not enough stock' : 'not enough cash'}</span>}
                </div>
              );
            })}
          </div>

          {(state.loanArrears > 0 || state.taxDebt > 0) && (
            <div className="arrears-box">
              {state.loanArrears > 0 && (
                <div className="arrears-row">
                  <span>⚠ Loan arrears <b>{fmt(state.loanArrears)}g</b> — blocks new loans</span>
                  <button disabled={state.cash <= 0} onClick={() => cmd({ kind: 'payArrears' })}>Pay</button>
                </div>
              )}
              {state.taxDebt > 0 && (
                <div className="arrears-row">
                  <span>⚠ Tax debt <b>{fmt(state.taxDebt)}g</b> — blocks new facilities</span>
                  <button disabled={state.cash <= 0} onClick={() => cmd({ kind: 'payTaxDebt' })}>Pay</button>
                </div>
              )}
            </div>
          )}
        </section>

        <section className="panel-col">
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'production' && state.pendingObligations.length > 0 && <span className="badge">{state.pendingObligations.length}</span>}
              </button>
            ))}
          </div>

          <div className="panel-body">
            {tab === 'production' && <ProductionTab state={state} scenario={scenario} cmd={cmd} />}
            {tab === 'market' && <MarketTab state={state} scenario={scenario} cmd={cmd} />}
            {tab === 'bank' && <BankTab state={state} cmd={cmd} incomePerCycle={incomePerCycle} />}
            {tab === 'managers' && <ManagersTab state={state} cmd={cmd} />}
            {tab === 'gold' && <GoldTab state={state} cmd={cmd} goldQty={goldQty} setGoldQty={setGoldQty} />}
            {tab === 'log' && <LogTab state={state} />}
          </div>
        </section>
      </div>

      <footer className="ticker">
        {state.ledger.slice(-3).reverse().map((e, i) => (
          <span key={state.ledger.length - i} className="tick-item">
            {e.label}
            {e.deltaG !== 0 && <em className={e.deltaG > 0 ? 'up' : 'down'}> {e.deltaG > 0 ? '+' : ''}{fmt(e.deltaG)}g</em>}
          </span>
        ))}
      </footer>

      {state.outcome && (
        <EndReport state={state} scenario={scenario} onExit={onExit} onReplay={() => setState(newGame(scenario, { seed: SEED + state.cycle, sandbox }))} />
      )}
    </div>
  );
}

function estimateIncomePerCycle(state: GameState, scenario: ScenarioConfig): number {
  const contractIncome = state.contracts.reduce((s, c) => s + c.qtyPerCycle * c.pricePerUnit, 0);
  return contractIncome - managerSalaryTotal(state) - upkeepTotal(state, scenario);
}

function ProductionTab({ state, scenario, cmd }: { state: GameState; scenario: ScenarioConfig; cmd: (c: Command) => void }) {
  const tier = unlockedTier(state, scenario);
  return (
    <>
      <h3 className="sub">Your facilities</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Facility</th><th className="num">Level</th><th className="num">Rate</th><th className="num">Upkeep</th><th></th></tr>
          </thead>
          <tbody>
            {state.facilities.map((f) => {
              const def = facilityTypeDef(scenario, f.type);
              const up = levelUpCost(f, scenario);
              return (
                <tr key={f.id}>
                  <td>{def.name}<span className="makes">→ {productById(scenario, f.productId).name}</span></td>
                  <td className="num">L{f.level}</td>
                  <td className="num">{facilityRatePerSec(f, scenario).toFixed(1)}/s</td>
                  <td className="num">{fmt(facilityUpkeep(f, scenario))}g</td>
                  <td className="row-actions">
                    <button disabled={state.cash < up} onClick={() => cmd({ kind: 'levelUpFacility', facilityId: f.id })}>Up · {fmt(up)}g</button>
                    <button onClick={() => cmd({ kind: 'sellFacility', facilityId: f.id })}>Sell</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="sub">Build new</h3>
      <p className="hint">Unlocked up to tier {tier}. Higher tiers unlock as you make your first sale and level facilities to L2.</p>
      <div className="build-grid">
        {scenario.facilityTypes.map((def) => {
          const product = productById(scenario, def.productId);
          const locked = product.tier > tier;
          const blocked = state.taxDebt > 0;
          const afford = state.cash >= def.buildCost;
          return (
            <button
              key={def.type}
              className="build-btn"
              disabled={locked || blocked || !afford}
              onClick={() => cmd({ kind: 'buildFacility', facilityType: def.type })}
              title={locked ? `Unlocks at tier ${product.tier}` : blocked ? 'Clear tax debt first' : ''}
            >
              <span className="build-name">{def.name}</span>
              <span className="build-tier">T{product.tier}</span>
              <span className="build-cost">{locked ? '🔒 locked' : `${fmt(def.buildCost)}g`}</span>
            </button>
          );
        })}
      </div>
    </>
  );
}

function MarketTab({ state, scenario, cmd }: { state: GameState; scenario: ScenarioConfig; cmd: (c: Command) => void }) {
  const [contractForm, setContractForm] = useState({ productId: scenario.products[0].id, qty: 3, cycles: 12 });
  return (
    <>
      <h3 className="sub">Spot market — buy inputs, sell surplus</h3>
      <div className="table-scroll">
        <table>
          <thead>
            <tr><th>Product</th><th className="num">Price</th><th className="num">Held</th><th></th></tr>
          </thead>
          <tbody>
            {scenario.products.map((p) => {
              const held = state.inventory[p.id] ?? 0;
              const price = state.market[p.id].price;
              return (
                <tr key={p.id}>
                  <td>{p.name}<span className="tier-chip">T{p.tier}</span></td>
                  <td className="num">{price.toFixed(1)}g</td>
                  <td className="num">{fmt(held)}</td>
                  <td className="row-actions">
                    <button disabled={held < 1} onClick={() => cmd({ kind: 'spotSell', productId: p.id, qty: held })}>Sell all</button>
                    <button disabled={state.cash < price} onClick={() => cmd({ kind: 'spotBuy', productId: p.id, qty: 10 })}>Buy 10</button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 className="sub">Sign a standing contract</h3>
      <p className="hint">Locks a price above spot — steady income you can size loans against. Deliver every cycle or the customer walks.</p>
      <div className="contract-form">
        <label>Product
          <select value={contractForm.productId} onChange={(e) => setContractForm((f) => ({ ...f, productId: e.target.value }))}>
            {scenario.products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label>Qty/cycle
          <input type="number" min={1} value={contractForm.qty} onChange={(e) => setContractForm((f) => ({ ...f, qty: Math.max(1, Number(e.target.value)) }))} />
        </label>
        <label>Cycles
          <input type="number" min={1} value={contractForm.cycles} onChange={(e) => setContractForm((f) => ({ ...f, cycles: Math.max(1, Number(e.target.value)) }))} />
        </label>
        <button className="primary" onClick={() => cmd({ kind: 'signStandingContract', productId: contractForm.productId, qtyPerCycle: contractForm.qty, cycles: contractForm.cycles })}>Sign</button>
      </div>

      {state.contracts.length > 0 && (
        <>
          <h3 className="sub">Active contracts</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Customer</th><th>Product</th><th className="num">Qty/cyc</th><th className="num">Price</th><th className="num">Left</th></tr></thead>
              <tbody>
                {state.contracts.map((c) => (
                  <tr key={c.id}>
                    <td>{c.customer}{c.fromEvent && <span className="tier-chip">event</span>}</td>
                    <td>{productById(scenario, c.productId).name}</td>
                    <td className="num">{c.qtyPerCycle}</td>
                    <td className="num">{c.pricePerUnit}g</td>
                    <td className="num">{c.cyclesLeft}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function BankTab({ state, cmd, incomePerCycle }: { state: GameState; cmd: (c: Command) => void; incomePerCycle: number }) {
  const installTotal = state.loans.reduce((s, l) => s + l.installmentPerCycle, 0);
  return (
    <>
      <h3 className="sub">Loans</h3>
      <p className="hint">
        Borrowing lets you expand before you've saved up. But every loan adds a fixed payment each cycle — your income must cover it.
        {' '}Current loan payments: <b>{fmt(installTotal)}g/cycle</b> vs income <b>{fmt(incomePerCycle)}g/cycle</b>.
      </p>
      {state.loanArrears > 0 && <p className="warn-line">In arrears — clear it in the “Due now” panel before borrowing again.</p>}
      <div className="loan-offers">
        {LOAN_OFFERS.map((o) => (
          <div key={o.id} className="loan-card">
            <div className="loan-head"><b>{o.label}</b><span>{fmt(o.principal)}g now</span></div>
            <p className="loan-terms">{o.installmentPerCycle}g/cycle × {o.termCycles} cycles = {fmt(o.totalRepay)}g repaid ({Math.round((o.totalRepay / o.principal - 1) * 100)}% interest)</p>
            <button className="primary" disabled={state.loanArrears > 0} onClick={() => cmd({ kind: 'takeLoan', offerId: o.id })}>Borrow</button>
          </div>
        ))}
      </div>

      {state.loans.length > 0 && (
        <>
          <h3 className="sub">Active loans</h3>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Loan</th><th className="num">Balance</th><th className="num">Payment</th><th className="num">Left</th></tr></thead>
              <tbody>
                {state.loans.map((l) => (
                  <tr key={l.id}>
                    <td>{l.label}</td>
                    <td className="num">{fmt(l.balance)}g</td>
                    <td className="num">{l.installmentPerCycle}g</td>
                    <td className="num">{l.cyclesLeft}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function ManagersTab({ state, cmd }: { state: GameState; cmd: (c: Command) => void }) {
  const rows = [
    { role: 'shipping' as const, name: 'Shipping Manager', salary: SHIPPING_SALARY, count: state.managers.shipping, desc: `Auto-delivers contracts (each covers ${CONTRACTS_PER_MANAGER}).` },
    { role: 'finance' as const, name: 'Finance Manager', salary: FINANCE_SALARY, count: state.managers.finance ? 1 : 0, desc: 'Auto-pays loan installments.' },
    { role: 'accountant' as const, name: 'Accountant', salary: ACCOUNTANT_SALARY, count: state.managers.accountant ? 1 : 0, desc: 'Auto-pays the tax bill.' },
  ];
  return (
    <>
      <h3 className="sub">Managers</h3>
      <p className="hint">Managers do the clicking for you — for a salary every cycle. Worth it once you're big; a drag when you're small. Total payroll: <b>{fmt(managerSalaryTotal(state))}g/cycle</b>.</p>
      <div className="mgr-list">
        {rows.map((r) => (
          <div key={r.role} className="mgr-card">
            <div className="mgr-info">
              <b>{r.name}{r.count > 0 && r.role === 'shipping' && ` ×${r.count}`}</b>
              <span>{r.desc}</span>
              <span className="mgr-salary">{r.salary}g / cycle each</span>
            </div>
            <div className="mgr-actions">
              <button className="primary" onClick={() => cmd({ kind: 'hireManager', role: r.role })} disabled={r.role !== 'shipping' && r.count > 0}>
                Hire
              </button>
              <button disabled={r.count === 0} onClick={() => cmd({ kind: 'fireManager', role: r.role })}>Fire</button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function GoldTab({ state, cmd, goldQty, setGoldQty }: { state: GameState; cmd: (c: Command) => void; goldQty: number; setGoldQty: (n: number) => void }) {
  const pnl = speculationPnL(state);
  return (
    <>
      <h3 className="sub">Gold {state.gold.phase === 'bubble' && <span className="bubble-tag">RALLYING 🔥</span>}</h3>
      <p className="hint">A speculative asset — drifts up on average, but rallies into bubbles that suddenly pop. You <em>can</em> borrow to buy it. Watch what happens when it crashes.</p>
      <div className="gold-summary">
        <div><span className="stat-label">Price</span><span className="stat-value">{state.gold.price.toFixed(1)}g</span></div>
        <div><span className="stat-label">Held</span><span className="stat-value">{fmt(state.gold.held)}</span></div>
        <div><span className="stat-label">Value</span><span className="stat-value">{fmt(goldValue(state))}g</span></div>
        <div><span className="stat-label">Profit/Loss</span><span className={`stat-value ${pnl >= 0 ? 'up' : 'down'}`}>{pnl >= 0 ? '+' : ''}{fmt(pnl)}g</span></div>
      </div>
      <PriceChart history={state.gold.history} currentTurn={state.cycle} />
      <div className="gold-trade">
        <input type="number" min={1} value={goldQty} onChange={(e) => setGoldQty(Math.max(1, Number(e.target.value)))} />
        <button className="primary" disabled={state.cash < goldQty * state.gold.price} onClick={() => cmd({ kind: 'buyGold', qty: goldQty })}>Buy · {fmt(goldQty * state.gold.price)}g</button>
        <button disabled={state.gold.held < goldQty} onClick={() => cmd({ kind: 'sellGold', qty: goldQty })}>Sell · {fmt(goldQty * state.gold.price)}g</button>
      </div>
    </>
  );
}

function LogTab({ state }: { state: GameState }) {
  return (
    <div className="table-scroll">
      <table className="log-table">
        <thead><tr><th className="num">Cycle</th><th>Event</th><th className="num">Δ</th></tr></thead>
        <tbody>
          {state.ledger.slice().reverse().map((e, i) => (
            <tr key={state.ledger.length - i}>
              <td className="num">{e.cycle}</td>
              <td>{e.label}</td>
              <td className={`num ${e.deltaG > 0 ? 'up' : e.deltaG < 0 ? 'down' : 'muted'}`}>{e.deltaG === 0 ? '—' : `${e.deltaG > 0 ? '+' : ''}${fmt(e.deltaG)}g`}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function EndReport({ state, scenario, onExit, onReplay }: { state: GameState; scenario: ScenarioConfig; onExit: () => void; onReplay: () => void }) {
  const nw = netWorth(state);
  const won = state.outcome === 'won';
  const pnl = speculationPnL(state);
  return (
    <div className="report-overlay">
      <div className="report-card">
        <h2 className="report-title">{won ? '🏆 You hit 1,000,000g!' : "⏱ Time's up"}</h2>
        <p className="report-nw">Final net worth <b>{fmt(nw)}g</b>{state.wonAtSec != null && won && <span> in {mmss(state.wonAtSec)}</span>}</p>
        <div className="report-totals">
          <div><span>Interest paid</span><b>{fmt(state.totals.interestPaidG)}g</b></div>
          <div><span>Tax paid</span><b>{fmt(state.totals.taxPaidG)}g</b></div>
          <div><span>Salaries paid</span><b>{fmt(state.totals.salariesPaidG)}g</b></div>
          <div><span>Upkeep paid</span><b>{fmt(state.totals.upkeepPaidG)}g</b></div>
          <div><span>Speculation P&amp;L</span><b className={pnl >= 0 ? 'up' : 'down'}>{pnl >= 0 ? '+' : ''}{fmt(pnl)}g</b></div>
        </div>
        <p className="report-note">
          {won
            ? 'You used debt and assets to reach the goal a saver never could. The ghost comparison chart lands in the next build.'
            : 'You ran the clock. Try borrowing earlier and bigger — a well-sized loan buys income that pays for itself.'}
        </p>
        <div className="report-actions">
          <button className="primary" onClick={onReplay}>Play again ({scenario.name})</button>
          <button onClick={onExit}>Change scenario</button>
        </div>
      </div>
    </div>
  );
}
