import { useEffect, useRef, useState } from 'react';
import './flow.css';
import { LOAN_OFFERS, type ScenarioConfig } from '../engine/sim';
import {
  accepts,
  applyFlowCommand,
  BUFFER_CAP,
  canConnect,
  debt,
  facilityDef,
  FLOW_SETTLE_SEC,
  levelUpCost,
  MARKET_COST,
  moveNode,
  netWorth,
  newFlowGame,
  nodeInputs,
  nodeRate,
  nodeUpkeep,
  NODE_RESALE_RATE,
  product,
  salePrice,
  SUPPLIER_COST,
  SUPPLIER_MARKUP,
  tickFlow,
  wireCapacity,
  wireUpgradeCost,
  WIRE_COST,
  type FlowCommand,
  type FlowNode,
  type FlowState,
  type Wire,
} from './flowEngine';

const SEED = 4321;
const NODE_W = 184;
const HEADER = 34;
const ROW = 24;
const CANVAS_W = 2400;
const CANVAS_H = 1600;
const PRODUCT_COLORS = ['#e8a33d', '#8fbf6f', '#6fb0d6', '#d68a6f', '#c79be0', '#e0d36f', '#6fd6c0', '#e06c9b'];

const fmt = (n: number) => Math.round(n).toLocaleString();
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

type Selection = { kind: 'node'; id: string } | { kind: 'wire'; id: string } | null;
type Drag = { kind: 'move'; nodeId: string; dx: number; dy: number } | { kind: 'wire'; from: string } | null;

