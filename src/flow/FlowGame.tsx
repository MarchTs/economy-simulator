import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './flow.css';
import { type ScenarioConfig } from '../engine/sim';
import {
  applyFlowCommand,
  batchInputs,
  batchSize,
  bufferCap,
  canConnect,
  connectRule,
  debt,
  distributionOf,
  facilityDef,
  equity,
  FLOW_LOAN_OFFERS,
  FLOW_SETTLE_SEC,
  hasArrears,
  hasLicense,
  licenseBlocker,
  licenseCost,
  licensePrereqs,
  inputRows,
  isOn,
  isPayLink,
  isUpgradable,
  levelUpCost,
  MARKET_COST,
  MONEY,
  moveNode,
  newFlowGame,
  nodeInputs,
  nodeName,
  nodeRate,
  nodeUpkeep,
  NODE_RESALE_RATE,
  outputOf,
  payersOf,
  product,
  salePrice,
  SUPPLIER_COST,
  SUPPLIER_MARKUP,
  SUPPLIER_MAX_DEMAND,
  SUPPLIER_UPKEEP,
  tickFlow,
  walletReserve,
  WALLET_COST,
  wireCapacity,
  wireUpgradeCost,
  WIRE_COST,
  type FlowBankruptcy,
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
const ZOOM_MIN = 0.4;
const ZOOM_MAX = 2;
const ZOOM_STEP = 1.2;
const SEP_H = 9; // the divider between a block's goods inputs and its upkeep dot
const FOOT_H = 26; // a node card's footer, for fitting the view around nodes
const MONEY_COLOR = '#f2d16b';
const PRODUCT_COLORS = ['#e8a33d', '#8fbf6f', '#6fb0d6', '#d68a6f', '#c79be0', '#e0d36f', '#6fd6c0', '#e06c9b'];

const fmt = (n: number) => Math.round(n).toLocaleString();
const mmss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

type Selection = { kind: 'node'; id: string } | { kind: 'wire'; id: string } | null;
type Drag = { kind: 'move'; nodeId: string; dx: number; dy: number } | { kind: 'wire'; from: string } | null;

export function FlowGame({ scenario, onExit }: { scenario: ScenarioConfig; onExit: () => void }) {
  const [state, setState] = useState<FlowState>(() => newFlowGame(scenario, { seed: SEED }));
  const [speed, setSpeed] = useState(1);
  const [paused, setPaused] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [cursor, setCursor] = useState({ x: 0, y: 0 });
  const [toast, setToast] = useState<string | null>(null);
  const [seenBankruptcy, setSeenBankruptcy] = useState<number | null>(null);
  const bankruptAt = state.bankruptcy?.sec ?? null;
  const showBankruptcy = bankruptAt !== null && bankruptAt !== seenBankruptcy;
  // Hold the clock while the bankruptcy report is open.
  useEffect(() => {
    if (showBankruptcy) setPaused(true);
  }, [showBankruptcy]);
  const [supplierProduct, setSupplierProduct] = useState(scenario.products[0].id);
  const [walletFund, setWalletFund] = useState(100);
  const [zoom, setZoom] = useState(1);
  const [infoOpen, setInfoOpen] = useState(true);
  const [buildOpen, setBuildOpen] = useState(true);
  const [licensesOpen, setLicensesOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  // Scroll position to apply once a zoom change has resized the canvas.
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);

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

  const colorOf = (productId: string) =>
    productId === MONEY ? MONEY_COLOR : PRODUCT_COLORS[scenario.products.findIndex((p) => p.id === productId) % PRODUCT_COLORS.length];

  // Client pixels → canvas units. The canvas is scaled from its top-left corner, so only the scale needs undoing.
  const toCanvas = (clientX: number, clientY: number) => {
    const r = canvasRef.current!.getBoundingClientRect();
    return { x: (clientX - r.left) / zoom, y: (clientY - r.top) / zoom };
  };

  // Drop new nodes near the middle of what the player is looking at.
  const spawnPoint = () => {
    const w = wrapRef.current!;
    const jitter = () => Math.round((Math.random() - 0.5) * 120);
    return {
      x: Math.max(10, Math.round((w.scrollLeft + w.clientWidth / 2) / zoom - NODE_W / 2 + jitter())),
      y: Math.max(10, Math.round((w.scrollTop + w.clientHeight / 2) / zoom - 60 + jitter())),
    };
  };

  // Zoom keeping the canvas point under (clientX, clientY) fixed; defaults to the view's centre.
  const zoomTo = (next: number, clientX?: number, clientY?: number) => {
    const w = wrapRef.current;
    if (!w) return;
    const z = zoomRef.current;
    const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    if (clamped === z) return;
    const r = w.getBoundingClientRect();
    const mx = clientX === undefined ? w.clientWidth / 2 : clientX - r.left;
    const my = clientY === undefined ? w.clientHeight / 2 : clientY - r.top;
    pendingScroll.current = {
      left: ((w.scrollLeft + mx) / z) * clamped - mx,
      top: ((w.scrollTop + my) / z) * clamped - my,
    };
    zoomRef.current = clamped;
    setZoom(clamped);
  };

  // Zoom and scroll so every node is in view.
  const fitView = () => {
    const w = wrapRef.current;
    if (!w || state.nodes.length === 0) return;
    const pad = 40;
    const minX = Math.min(...state.nodes.map((n) => n.x)) - pad;
    const minY = Math.min(...state.nodes.map((n) => n.y)) - pad;
    const maxX = Math.max(...state.nodes.map((n) => n.x + NODE_W)) + pad;
    const maxY = Math.max(...state.nodes.map((n) => n.y + HEADER + portsHeight(layouts.get(n.id)!) + FOOT_H)) + pad;
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(w.clientWidth / (maxX - minX), w.clientHeight / (maxY - minY))));
    pendingScroll.current = {
      left: ((minX + maxX) / 2) * next - w.clientWidth / 2,
      top: ((minY + maxY) / 2) * next - w.clientHeight / 2,
    };
    zoomRef.current = next;
    setZoom(next);
    if (next === zoom) applyPendingScroll();
  };

  const applyPendingScroll = () => {
    const w = wrapRef.current;
    if (!w || !pendingScroll.current) return;
    w.scrollLeft = pendingScroll.current.left;
    w.scrollTop = pendingScroll.current.top;
    pendingScroll.current = null;
  };

  useLayoutEffect(applyPendingScroll, [zoom]);

  // Ctrl/⌘ + wheel (and trackpad pinch, which browsers report as ctrl + wheel) zooms; a plain wheel still pans.
  useEffect(() => {
    const w = wrapRef.current;
    if (!w) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomTo(zoomRef.current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    w.addEventListener('wheel', onWheel, { passive: false });
    return () => w.removeEventListener('wheel', onWheel);
    // zoomTo reads only refs, so binding it once is safe.
  }, []);

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
  const layouts = new Map(state.nodes.map((n) => [n.id, portLayout(n, state, scenario)]));
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
          <span className="stat-label">Budget</span>
          <span className={'cash-value' + (state.cash < 0 ? ' negative' : '')}>{fmt(state.cash)}g</span>
        </div>
        <div className="stat" title="Everything you own minus everything you owe. Below 0 at two bills in a row and the creditors liquidate.">
          <span className="stat-label">{state.insolvent ? 'Equity · insolvent' : 'Equity'}</span>
          <span className={'stat-value' + (equity(state) < 0 ? ' down' : '')}>{fmt(equity(state))}g</span>
        </div>
        <div className="stat">
          <span className="stat-label">Selling</span>
          <span className="stat-value up">+{fmt(salesPerSec)}g/s</span>
        </div>
        <div className="stat">
          <span className="stat-label">Clock</span>
          <span className="stat-value">{mmss(state.clockSec)}</span>
        </div>
        <div className="stat">
          <span className="stat-label">Bills in</span>
          <BillPie elapsed={state.clockSec % FLOW_SETTLE_SEC} speed={paused ? 0 : speed} />
        </div>
        <div className="clock-controls">
          <button className="pause" onClick={() => setPaused((p) => !p)}>{paused ? '▶' : '❚❚'}</button>
          {[1, 2, 4].map((x) => (
            <button key={x} className={'speed' + (speed === x ? ' active' : '')} onClick={() => setSpeed(x)}>
              {x}×
            </button>
          ))}
          <button onClick={() => setLicensesOpen(true)}>Licenses</button>
          <button className={'flow-toggle' + (buildOpen ? ' active' : '')} aria-pressed={buildOpen} onClick={() => setBuildOpen((o) => !o)}>
            Build
          </button>
          <button className={'flow-toggle' + (infoOpen ? ' active' : '')} aria-pressed={infoOpen} onClick={() => setInfoOpen((o) => !o)}>
            Info
          </button>
          <button onClick={onExit}>Exit</button>
        </div>
      </header>

      <div className="flow-main">
        {buildOpen && (
          <aside className="flow-panel flow-palette">
            <InspectorHead title="Build" onClose={() => setBuildOpen(false)} />
            {scenario.facilityTypes
              .filter((def) => hasLicense(state, def.type))
              .map((def) => {
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
            {(() => {
              const locked = scenario.facilityTypes.filter((def) => !hasLicense(state, def.type)).length;
              return locked > 0 ? (
                <button className="palette-item locked" onClick={() => setLicensesOpen(true)}>
                  <span className="palette-top">
                    <b>🔒 {locked} more {locked === 1 ? 'facility' : 'facilities'}</b>
                  </span>
                  <span className="palette-sub">Buy their licenses to build them. Opens the license tree.</span>
                </button>
              ) : null;
            })()}
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
              <span className="palette-sub">
                Buys a good at {Math.round((SUPPLIER_MARKUP - 1) * 100)}% over spot and feeds it in. Set how much it buys; upkeep is{' '}
                {SUPPLIER_UPKEEP}g per unit/s.
              </span>
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

            <div className="palette-item supplier-row">
              <span className="palette-top">
                <span className="swatch wallet" />
                <b>Wallet</b>
                <span className="cost">{WALLET_COST}g</span>
              </span>
              <span className="palette-sub">Holds money and pays the upkeep of every block you wire it into.</span>
              <label className="fund-label">
                Fund from Budget
                <input
                  type="number"
                  min={0}
                  step={50}
                  value={walletFund}
                  onChange={(e) => setWalletFund(Math.max(0, Math.round(Number(e.target.value)) || 0))}
                />
                g
              </label>
              <button
                disabled={state.cash < WALLET_COST + walletFund}
                onClick={() => cmd({ kind: 'buildWallet', fund: walletFund, ...spawnPoint() })}
              >
                Open · {fmt(WALLET_COST + walletFund)}g from Budget
              </button>
            </div>

            <button className="palette-item" onClick={() => cmd({ kind: 'buildBudget', ...spawnPoint() })}>
            <span className="palette-top">
              <span className="swatch budget" />
              <b>Budget</b>
              <span className="cost">free</span>
            </span>
            <span className="palette-sub">Another Budget block. Every one shows the same global cash, so place them wherever wires need one.</span>
          </button>

          <h3>Borrow</h3>
            {FLOW_LOAN_OFFERS.map((o) => (
              <button key={o.id} className="palette-item" disabled={hasArrears(state)} onClick={() => cmd({ kind: 'takeLoan', offerId: o.id, ...spawnPoint() })}>
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
                {hasArrears(state) && ' · in arrears, so no new loans. Open the Borrower to pay.'}
              </div>
            )}
          </aside>
        )}

        <div className="flow-canvas-area">
          <div className="flow-canvas-wrap" ref={wrapRef}>
            <div className="flow-canvas-sizer" style={{ width: CANVAS_W * zoom, height: CANVAS_H * zoom }}>
              <div
                className={'flow-canvas' + (drag?.kind === 'wire' ? ' wiring' : '')}
                ref={canvasRef}
                style={{ width: CANVAS_W, height: CANVAS_H, transform: `scale(${zoom})` }}
                onPointerDown={(e) => {
                  if (e.target === canvasRef.current || (e.target as Element).tagName === 'svg') setSelection(null);
                }}
              >
                <svg className="flow-wires" width={CANVAS_W} height={CANVAS_H}>
                  {state.wires.map((w) => {
                    const from = nodeById.get(w.from);
                    const to = nodeById.get(w.to);
                    if (!from || !to) return null;
                    const a = portPoint(from, layouts.get(from.id)!, 'out', w.id);
                    const b = portPoint(to, layouts.get(to.id)!, 'in', w.id);
                    return (
                      <WirePath
                        key={w.id}
                        wire={w}
                        pay={isPayLink(state, w)}
                        a={a}
                        b={b}
                        color={colorOf(w.productId)}
                        selected={selection?.kind === 'wire' && selection.id === w.id}
                        onSelect={() => setSelection({ kind: 'wire', id: w.id })}
                      />
                    );
                  })}
                  {dragFrom && (
                    <path className="wire-pending" d={curve(portPoint(dragFrom, layouts.get(dragFrom.id)!, 'out', null), cursor)} stroke={colorOf(outputOf(dragFrom) ?? MONEY)} />
                  )}
                </svg>

                {state.nodes.map((n) => (
                  <NodeCard
                    key={n.id}
                    node={n}
                    state={state}
                    scenario={scenario}
                    layout={layouts.get(n.id)!}
                    colorOf={colorOf}
                    selected={selection?.kind === 'node' && selection.id === n.id}
                    dropTarget={dragFrom ? (connectRule(dragFrom, n, scenario) === null ? 'ok' : 'no') : null}
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
            </div>
            {toast && <div className="flow-toast">{toast}</div>}
          </div>
          <div className="flow-zoom" role="group" aria-label="Zoom">
            <button onClick={() => zoomTo(zoomRef.current / ZOOM_STEP)} disabled={zoom <= ZOOM_MIN} aria-label="Zoom out">
              −
            </button>
            <button className="flow-zoom-level" onClick={() => zoomTo(1)} title="Reset to 100%">
              {Math.round(zoom * 100)}%
            </button>
            <button onClick={() => zoomTo(zoomRef.current * ZOOM_STEP)} disabled={zoom >= ZOOM_MAX} aria-label="Zoom in">
              +
            </button>
            <button onClick={fitView}>Fit</button>
          </div>
        </div>

        {selectedNode ? (
          <aside className="flow-panel flow-inspector">
            <NodeInspector node={selectedNode} state={state} scenario={scenario} cmd={cmd} onClose={() => setSelection(null)} />
          </aside>
        ) : selectedWire ? (
          <aside className="flow-panel flow-inspector">
            <WireInspector wire={selectedWire} state={state} scenario={scenario} cmd={cmd} onClose={() => setSelection(null)} />
          </aside>
        ) : (
          infoOpen && (
            <aside className="flow-panel flow-inspector">
              <Overview state={state} scenario={scenario} onClose={() => setInfoOpen(false)} />
            </aside>
          )
        )}
      </div>

      {licensesOpen && <LicenseTree state={state} scenario={scenario} colorOf={colorOf} cmd={cmd} onClose={() => setLicensesOpen(false)} />}

      {showBankruptcy && (
        <BankruptcyReport
          report={state.bankruptcy!}
          onClose={() => {
            setSeenBankruptcy(bankruptAt);
            setPaused(false);
          }}
        />
      )}
    </div>
  );
}

// The license tree: one column per product tier, each license linked from the
// licenses it needs. Buying one lets you build that facility from the Build panel.
const LIC_W = 190;
const LIC_H = 92;
const LIC_GAP_X = 64;
const LIC_GAP_Y = 22;

function LicenseTree({
  state,
  scenario,
  colorOf,
  cmd,
  onClose,
}: {
  state: FlowState;
  scenario: ScenarioConfig;
  colorOf: (id: string) => string;
  cmd: (c: FlowCommand) => void;
  onClose: () => void;
}) {
  const tierOf = (type: string) => product(scenario, facilityDef(scenario, type).productId).tier;
  const tiers = [...new Set(scenario.facilityTypes.map((f) => tierOf(f.type)))].sort((a, b) => a - b);
  const pos = new Map<string, { x: number; y: number }>();
  tiers.forEach((t, col) =>
    scenario.facilityTypes
      .filter((f) => tierOf(f.type) === t)
      .forEach((f, row) => pos.set(f.type, { x: col * (LIC_W + LIC_GAP_X), y: row * (LIC_H + LIC_GAP_Y) })),
  );
  const width = tiers.length * (LIC_W + LIC_GAP_X) - LIC_GAP_X;
  const height = Math.max(...[...pos.values()].map((p) => p.y)) + LIC_H;

  return (
    <div className="report-overlay" role="dialog" aria-modal="true" aria-labelledby="licenses-title" onClick={onClose}>
      <div className="license-card" onClick={(e) => e.stopPropagation()}>
        <InspectorHead title="Licenses" onClose={onClose} />
        <p className="hint" id="licenses-title">
          Buy a facility’s license once, from the Budget, to build it. A license needs the licenses of whatever makes its inputs.
          Budget: <b>{fmt(state.cash)}g</b>
        </p>
        <div className="license-scroll">
          <div className="license-tree" style={{ width, height }}>
            <svg className="license-lines" width={width} height={height}>
              {scenario.facilityTypes.flatMap((f) =>
                licensePrereqs(scenario, f.type).map((pre) => {
                  const a = pos.get(pre)!;
                  const b = pos.get(f.type)!;
                  return (
                    <path
                      key={`${pre}-${f.type}`}
                      className={hasLicense(state, pre) ? 'met' : ''}
                      d={curve({ x: a.x + LIC_W, y: a.y + LIC_H / 2 }, { x: b.x, y: b.y + LIC_H / 2 })}
                    />
                  );
                }),
              )}
            </svg>
            {scenario.facilityTypes.map((f) => {
              const p = pos.get(f.type)!;
              const owned = hasLicense(state, f.type);
              const why = licenseBlocker(state, scenario, f.type);
              const prereqsMet = !licensePrereqs(scenario, f.type).some((t) => !hasLicense(state, t));
              return (
                <div
                  key={f.type}
                  className={'license' + (owned ? ' owned' : prereqsMet ? ' ready' : ' locked')}
                  style={{ left: p.x, top: p.y, width: LIC_W, height: LIC_H }}
                >
                  <div className="license-name">
                    <span className="swatch" style={{ background: colorOf(f.productId) }} />
                    {f.name}
                  </div>
                  <div className="license-sub">Build {fmt(f.buildCost)}g · {product(scenario, f.productId).name}</div>
                  {owned ? (
                    <div className="license-owned">✓ Licensed</div>
                  ) : (
                    <button className="primary" disabled={!!why} title={why ?? undefined} onClick={() => cmd({ kind: 'buyLicense', facilityType: f.type })}>
                      {prereqsMet ? `Buy · ${fmt(licenseCost(scenario, f.type))}g` : why}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function BankruptcyReport({ report, onClose }: { report: FlowBankruptcy; onClose: () => void }) {
  return (
    <div className="report-overlay" role="dialog" aria-modal="true" aria-labelledby="bankrupt-title">
      <div className="report-card flow-bankrupt">
        <h2 id="bankrupt-title">Bankrupt{report.count > 1 ? ` (×${report.count})` : ''}</h2>
        <p>You owed more than everything you owned for two bills running, so the creditors liquidated.</p>
        <dl className="facts">
          <dt>Money seized</dt>
          <dd>{fmt(report.seizedG)}g</dd>
          <dt>Blocks sold</dt>
          <dd>{report.sold.length ? `${report.sold.join(', ')} (${fmt(report.soldG)}g)` : 'none'}</dd>
          <dt>Debt forgiven</dt>
          <dd>{fmt(report.forgivenG)}g</dd>
          <dt>You keep</dt>
          <dd>{report.kept.join(', ') || 'nothing'}</dd>
        </dl>
        <button className="primary" onClick={onClose}>
          Start over with what’s left
        </button>
      </div>
    </div>
  );
}

// A pie that fills up as the next bill approaches, turning red in the last few seconds.
function BillPie({ elapsed, speed }: { elapsed: number; speed: number }) {
  const left = FLOW_SETTLE_SEC - elapsed;
  // The wedge is a stroke as wide as its own diameter, so it fills a disc of radius 2r.
  // Keep that disc (11) inside the outline (12) and the outline inside the 28px box.
  const r = 5.5;
  const circ = 2 * Math.PI * r;
  // Ease toward the next second at game speed; snap back (no transition) when a bill resets it.
  const transition = elapsed === 0 || speed === 0 ? 'none' : `stroke-dashoffset ${1 / speed}s linear`;
  return (
    <span className={'bill-pie' + (left <= 5 ? ' due' : '')} role="img" aria-label={`Bills in ${left} seconds`} title={`Bills in ${left}s`}>
      <svg width={28} height={28} viewBox="0 0 28 28">
        <circle className="bill-pie-track" cx={14} cy={14} r={12} />
        <circle
          className="bill-pie-fill"
          cx={14}
          cy={14}
          r={r}
          strokeWidth={r * 2}
          strokeDasharray={circ}
          strokeDashoffset={circ * (1 - elapsed / FLOW_SETTLE_SEC)}
          style={{ transition }}
          transform="rotate(-90 14 14)"
        />
      </svg>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

type Pt = { x: number; y: number };

// Every dot holds one wire. A block shows a dot per wire it has, and one free
// dot per port for the next connection. Inputs are grouped by kind (each good
// a facility uses, the market's any-good port, the money port), outputs stack
// down the right-hand side.
type Slot = { key: string; wireId: string | null; row: number };
type InSlot = Slot & { kind: string; first: boolean };
// `sepRow`: the first row of the upkeep group when goods inputs sit above it, else null.
type PortLayout = { ins: InSlot[]; outs: Slot[]; rows: number; sepRow: number | null };

// Which input group a wire lands in on `node`.
function inKindOf(node: FlowNode, w: Wire): string {
  if (w.productId === MONEY) return MONEY;
  return node.kind === 'market' ? '*goods' : w.productId;
}

function portLayout(node: FlowNode, state: FlowState, scenario: ScenarioConfig): PortLayout {
  const ins: InSlot[] = [];
  // A producer with no goods inputs (a Farm, a Supplier) gives its output a row
  // of its own, so the upkeep group sits below the divider like a Market's.
  const ownOutputRow = (node.kind === 'facility' || node.kind === 'supplier') && nodeInputs(node, scenario).length === 0;
  let row = ownOutputRow ? 1 : 0;
  for (const kind of inputRows(node, scenario)) {
    const wires = state.wires.filter((w) => w.to === node.id && inKindOf(node, w) === kind);
    wires.forEach((w, i) => ins.push({ key: w.id, kind, wireId: w.id, row: row++, first: i === 0 }));
    ins.push({ key: `${kind}:free`, kind, wireId: null, row: row++, first: wires.length === 0 });
  }
  const outWires = state.wires.filter((w) => w.from === node.id);
  const outs: Slot[] = outWires.map((w, i) => ({ key: w.id, wireId: w.id, row: i }));
  if (outputOf(node) !== null) outs.push({ key: 'out:free', wireId: null, row: outWires.length });
  const firstMoney = ins.find((s) => s.kind === MONEY)?.row ?? 0;
  return { ins, outs, rows: Math.max(row, outs.length), sepRow: firstMoney > 0 ? firstMoney : null };
}

// Pixel offset of a row inside the ports area, counting the divider above the upkeep group.
function rowTop(layout: PortLayout, row: number): number {
  return ROW * row + (layout.sepRow !== null && row >= layout.sepRow ? SEP_H : 0);
}

function portsHeight(layout: PortLayout): number {
  return rowTop(layout, layout.rows);
}

// Where a wire meets a block: its own dot, or the free dot when `wireId` is null.
function portPoint(n: FlowNode, layout: PortLayout, side: 'in' | 'out', wireId: string | null): Pt {
  const slots: Slot[] = side === 'out' ? layout.outs : layout.ins;
  const slot = slots.find((s) => s.wireId === wireId) ?? slots[slots.length - 1];
  return { x: side === 'out' ? n.x + NODE_W : n.x, y: n.y + HEADER + rowTop(layout, slot.row) + ROW / 2 };
}

function curve(a: Pt, b: Pt) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function WirePath({
  wire,
  pay,
  a,
  b,
  color,
  selected,
  onSelect,
}: {
  wire: Wire;
  pay: boolean;
  a: Pt;
  b: Pt;
  color: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const d = curve(a, b);
  const cap = wireCapacity(wire);
  const money = wire.productId === MONEY;
  const load = pay ? 0 : wire.movedLastSec / cap;
  // Dots travel faster the more the wire carries.
  const dur = wire.movedLastSec > 0 ? Math.max(0.35, 1.6 - load * 1.2) : 0;
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const on = isOn(wire);
  const label = !on ? 'off' : pay ? 'pays' : money ? `${fmt(wire.movedLastSec)}g/s` : `${wire.movedLastSec}/${cap}`;
  const labelW = Math.max(44, label.length * 6.5 + 12);
  return (
    <g
      className={'wire' + (selected ? ' selected' : '') + (load >= 1 ? ' maxed' : '') + (pay ? ' pay' : '') + (on ? '' : ' off')}
      onPointerDown={(e) => (e.stopPropagation(), onSelect())}
    >
      <path className="wire-hit" d={d} />
      <path className="wire-base" d={d} stroke={color} strokeWidth={2 + wire.level} />
      {dur > 0 && <path className="wire-flow" d={d} stroke={color} strokeWidth={2 + wire.level} style={{ animationDuration: `${dur}s` }} />}
      <g transform={`translate(${mid.x}, ${mid.y})`}>
        <rect className="wire-label-bg" x={-labelW / 2} y={-9} width={labelW} height={18} rx={9} />
        <text className="wire-label" textAnchor="middle" dy={4}>
          {label}
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
  unpaid: 'unpaid · stopped',
};

function NodeCard({
  node,
  state,
  scenario,
  layout,
  colorOf,
  selected,
  dropTarget,
  onHeaderDown,
  onPortDown,
  onSelect,
}: {
  node: FlowNode;
  state: FlowState;
  scenario: ScenarioConfig;
  layout: PortLayout;
  colorOf: (id: string) => string;
  selected: boolean;
  dropTarget: 'ok' | 'no' | null;
  onHeaderDown: (e: React.PointerEvent) => void;
  onPortDown: (e: React.PointerEvent) => void;
  onSelect: () => void;
}) {
  const inputs = batchInputs(node, scenario);
  const out = outputOf(node);
  const upkeep = nodeUpkeep(node, scenario);
  const wireOn = (id: string) => isOn(state.wires.find((w) => w.id === id)!);

  const inLabel = (id: string) => {
    if (id === '*goods') return <span className="port-label">sells anything</span>;
    if (id !== MONEY) {
      const inp = inputs.find((i) => i.id === id)!;
      return (
        <span className="port-label">
          {inp.qty}× {product(scenario, id).name}
          <span className="buf">{node.inBuf[id] ?? 0}</span>
        </span>
      );
    }
    if (node.kind === 'budget' || node.kind === 'wallet') return <span className="port-label">in</span>;
    if (node.kind === 'borrower') return <span className="port-label">repays {node.loan!.installmentPerCycle}g</span>;
    return (
      <span className="port-label">
        upkeep {upkeep}g{node.unpaid > 0 && <span className="owed">owes {fmt(node.unpaid)}g</span>}
      </span>
    );
  };

  const outLabel =
    out === null ? null : out !== MONEY ? (
      <>
        <span className="buf">{node.outBuf}</span>
        {node.kind === 'facility' && `${batchSize(node)}× `}
        {product(scenario, out).name}
      </>
    ) : (
      <span className="money">{fmt(node.kind === 'budget' ? state.cash : node.money)}g</span>
    );

  const foot = (() => {
    if (node.kind === 'facility' || node.kind === 'supplier')
      return (
        <>
          <span className="status-dot" />
          <span>{STATUS_TEXT[node.status]}</span>
          <span className="foot-rate">{+nodeRate(node, scenario).toFixed(2)}/s</span>
        </>
      );
    if (node.kind === 'market')
      return (
        <>
          <span className="status-dot" />
          <span>{node.status === 'unpaid' ? STATUS_TEXT.unpaid : `+${fmt(node.soldLastSec)}g/s`}</span>
        </>
      );
    if (node.kind === 'wallet')
      return (
        <>
          <span className="status-dot" />
          <span>{node.status === 'unpaid' ? STATUS_TEXT.unpaid : `keeps ${fmt(walletReserve(state, node, scenario))}g`}</span>
          <span className="foot-rate">upkeep {upkeep}g</span>
        </>
      );
    if (node.kind === 'budget')
      return (
        <>
          <span>global cash</span>
          <span className="foot-rate">no upkeep</span>
        </>
      );
    const l = node.loan!;
    return (
      <>
        <span>owes {fmt(l.balance + l.arrears)}g</span>
        {l.arrears > 0 && <span className="owed">arrears {fmt(l.arrears)}g</span>}
        <span className="foot-rate">no upkeep</span>
      </>
    );
  })();

  return (
    <div
      className={`flow-node kind-${node.kind} status-${node.status}` + (selected ? ' selected' : '') + (dropTarget ? ` drop-${dropTarget}` : '')}
      data-node-id={node.id}
      style={{ left: node.x, top: node.y, width: NODE_W }}
      onPointerDown={onSelect}
    >
      <div className="node-head" style={{ height: HEADER }} onPointerDown={onHeaderDown}>
        <span className="node-title">{nodeName(node, scenario)}</span>
        {distributionOf(node) === 'priority' && (
          <span className="node-mode" title="Priority: fills its top wire first">
            1→
          </span>
        )}
        {isUpgradable(node) && <span className="node-level">L{node.level}</span>}
      </div>
      <div className="node-ports" style={{ height: portsHeight(layout) }}>
        {Array.from({ length: layout.rows }, (_, r) => {
          const inSlot = layout.ins.find((s) => s.row === r);
          const outSlot = layout.outs.find((s) => s.row === r);
          const inColor = inSlot && inSlot.kind !== '*goods' ? colorOf(inSlot.kind) : undefined;
          return (
            <div
              key={r}
              className={'port-row' + (r === layout.sepRow ? ' after-sep' : '')}
              style={{ height: ROW, marginTop: r === layout.sepRow ? SEP_H : undefined }}
            >
              {inSlot && (
                <span
                  className={'port in' + (inSlot.wireId ? ' linked' : ' free') + (inSlot.wireId && !wireOn(inSlot.wireId) ? ' off' : '')}
                  style={inColor ? { borderColor: inColor, background: inSlot.wireId ? inColor : undefined } : undefined}
                />
              )}
              {inSlot?.kind === '*goods' && inSlot.wireId ? (
                <SalePriceLabel state={state} scenario={scenario} productId={state.wires.find((w) => w.id === inSlot.wireId)!.productId} />
              ) : inSlot?.first ? (
                inLabel(inSlot.kind)
              ) : (
                <span className="port-label" />
              )}
              {r === 0 && <span className="port-label out-label">{outLabel}</span>}
              {outSlot &&
                out !== null &&
                (outSlot.wireId ? (
                  <span className={'port out linked' + (wireOn(outSlot.wireId) ? '' : ' off')} style={{ background: colorOf(out) }} />
                ) : (
                  <span className="port out free" style={{ borderColor: colorOf(out) }} onPointerDown={onPortDown} title="Drag to connect" />
                ))}
            </div>
          );
        })}
      </div>
      <div className="node-foot">{foot}</div>
      {(node.kind === 'facility' || node.kind === 'supplier') && (
        <div className="out-fill" style={{ width: `${(node.outBuf / bufferCap(node)) * 100}%` }} />
      )}
    </div>
  );
}

// What one unit on this wire fetches at the market right now; red while the good is glutted.
function SalePriceLabel({ state, scenario, productId }: { state: FlowState; scenario: ScenarioConfig; productId: string }) {
  const now = salePrice(state, scenario, productId);
  const glutted = now < state.market[productId].price * 0.85;
  return (
    <span className="port-label unit-label" title={`${product(scenario, productId).name}: ${now.toFixed(1)}g per unit`}>
      <span className="unit-name">{product(scenario, productId).name}</span>
      <span className={'unit-price' + (glutted ? ' down' : '')}>{now.toFixed(1)}g each</span>
    </span>
  );
}

type InspectorProps = {
  node: FlowNode;
  state: FlowState;
  scenario: ScenarioConfig;
  cmd: (c: FlowCommand) => void;
  onClose: () => void;
};

function InspectorHead({ title, onClose }: { title: string; onClose: () => void }) {
  return (
    <div className="inspector-head">
      <h3>{title}</h3>
      <button className="x" onClick={onClose} aria-label="Close">
        ×
      </button>
    </div>
  );
}

function NodeInspector(props: InspectorProps) {
  const { node } = props;
  if (node.kind === 'wallet') return <WalletInspector {...props} />;
  if (node.kind === 'budget') return <BudgetInspector {...props} />;
  if (node.kind === 'borrower') return <BorrowerInspector {...props} />;
  return <BlockInspector {...props} />;
}

// Why a block isn't paid for, or null when it is.
function upkeepHint(node: FlowNode, state: FlowState, scenario: ScenarioConfig): string | null {
  if (node.unpaid <= 0 && nodeUpkeep(node, scenario) <= 0) return null; // nothing to pay
  const payers = payersOf(state, node);
  if (node.unpaid > 0)
    return payers.length
      ? `What pays it ran dry, so ${fmt(node.unpaid)}g of upkeep is unpaid and it has stopped. Add money, or wire in the Budget.`
      : 'Nobody pays its upkeep, so it has stopped. Drag from a Wallet’s or the Budget’s port to it.';
  if (!payers.length) return `Nothing pays its upkeep. It stops at the next bill unless you wire in a Wallet or the Budget.`;
  return null;
}

function BlockInspector({ node, state, scenario, cmd, onClose }: InspectorProps) {
  const inputs = nodeInputs(node, scenario);
  const up = isUpgradable(node) ? levelUpCost(node, scenario) : 0;
  const outgoing = state.wires.filter((w) => w.from === node.id).length;
  const payers = payersOf(state, node);
  const unpaidHint = upkeepHint(node, state, scenario);
  return (
    <div className="inspector">
      <InspectorHead title={nodeName(node, scenario)} onClose={onClose} />
      {unpaidHint && <p className="hint status-unpaid">{unpaidHint}</p>}
      {node.kind === 'market' && node.money >= 1 && !outgoing && (
        <p className="hint status-starved">Takings are piling up here. Wire the Market to a Wallet or the Budget to collect them.</p>
      )}
      {node.kind !== 'market' && node.status !== 'unpaid' && (
        <p className={`hint status-${node.status}`}>
          {node.status === 'starved' &&
            (node.kind === 'supplier'
              ? 'Whatever pays for it can’t afford more stock.'
              : `Waiting on ${inputs.map((i) => product(scenario, i.id).name).join(' and ')}. Wire a producer into it.`)}
          {node.status === 'blocked' && (outgoing ? 'Output is backed up. Upgrade its wire or add another route.' : 'Output has nowhere to go. Drag from its port to a buyer.')}
          {node.status === 'running' && 'Running smoothly.'}
          {node.status === 'idle' && (node.kind === 'supplier' && node.demand <= 0 ? 'Demand is 0, so it buys nothing.' : 'Warming up.')}
        </p>
      )}
      <dl className="facts">
        {node.productId && (
          <>
            {node.kind === 'facility' && (
              <>
                <dt>Each batch</dt>
                <dd>
                  {batchInputs(node, scenario)
                    .map((i) => `${i.qty} ${product(scenario, i.id).name}`)
                    .join(' + ')}
                  {nodeInputs(node, scenario).length ? ' → ' : ''}
                  {batchSize(node)} {product(scenario, node.productId).name}
                </dd>
              </>
            )}
            <dt>Makes</dt>
            <dd>
              {+nodeRate(node, scenario).toFixed(2)} {product(scenario, node.productId).name}/s
            </dd>
            <dt>Holds</dt>
            <dd>{node.kind === 'facility' ? `${bufferCap(node)} of each` : bufferCap(node)}</dd>
            <dt>Sells for now</dt>
            <dd>{salePrice(state, scenario, node.productId).toFixed(1)}g each</dd>
          </>
        )}
        {node.kind === 'supplier' && (
          <>
            <dt>Buys at</dt>
            <dd>{(state.market[node.productId!].price * SUPPLIER_MARKUP).toFixed(1)}g each, from whoever pays it</dd>
          </>
        )}
        {node.kind === 'market' && (
          <>
            <dt>Earning</dt>
            <dd>{fmt(node.soldLastSec)}g/s</dd>
            <dt>Not yet collected</dt>
            <dd>{fmt(node.money)}g</dd>
          </>
        )}
        <dt>Upkeep</dt>
        <dd>
          {nodeUpkeep(node, scenario)}g per bill{node.kind === 'supplier' && ` (${SUPPLIER_UPKEEP}g per unit/s)`}
        </dd>
        <dt>Paid by</dt>
        <dd>{payers.length ? payers.map((p) => nodeName(p.node, scenario)).join(', then ') : 'nobody'}</dd>
      </dl>
      {node.kind === 'supplier' && (
        <label className="demand">
          Demand
          <input
            type="number"
            min={0}
            max={SUPPLIER_MAX_DEMAND}
            step={0.5}
            value={node.demand}
            onChange={(e) => cmd({ kind: 'setDemand', nodeId: node.id, demand: Number(e.target.value) })}
          />
          {product(scenario, node.productId!).name}/s
        </label>
      )}
      <div className="inspector-actions">
        {isUpgradable(node) && (
          <button className="primary" disabled={state.cash < up} onClick={() => cmd({ kind: 'levelUp', nodeId: node.id })}>
            Upgrade to L{node.level + 1} · {fmt(up)}g
          </button>
        )}
        <SellButton node={node} cmd={cmd} onClose={onClose} />
      </div>
      <OutputsList node={node} state={state} scenario={scenario} cmd={cmd} />
    </div>
  );
}

// A block's outgoing wires, top to bottom: the order priority mode fills them
// in, and the order a short Wallet pays its blocks. Each can be switched off.
function OutputsList({ node, state, scenario, cmd }: { node: FlowNode; state: FlowState; scenario: ScenarioConfig; cmd: (c: FlowCommand) => void }) {
  const outs = state.wires.filter((w) => w.from === node.id);
  if (!outs.length) return null;
  const splits = outs.some((w) => !isPayLink(state, w)); // only flowing output is split by the mode
  const mode = distributionOf(node);
  return (
    <div className="outputs">
      <div className="outputs-head">
        <h3>Outputs</h3>
        {splits && (
          <div className="seg" role="group" aria-label="How output is split">
            {(['balance', 'priority'] as const).map((m) => (
              <button key={m} className={mode === m ? 'active' : ''} aria-pressed={mode === m} onClick={() => cmd({ kind: 'setDistribution', nodeId: node.id, mode: m })}>
                {m === 'balance' ? 'Balance' : 'Priority'}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="hint">
        {splits && mode === 'priority'
          ? 'Fills the top wire first; the next one only gets what the one above can’t take.'
          : splits
            ? 'Splits output evenly across every wire that’s on.'
            : 'Bills are paid top to bottom when money runs short.'}
      </p>
      <ol className="outputs-list">
        {outs.map((w, i) => {
          const to = state.nodes.find((n) => n.id === w.to);
          return (
            <li key={w.id} className={isOn(w) ? '' : 'off'}>
              <span className="outputs-name">
                {to ? nodeName(to, scenario) : '?'}
                {isPayLink(state, w) && <span className="outputs-tag">pays</span>}
              </span>
              <button aria-label="Move up" disabled={i === 0} onClick={() => cmd({ kind: 'moveWire', wireId: w.id, dir: -1 })}>
                ↑
              </button>
              <button aria-label="Move down" disabled={i === outs.length - 1} onClick={() => cmd({ kind: 'moveWire', wireId: w.id, dir: 1 })}>
                ↓
              </button>
              <button className={'outputs-toggle' + (isOn(w) ? ' active' : '')} aria-pressed={isOn(w)} onClick={() => cmd({ kind: 'toggleWire', wireId: w.id })}>
                {isOn(w) ? 'On' : 'Off'}
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function SellButton({ node, cmd, onClose }: { node: FlowNode; cmd: (c: FlowCommand) => void; onClose: () => void }) {
  return (
    <button
      onClick={() => {
        cmd({ kind: 'sellNode', nodeId: node.id });
        onClose();
      }}
    >
      Sell for {fmt(node.invested * NODE_RESALE_RATE + node.money)}g
    </button>
  );
}

function WalletInspector({ node, state, scenario, cmd, onClose }: InspectorProps) {
  const [amount, setAmount] = useState(100);
  const pays = state.wires.filter((w) => w.from === node.id && isPayLink(state, w)).length;
  return (
    <div className="inspector">
      <InspectorHead title="Wallet" onClose={onClose} />
      <p className={'hint' + (node.unpaid > 0 ? ' status-unpaid' : '')}>
        {node.unpaid > 0
          ? 'Empty, so it can’t pay its own upkeep or anyone else’s. Move money in.'
          : 'Pays the upkeep of every block it’s wired into. A wire into the Budget sends everything above the next bill.'}
      </p>
      <dl className="facts">
        <dt>Balance</dt>
        <dd>{fmt(node.money)}g</dd>
        <dt>Upkeep</dt>
        <dd>{nodeUpkeep(node, scenario)}g per bill, paid by itself</dd>
        <dt>Pays for</dt>
        <dd>
          {pays} block{pays === 1 ? '' : 's'}
        </dd>
        <dt>Keeps for next bill</dt>
        <dd>{fmt(walletReserve(state, node, scenario))}g</dd>
      </dl>
      <div className="transfer">
        <input type="number" min={0} step={50} value={amount} onChange={(e) => setAmount(Math.max(0, Math.round(Number(e.target.value)) || 0))} />
        <span>g</span>
        <button disabled={state.cash <= 0 || amount <= 0} onClick={() => cmd({ kind: 'transferMoney', nodeId: node.id, amount })}>
          From Budget
        </button>
        <button disabled={node.money < 1 || amount <= 0} onClick={() => cmd({ kind: 'transferMoney', nodeId: node.id, amount: -amount })}>
          To Budget
        </button>
      </div>
      <div className="inspector-actions">
        <SellButton node={node} cmd={cmd} onClose={onClose} />
      </div>
      <OutputsList node={node} state={state} scenario={scenario} cmd={cmd} />
    </div>
  );
}

function BudgetInspector({ node, state, scenario, cmd, onClose }: InspectorProps) {
  const count = state.nodes.filter((n) => n.kind === 'budget').length;
  return (
    <div className="inspector">
      <InspectorHead title="Budget" onClose={onClose} />
      <p className="hint">
        Your global cash. Building, wires and upgrades are paid from here, and it pays the upkeep or installments of any block you wire
        it into. Collect money into it with wires from a Market, Wallet or Borrower. Fund a Wallet from that Wallet’s panel.
      </p>
      <dl className="facts">
        <dt>Balance</dt>
        <dd>{fmt(state.cash)}g</dd>
        <dt>Owed on loans</dt>
        <dd>{fmt(debt(state))}g</dd>
        <dt>Upkeep</dt>
        <dd>none</dd>
        <dt>Budget blocks</dt>
        <dd>{count}, all one balance</dd>
      </dl>
      {count > 1 && (
        <div className="inspector-actions">
          <button
            onClick={() => {
              cmd({ kind: 'sellNode', nodeId: node.id });
              onClose();
            }}
          >
            Remove this Budget block
          </button>
        </div>
      )}
      <OutputsList node={node} state={state} scenario={scenario} cmd={cmd} />
    </div>
  );
}

function BorrowerInspector({ node, state, cmd, onClose }: InspectorProps) {
  const l = node.loan!;
  const payers = payersOf(state, node);
  const owed = l.balance + l.arrears;
  return (
    <div className="inspector">
      <InspectorHead title={`${l.label} loan`} onClose={onClose} />
      <p className={'hint' + (payers.length ? '' : ' status-unpaid')}>
        {payers.length
          ? `Collects ${l.installmentPerCycle}g every bill from what’s wired into it.`
          : 'Nothing repays it. Wire a Wallet or the Budget into it, or every installment becomes arrears.'}
      </p>
      <dl className="facts">
        <dt>Left to repay</dt>
        <dd>{fmt(l.balance)}g</dd>
        <dt>Each bill</dt>
        <dd>{l.installmentPerCycle}g</dd>
        <dt>Arrears</dt>
        <dd className={l.arrears > 0 ? 'down' : ''}>{fmt(l.arrears)}g</dd>
        <dt>Upkeep</dt>
        <dd>none</dd>
      </dl>
      <div className="inspector-actions">
        {l.arrears > 0 && (
          <button disabled={state.cash <= 0} onClick={() => cmd({ kind: 'payArrears', nodeId: node.id })}>
            Pay arrears from Budget · {fmt(Math.min(l.arrears, state.cash))}g
          </button>
        )}
        <button
          className="primary"
          disabled={state.cash < owed}
          title={state.cash < owed ? `The Budget needs ${fmt(owed)}g` : undefined}
          onClick={() => {
            cmd({ kind: 'payOffLoan', nodeId: node.id });
            onClose();
          }}
        >
          Pay in full from Budget · {fmt(owed)}g
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
  const pay = isPayLink(state, wire);
  const money = wire.productId === MONEY;
  const to = state.nodes.find((n) => n.id === wire.to);
  return (
    <div className="inspector">
      <InspectorHead title={pay ? 'Payment link' : money ? 'Money line' : `${product(scenario, wire.productId).name} line`} onClose={onClose} />
      {pay && to && <p className="hint">Pays the {to.kind === 'borrower' ? 'installments' : 'upkeep'} of {nodeName(to, scenario)} when each bill falls due.</p>}
      {money && !pay && <p className="hint">Carries any amount, so it never needs upgrading.</p>}
      {!pay && (
        <dl className="facts">
          <dt>Carrying</dt>
          <dd>{money ? `${fmt(wire.movedLastSec)}g/s` : `${wire.movedLastSec} of ${wireCapacity(wire)}/s`}</dd>
          {!money && (
            <>
              <dt>Level</dt>
              <dd>{wire.level}</dd>
            </>
          )}
        </dl>
      )}
      <div className="inspector-actions">
        {!money && (
          <button className="primary" disabled={state.cash < cost} onClick={() => cmd({ kind: 'upgradeWire', wireId: wire.id })}>
            Double capacity · {fmt(cost)}g
          </button>
        )}
        <button onClick={() => cmd({ kind: 'toggleWire', wireId: wire.id })}>{isOn(wire) ? 'Switch off' : 'Switch on'}</button>
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

function Overview({ state, scenario, onClose }: { state: FlowState; scenario: ScenarioConfig; onClose: () => void }) {
  return (
    <div className="inspector">
      <InspectorHead title="How it works" onClose={onClose} />
      <ol className="howto">
        <li>Drag from a block’s output port to another block to lay a wire ({WIRE_COST}g).</li>
        <li>Goods flow from farms through processors into a Market. The Market holds its takings until a gold money wire carries them to a Wallet or the Budget.</li>
        <li>Every block’s upkeep is paid by a Wallet or the Budget wired into it (Wallets first). A block nobody pays stops.</li>
        <li>The Budget pays for building. Fund a Wallet when you open it, or move money from the Wallet’s panel.</li>
        <li>A loan pays its whole amount into the Budget. Its block collects each installment from a Wallet or the Budget wired into it, or you can pay it off in full from its panel.</li>
        <li>Flooding the market with one good drops its price. Process it into something worth more.</li>
        <li>Bills fall due every {FLOW_SETTLE_SEC}s.</li>
        <li>
          Equity is everything you own minus everything you owe. Below 0 at a bill and you’re insolvent; still below at the next bill and
          the creditors liquidate, leaving you your cheapest Farm and Market and a Wallet with a little money.
        </li>
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