export function FlowGame({ scenario, sandbox, onExit }: { scenario: ScenarioConfig; sandbox: boolean; onExit: () => void }) {
  const [state, setState] = useState<FlowState>(() => newFlowGame(scenario, { seed: SEED, sandbox }));
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [supplierProduct, setSupplierProduct] = useState(scenario.products[0].id);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);

  // Real-time clock.
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => setState((s) => tickFlow(s, scenario)), 1000 / speed);
    return () => clearInterval(t);
  }, [paused, speed, scenario]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const cmd = (c: FlowCommand) => setState((s) => applyFlowCommand(s, c, scenario));

  const colorOf = (productId: string) => PRODUCT_COLORS[scenario.products.findIndex((p) => p.id === productId) % PRODUCT_COLORS.length];

  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  };

  // Drop new nodes near the middle of what the player is looking at.
  const spawnPoint = () => {
    const w = wrapRef.current!;
    const jitter = () => Math.round((Math.random() - 0.5) * 120);
    return {
      x: Math.max(10, Math.round(w.scrollLeft + w.clientWidth / 2 - NODE_W / 2 + jitter())),
      y: Math.max(10, Math.round(w.scrollTop + w.clientHeight / 2 - 60 + jitter())),
    };
  };

  // Pointer tracking for dragging nodes and drawing wires.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const p = toCanvas(e.clientX, e.clientY);
      if (drag.kind === 'move') {
        const x = Math.max(0, Math.min(CANVAS_W - NODE_W, p.x - drag.dx));
        const y = Math.max(0, Math.min(CANVAS_H - 80, p.y - drag.dy));
        setState((s) => moveNode(s, drag.nodeId, x, y));
      } else setCursor(p);
    };
    const onUp = (e: PointerEvent) => {
      if (drag.kind === 'wire') {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node-id]');
        const to = el?.getAttribute('data-node-id');
        if (to && to !== drag.from) {
          const why = canConnect(state, scenario, drag.from, to);
          if (why) setToast(why);
          else cmd({ kind: 'connect', from: drag.from, to });
        }
      }
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  });

  const nodeById = new Map(state.nodes.map((n) => [n.id, n]));
  const nw = netWorth(state, scenario);
  const goal = state.goal;
  const dragFrom = drag?.kind === 'wire' ? nodeById.get(drag.from) : undefined;
  const selectedNode = selection?.kind === 'node' ? nodeById.get(selection.id) : undefined;
  const selectedWire = selection?.kind === 'wire' ? state.wires.find((w) => w.id === selection.id) : undefined;
  const salesPerSec = state.nodes.reduce((s, n) => s + n.soldLastSec, 0);

  return (
    <div className="flow-root">
      <header className="flow-hud">
        <div className="flow-brand">
          <span className="brand-sm">Owe &amp; Flow</span>
          <span className="scenario-tag">{scenario.name}</span>
        </div>
        <div className="flow-cash">
          <span className="stat-label">Cash</span>
          <span className={'cash-value' + (state.cash < 0 ? ' negative' : '')}>{fmt(state.cash)}g</span>
        </div>
        <div className="stat">
          <span className="stat-label">Selling</span>
          <span className="stat-value up">+{fmt(salesPerSec)}g/s</span>
        </div>
        <div className="goal-block">
          <div className="goal-row">
            <span className="nw-label">Net worth</span>
            <span className="nw-value">{fmt(nw)}g</span>
            {goal && <span className="goal-target">/ {fmt(goal.targetNetWorth)}g</span>}
          </div>
          {goal && (
            <div className="goal-bar">
              <div className="goal-fill" style={{ width: `${Math.max(0, Math.min(100, (nw / goal.targetNetWorth) * 100))}%` }} />
            </div>
          )}
        </div>
        <div className="stat">
          <span className="stat-label">{goal ? 'Time left' : 'Clock'}</span>
          <span className="stat-value">{goal ? mmss(Math.max(0, goal.timeLimitSec - state.clockSec)) : mmss(state.clockSec)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Bills in</span>
          <span className="stat-value">{FLOW_SETTLE_SEC - (state.clockSec % FLOW_SETTLE_SEC)}s</span>
        </div>
        <div className="clock-controls">
          <button className="pause" onClick={() => setPaused((p) => !p)}>{paused ? '▶' : '❚❚'}</button>
          {[1, 2, 4].map((x) => (
            <button key={x} className={'speed' + (speed === x ? ' active' : '')} onClick={() => setSpeed(x)}>
              {x}×
            </button>
          ))}
          <button onClick={onExit}>Exit</button>
        </div>
      </header>

      <div className="flow-main">
        <aside className="flow-panel flow-palette">
          <h3>Build</h3>
          {scenario.facilityTypes.map((def) => {
            const p = product(scenario, def.productId);
            return (
              <button
                key={def.type}
                className="palette-item"
                disabled={state.cash < def.buildCost}
                onClick={() => cmd({ kind: 'buildFacility', facilityType: def.type, ...spawnPoint() })}
              >
                <span className="palette-top">
                  <span className="swatch" style={{ background: colorOf(p.id) }} />
                  <b>{def.name}</b>
                  <span className="cost">{fmt(def.buildCost)}g</span>
                </span>
                <span className="palette-sub">
                  {p.inputs.length ? p.inputs.map((i) => `${i.qty} ${product(scenario, i.id).name}`).join(' + ') + ' → ' : ''}
                  {p.name} · {def.baseRatePerSec}/s
                </span>
              </button>
            );
          })}
          <button className="palette-item" disabled={state.cash < MARKET_COST} onClick={() => cmd({ kind: 'buildMarket', ...spawnPoint() })}>
            <span className="palette-top">
              <span className="swatch market" />
              <b>Market stall</b>
              <span className="cost">{MARKET_COST}g</span>
            </span>
            <span className="palette-sub">Another place to sell. Same prices, same glut.</span>
          </button>
          <div className="palette-item supplier-row">
            <span className="palette-top">
              <span className="swatch supplier" />
              <b>Supplier</b>
              <span className="cost">{SUPPLIER_COST}g</span>
            </span>
            <span className="palette-sub">Buys a good at {Math.round((SUPPLIER_MARKUP - 1) * 100)}% over spot and feeds it in.</span>
            <div className="supplier-controls">
              <select value={supplierProduct} onChange={(e) => setSupplierProduct(e.target.value)}>
                {scenario.products.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button disabled={state.cash < SUPPLIER_COST} onClick={() => cmd({ kind: 'buildSupplier', productId: supplierProduct, ...spawnPoint() })}>
                Sign
              </button>
            </div>
          </div>

          <h3>Borrow</h3>
          {LOAN_OFFERS.map((o) => (
            <button key={o.id} className="palette-item" disabled={state.arrears > 0} onClick={() => cmd({ kind: 'takeLoan', offerId: o.id })}>
              <span className="palette-top">
                <b>{o.label}</b>
                <span className="cost up">+{fmt(o.principal)}g</span>
              </span>
              <span className="palette-sub">
                {o.installmentPerCycle}g every bill × {o.termCycles} = {fmt(o.totalRepay)}g
              </span>
            </button>
          ))}
          {debt(state) > 0 && (
            <div className="debt-line">
              Owed: <b>{fmt(debt(state))}g</b>
              {state.arrears > 0 && (
                <>
                  {' '}
                  · arrears {fmt(state.arrears)}g <button onClick={() => cmd({ kind: 'payArrears' })}>Pay</button>
                </>
              )}
            </div>
          )}
        </aside>

        <div className="flow-canvas-wrap" ref={wrapRef}>
          <div
            className={'flow-canvas' + (drag?.kind === 'wire' ? ' wiring' : '')}
            ref={canvasRef}
            style={{ width: CANVAS_W, height: CANVAS_H }}
            onPointerDown={(e) => {
              if (e.target === canvasRef.current || (e.target as Element).tagName === 'svg') setSelection(null);
            }}
          >
            <svg className="flow-wires" width={CANVAS_W} height={CANVAS_H}>
              {state.wires.map((w) => {
                const from = nodeById.get(w.from);
                const to = nodeById.get(w.to);
                if (!from || !to) return null;
                const a = outPort(from);
                const b = inPort(to, w.productId, scenario);
                return (
                  <WirePath
                    key={w.id}
                    wire={w}
                    a={a}
                    b={b}
                    color={colorOf(w.productId)}
                    selected={selection?.kind === 'wire' && selection.id === w.id}
                    onSelect={() => setSelection({ kind: 'wire', id: w.id })}
                  />
                );
              })}
              {dragFrom && (
                <path className="wire-pending" d={curve(outPort(dragFrom), cursor)} stroke={colorOf(dragFrom.productId!)} />
              )}
            </svg>

            {state.nodes.map((n) => (
              <NodeCard
                key={n.id}
                node={n}
                scenario={scenario}
                colorOf={colorOf}
                selected={selection?.kind === 'node' && selection.id === n.id}
                dropTarget={dragFrom ? (n.id !== dragFrom.id && accepts(n, dragFrom.productId!, scenario) ? 'ok' : 'no') : null}
                onHeaderDown={(e) => {
                  const p = toCanvas(e.clientX, e.clientY);
                  setSelection({ kind: 'node', id: n.id });
                  setDrag({ kind: 'move', nodeId: n.id, dx: p.x - n.x, dy: p.y - n.y });
                }}
                onPortDown={(e) => {
                  e.stopPropagation();
                  setCursor(toCanvas(e.clientX, e.clientY));
                  setDrag({ kind: 'wire', from: n.id });
                }}
                onSelect={() => setSelection({ kind: 'node', id: n.id })}
              />
            ))}
          </div>
          {toast && <div className="flow-toast">{toast}</div>}
        </div>

        <aside className="flow-panel flow-inspector">
          {selectedNode ? (
            <NodeInspector node={selectedNode} state={state} scenario={scenario} cmd={cmd} onClose={() => setSelection(null)} />
          ) : selectedWire ? (
            <WireInspector wire={selectedWire} state={state} scenario={scenario} cmd={cmd} onClose={() => setSelection(null)} />
          ) : (
            <Overview state={state} scenario={scenario} />
          )}
        </aside>
      </div>

      {state.outcome && (
        <div className="report-overlay">
          <div className="report-card flow-end">
            <h2>{state.outcome === 'won' ? 'Your factory paid off!' : "Time's up"}</h2>
            <p>
              {state.outcome === 'won'
                ? `You reached ${fmt(goal!.targetNetWorth)}g net worth in ${mmss(state.wonAtSec!)}.`
                : `You finished at ${fmt(nw)}g net worth.`}
            </p>
            <ul>
              <li>Sold: {fmt(state.totals.salesG)}g</li>
              <li>Upkeep paid: {fmt(state.totals.upkeepG)}g</li>
              <li>Bought from suppliers: {fmt(state.totals.suppliesG)}g</li>
              <li>Loan payments: {fmt(state.totals.loanPaidG)}g</li>
            </ul>
            <div className="scenario-actions">
              <button className="primary" onClick={() => setState(newFlowGame(scenario, { seed: SEED + state.clockSec, sandbox }))}>
                Play again
              </button>
              <button onClick={onExit}>Back to menu</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

function portRows(node: FlowNode, scenario: ScenarioConfig) {
  return Math.max(1, nodeInputs(node, scenario).length);
}

function outPort(n: FlowNode): Pt {
  return { x: n.x + NODE_W, y: n.y + HEADER + ROW / 2 };
}

function inPort(n: FlowNode, productId: string, scenario: ScenarioConfig): Pt {
  const idx = Math.max(0, nodeInputs(n, scenario).findIndex((i) => i.id === productId));
  return { x: n.x, y: n.y + HEADER + ROW * idx + ROW / 2 };
}

function curve(a: Pt, b: Pt) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function WirePath({ wire, a, b, color, selected, onSelect }: { wire: Wire; a: Pt; b: Pt; color: string; selected: boolean; onSelect: () => void }) {
  const d = curve(a, b);
  const cap = wireCapacity(wire);
  const load = wire.movedLastSec / cap;
  // Dots travel faster the more the wire carries.
  const dur = wire.movedLastSec > 0 ? Math.max(0.35, 1.6 - load * 1.2) : 0;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  return (
    <g className={'wire' + (selected ? ' selected' : '') + (load >= 1 ? ' maxed' : '')} onPointerDown={(e) => (e.stopPropagation(), onSelect())}>
      <path className="wire-hit" d={d} />
      <path className="wire-base" d={d} stroke={color} strokeWidth={2 + wire.level} />
      {dur > 0 && <path className="wire-flow" d={d} stroke={color} strokeWidth={2 + wire.level} style={{ animationDuration: `${dur}s` }} />}
      <g transform={`translate(${mid.x}, ${mid.y})`}>
        <rect className="wire-label-bg" x={-22} y={-9} width={44} height={18} rx={9} />
        <text className="wire-label" textAnchor="middle" dy={4}>
          {wire.movedLastSec}/{cap}
        </text>
      </g>
    </g>
  );
}

const STATUS_TEXT: Record<string, string> = {
  idle: 'idle',
  running: 'running',
  starved: 'needs input',
  blocked: 'backed up',
};

function NodeCard({
  node,
  scenario,
  colorOf,
  selected,
  dropTarget,
  onHeaderDown,
  onPortDown,
  onSelect,
}: {
  node: FlowNode;
  scenario: ScenarioConfig;
  colorOf: (id: string) => string;
  selected: boolean;
  dropTarget: 'ok' | 'no' | null;
  onHeaderDown: (e: React.PointerEvent) => void;
  onPortDown: (e: React.PointerEvent) => void;
  onSelect: () => void;
}) {
  const inputs = nodeInputs(node, scenario);
  const rows = portRows(node, scenario);
  const title =
    node.kind === 'facility'
      ? facilityDef(scenario, node.facilityType!).name
      : node.kind === 'market'
        ? 'Market'
        : `${product(scenario, node.productId!).name} Supplier`;
  const out = node.productId ? product(scenario, node.productId) : null;
  return (
    <div
      className={`flow-node kind-${node.kind} status-${node.status}` + (selected ? ' selected' : '') + (dropTarget ? ` drop-${dropTarget}` : '')}
      data-node-id={node.id}
      style={{ left: node.x, top: node.y, width: NODE_W }}
      onPointerDown={onSelect}
    >
      <div className="node-head" style={{ height: HEADER }} onPointerDown={onHeaderDown}>
        <span className="node-title">{title}</span>
        {node.kind !== 'market' && <span className="node-level">L{node.level}</span>}
      </div>
      <div className="node-ports" style={{ height: ROW * rows }}>
        {node.kind === 'market' ? (
          <div className="port-row" style={{ height: ROW }}>
            <span className="port in" />
            <span className="port-label">sells anything</span>
          </div>
        ) : (
          Array.from({ length: rows }, (_, i) => {
            const inp = inputs[i];
            return (
              <div key={i} className="port-row" style={{ height: ROW }}>
                {inp ? (
                  <>
                    <span className="port in" style={{ borderColor: colorOf(inp.id) }} />
                    <span className="port-label">
                      {inp.qty}× {product(scenario, inp.id).name}
                      <span className="buf">{node.inBuf[inp.id] ?? 0}</span>
                    </span>
                  </>
                ) : (
                  <span className="port-label" />
                )}
                {i === 0 && out && (
                  <>
                    <span className="port-label out-label">
                      <span className="buf">{node.outBuf}</span>
                      {out.name}
                    </span>
                    <span className="port out" style={{ background: colorOf(out.id) }} onPointerDown={onPortDown} title="Drag to connect" />
                  </>
                )}
              </div>
            );
          })
        )}
      </div>
      <div className="node-foot">
        {node.kind === 'market' ? (
          <span>+{fmt(node.soldLastSec)}g/s</span>
        ) : (
          <>
            <span className="status-dot" />
            <span>{STATUS_TEXT[node.status]}</span>
            <span className="foot-rate">{+nodeRate(node, scenario).toFixed(2)}/s</span>
          </>
        )}
      </div>
      {node.kind !== 'market' && <div className="out-fill" style={{ width: `${(node.outBuf / BUFFER_CAP) * 100}%` }} />}
    </div>
  );
}

function NodeInspector({
  node,
  state,
  scenario,
  cmd,
  onClose,
}: {
  node: FlowNode;
  state: FlowState;
  scenario: ScenarioConfig;
  cmd: (c: FlowCommand) => void;
  onClose: () => void;
}) {
  const inputs = nodeInputs(node, scenario);
  const up = node.kind === 'market' ? 0 : levelUpCost(node, scenario);
  const name =
    node.kind === 'facility' ? facilityDef(scenario, node.facilityType!).name : node.kind === 'market' ? 'Market' : `${product(scenario, node.productId!).name} Supplier`;
  const outgoing = state.wires.filter((w) => w.from === node.id).length;
  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>{name}</h3>
        <button className="x" onClick={onClose}>
          ×
        </button>
      </div>
      {node.kind !== 'market' && (
        <p className={`hint status-${node.status}`}>
          {node.status === 'starved' && (node.kind === 'supplier' ? 'Out of cash to buy with.' : `Waiting on ${inputs.map((i) => product(scenario, i.id).name).join(' and ')}. Wire a producer into it.`)}
          {node.status === 'blocked' && (outgoing ? 'Output is backed up. Upgrade its wire or add another route.' : 'Output has nowhere to go. Drag from its port to a buyer.')}
          {node.status === 'running' && 'Running smoothly.'}
          {node.status === 'idle' && 'Warming up.'}
        </p>
      )}
      <dl className="facts">
        {node.productId && (
          <>
            <dt>Makes</dt>
            <dd>
              {+nodeRate(node, scenario).toFixed(2)} {product(scenario, node.productId).name}/s
            </dd>
            <dt>Sells for now</dt>
            <dd>{salePrice(state, scenario, node.productId).toFixed(1)}g each</dd>
          </>
        )}
        {node.kind === 'supplier' && (
          <>
            <dt>Buys at</dt>
            <dd>{(state.market[node.productId!].price * SUPPLIER_MARKUP).toFixed(1)}g each</dd>
          </>
        )}
        {node.kind === 'market' && (
          <>
            <dt>Earning</dt>
            <dd>{fmt(node.soldLastSec)}g/s</dd>
          </>
        )}
        <dt>Upkeep</dt>
        <dd>{nodeUpkeep(node, scenario)}g per bill</dd>
      </dl>
      <div className="inspector-actions">
        {node.kind !== 'market' && (
          <button className="primary" disabled={state.cash < up} onClick={() => cmd({ kind: 'levelUp', nodeId: node.id })}>
            Upgrade to L{node.level + 1} · {fmt(up)}g
          </button>
        )}
        <button
          onClick={() => {
            cmd({ kind: 'sellNode', nodeId: node.id });
            onClose();
          }}
        >
          Sell for {fmt(node.invested * NODE_RESALE_RATE)}g
        </button>
      </div>
    </div>
  );
}

function WireInspector({
  wire,
  state,
  scenario,
  cmd,
  onClose,
}: {
  wire: Wire;
  state: FlowState;
  scenario: ScenarioConfig;
  cmd: (c: FlowCommand) => void;
  onClose: () => void;
}) {
  const cost = wireUpgradeCost(wire);
  return (
    <div className="inspector">
      <div className="inspector-head">
        <h3>{product(scenario, wire.productId).name} line</h3>
        <button className="x" onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="facts">
        <dt>Carrying</dt>
        <dd>
          {wire.movedLastSec} of {wireCapacity(wire)}/s
        </dd>
        <dt>Level</dt>
        <dd>{wire.level}</dd>
      </dl>
      <div className="inspector-actions">
        <button className="primary" disabled={state.cash < cost} onClick={() => cmd({ kind: 'upgradeWire', wireId: wire.id })}>
          Double capacity · {fmt(cost)}g
        </button>
        <button
          onClick={() => {
            cmd({ kind: 'removeWire', wireId: wire.id });
            onClose();
          }}
        >
          Cut wire
        </button>
      </div>
    </div>
  );
}

function Overview({ state, scenario }: { state: FlowState; scenario: ScenarioConfig }) {
  return (
    <div className="inspector">
      <h3>How it works</h3>
      <ol className="howto">
        <li>Drag from a node’s coloured output port to another node to lay a wire ({WIRE_COST}g).</li>
        <li>Raw goods flow into processors, finished goods flow into a Market for cash.</li>
        <li>Each wire carries a few units a second. Upgrade busy ones.</li>
        <li>Flooding the market with one good drops its price. Process it into something worth more.</li>
        <li>Every {FLOW_SETTLE_SEC}s you pay upkeep and loan installments.</li>
      </ol>
      <h3>Prices</h3>
      <table className="price-table">
        <tbody>
          {scenario.products.map((p) => {
            const now = salePrice(state, scenario, p.id);
            const spot = state.market[p.id].price;
            return (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{now.toFixed(1)}g</td>
                <td className={'num ' + (now < spot * 0.85 ? 'down' : '')}>{now < spot * 0.85 ? `glut −${Math.round((1 - now / spot) * 100)}%` : ''}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <h3>Ledger</h3>
      <ul className="flow-ledger">
        {state.ledger
          .slice(-12)
          .reverse()
          .map((l, i) => (
            <li key={i}>
              <span className="when">{mmss(l.sec)}</span> {l.label}
              {l.deltaG !== 0 && <span className={l.deltaG > 0 ? 'up' : 'down'}> {l.deltaG > 0 ? '+' : ''}{fmt(l.deltaG)}g</span>}
            </li>
          ))}
      </ul>
    </div>
  );
}
