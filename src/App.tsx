import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { makeDiscoveryChecker } from './engine/discovery';
import { newGame } from './engine/newGame';
import { buildRecipeTree } from './engine/recipeTree';
import {
  applyCommand,
  effectiveCapacity,
  estimateBills,
  estimateRecipeSalePrice,
  ingredientResearchCost,
  levelUpCost,
  levelUpDuration,
  loanCreditLimit,
  LOAN_TERM_TURNS,
  MAX_FACILITY_LEVEL,
  outstandingDebt,
  tick,
  type Command,
} from './engine/reducer';
import type { GameState, ResourceId } from './engine/types';
import { bakeryScenario } from './scenarios/bakery/config';
import { breweryScenario } from './scenarios/brewery/config';
import type { ScenarioConfig } from './scenarios/types';
import { MarketIntelView, type MarketIntel } from './ui/MarketIntelView';
import { RecipeTreeView } from './ui/RecipeTreeView';

const SCENARIOS: { config: ScenarioConfig; blurb: string }[] = [
  { config: breweryScenario, blurb: 'License politics & production chains — barley to bottled beer. Higher capex, harder license gates.' },
  { config: bakeryScenario, blurb: 'The tutorial track — cheap licenses, low capex, and the only scenario where unsold stock spoils.' },
];
const SEED = 1234;

type Tab = 'licenses' | 'research' | 'facilities' | 'contracts' | 'bank' | 'payments' | 'defenses' | 'leaderboard';

const TABS: { id: Tab; label: string }[] = [
  { id: 'licenses', label: 'Licenses' },
  { id: 'research', label: 'Research' },
  { id: 'facilities', label: 'Facilities' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'bank', label: 'Bank' },
  { id: 'payments', label: 'Payments' },
  { id: 'defenses', label: 'Defenses' },
  { id: 'leaderboard', label: 'Leaderboard' },
];

function App() {
  const [scenario, setScenario] = useState<ScenarioConfig | null>(null);

  if (!scenario) {
    return (
      <div className="scenario-picker">
        <h1>License Economy</h1>
        <p className="muted">Choose a scenario to play.</p>
        <div className="scenario-cards">
          {SCENARIOS.map((s) => (
            <button key={s.config.id} className="scenario-card" onClick={() => setScenario(s.config)}>
              <h2>{s.config.name}</h2>
              <p>{s.blurb}</p>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return <Game key={scenario.id} scenario={scenario} onExit={() => setScenario(null)} />;
}

function Game({ scenario, onExit }: { scenario: ScenarioConfig; onExit: () => void }) {
  function resourceName(id: ResourceId): string {
    return scenario.resources.find((r) => r.id === id)?.name ?? id;
  }

  const [state, setState] = useState<GameState>(() => newGame(scenario, SEED));
  const [tab, setTab] = useState<Tab>('licenses');
  const [treeResource, setTreeResource] = useState<ResourceId | null>(null);
  const [intelResource, setIntelResource] = useState<ResourceId | null>(null);
  const [showAllMarket, setShowAllMarket] = useState(false);
  const [researchPick, setResearchPick] = useState<ResourceId[]>([]);
  const [targetTier, setTargetTier] = useState(1);
  const [supplyForm, setSupplyForm] = useState({
    side: 'sell' as 'sell' | 'buy',
    resourceId: scenario.resources[0].id,
    qtyPerTurn: 5,
    price: scenario.resources[0].basePrice,
    turnsLeft: 5,
  });
  const [buildForm, setBuildForm] = useState(() => {
    const isDiscoveredAtStart = makeDiscoveryChecker(state);
    const facilityType =
      scenario.facilityTypes.find((f) => scenario.resources.some((r) => r.facility === f.type && isDiscoveredAtStart(r.id)))?.type ??
      scenario.facilityTypes[0].type;
    const resourceId = (
      scenario.resources.find((r) => r.facility === facilityType && isDiscoveredAtStart(r.id)) ??
      scenario.resources.find((r) => r.facility === facilityType)!
    ).id;
    return { facilityType, resourceId };
  });
  const [borrowAmount, setBorrowAmount] = useState(500);

  const [prevPrices, setPrevPrices] = useState<Record<string, number>>({});
  const [flash, setFlash] = useState<string[]>([]); // recent event log lines
  const ledgerSeen = useRef(1);

  // Turn-based: nothing advances on its own. Capture pre-turn prices (for
  // ▲▼ deltas) right before applying the turn, then call tick() once.
  function endTurn() {
    const snap: Record<string, number> = {};
    for (const [id, e] of Object.entries(state.market)) snap[id] = e.price;
    setPrevPrices(snap);
    setState((cur) => (cur.gameOver ? cur : tick(cur, scenario)));
  }

  // Surface interesting new ledger entries as a short event feed.
  useEffect(() => {
    const fresh = state.ledger.slice(ledgerSeen.current);
    ledgerSeen.current = state.ledger.length;
    const interesting = fresh
      .filter((e) => /discovered|granted|Spoiled|breach|lawsuit|Quest|suspend|lapsed|fire|spike|flood|failure/i.test(e.label))
      .map((e) => e.label);
    if (interesting.length) setFlash((f) => [...interesting, ...f].slice(0, 4));
  }, [state.ledger]);

  const netWorth = useMemo(() => {
    const facilityValue = state.player.facilities.reduce((sum, f) => {
      const def = scenario.facilityTypes.find((d) => d.type === f.type)!;
      return sum + def.buildCost * (f.condition / 100);
    }, 0);
    const invValue = Object.entries(state.player.inventory).reduce((sum, [id, e]) => {
      const r = scenario.resources.find((res) => res.id === id);
      return sum + (r ? r.basePrice * e.qty : 0);
    }, 0);
    return Math.round(state.player.cash + facilityValue + invValue - outstandingDebt(state.player));
  }, [state]);

  const leaderboard = useMemo(() => {
    // Rivals in this engine only track cash (no facilities/inventory model),
    // so their standing is cash-only — not a perfect apples-to-apples with
    // the player's full net worth, but it's the best available comparison.
    const entries = [
      { name: 'You', isPlayer: true, standing: netWorth, reputation: state.player.reputation, licenses: state.player.licenses.length, personality: undefined as string | undefined },
      ...state.rivals.map((r) => ({
        name: r.name,
        isPlayer: false,
        standing: Math.round(r.cash),
        reputation: r.reputation,
        licenses: r.licenses.length,
        personality: r.personality as string | undefined,
      })),
    ];
    return entries.sort((a, b) => b.standing - a.standing);
  }, [state, netWorth]);

  const creditLimit = useMemo(() => loanCreditLimit(state.player, scenario), [state]);
  const bills = useMemo(() => estimateBills(state, scenario), [state]);

  const recipeTree = useMemo(() => {
    if (!treeResource) return null;
    return buildRecipeTree(treeResource, scenario.resources, state.recipes, state.market, state.player.knowledge.knownRecipeIds);
  }, [treeResource, state]);

  const marketIntel: MarketIntel | null = useMemo(() => {
    if (!intelResource) return null;
    const id = intelResource;
    return {
      resourceId: id,
      resourceName: resourceName(id),
      boardQuests: state.contractBoard.filter((o) => o.resourceId === id),
      boardStanding: state.standingOfferBoard.filter((o) => o.resourceId === id),
      myQuests: state.player.questContracts.filter((c) => c.resourceId === id),
      mySupply: state.player.supplyContracts.filter((c) => c.resourceId === id),
      rivals: state.rivals
        .map((rival) => ({
          rival,
          postedPrice: rival.postedPrices[id],
          licensed: rival.licenses.some((l) => l.resourceId === id && l.status === 'active'),
        }))
        .filter((r) => r.postedPrice !== undefined || r.licensed),
    };
  }, [intelResource, state]);

  const pendingDisclosure = useMemo(() => {
    const pending = state.pendingDisclosures[0];
    if (!pending) return null;
    const recipe = state.recipes.find((r) => r.id === pending.recipeId);
    if (!recipe) return null;
    const resource = scenario.resources.find((r) => r.id === recipe.output)!;
    return { recipe, resource, salePrice: estimateRecipeSalePrice(resource), queueLength: state.pendingDisclosures.length };
  }, [state]);

  const isDiscovered = useMemo(() => makeDiscoveryChecker(state), [state]);

  const visibleResources = useMemo(() => {
    if (showAllMarket) return scenario.resources;
    return scenario.resources.filter((r) => isDiscovered(r.id));
  }, [isDiscovered, showAllMarket]);
  const hiddenCount = scenario.resources.length - visibleResources.length;

  const visibleLicenses = useMemo(() => {
    return scenario.licenses.filter((def) => isDiscovered(def.resourceId));
  }, [isDiscovered]);
  const hiddenLicenseCount = scenario.licenses.length - visibleLicenses.length;

  const discoverableCount = useMemo(() => {
    const known = state.player.knowledge.knownRecipeIds;
    const isResourceKnown = (rid: ResourceId) => state.recipes.some((r) => r.output === rid && known.has(r.id));
    return state.recipes.filter((r) => !known.has(r.id) && r.inputs.every((i) => isResourceKnown(i.ingredientId))).length;
  }, [state]);

  const knownResources = useMemo(() => {
    const known = state.player.knowledge.knownRecipeIds;
    return scenario.resources.filter((r) => state.recipes.some((rc) => rc.output === r.id && known.has(rc.id)));
  }, [state]);

  const availableTiers = useMemo(() => {
    return [...new Set(scenario.resources.filter((r) => r.tier > 0).map((r) => r.tier))].sort((a, b) => a - b);
  }, [scenario]);

  const pickMatches = useMemo(() => {
    if (researchPick.length === 0) return 0;
    const known = state.player.knowledge.knownRecipeIds;
    const chosen = new Set(researchPick);
    return state.recipes.filter(
      (r) =>
        !known.has(r.id) &&
        r.inputs.length > 0 &&
        r.inputs.every((i) => chosen.has(i.ingredientId)) &&
        scenario.resources.find((res) => res.id === r.output)?.tier === targetTier
    ).length;
  }, [researchPick, targetTier, state]);

  // Instant action: apply a command immediately and re-render.
  function cmd(c: Command) {
    setState((cur) => applyCommand(cur, c, scenario));
  }

  function toggleResearchPick(id: ResourceId) {
    setResearchPick((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const activeCommission = state.player.knowledge.activeCommission;

  if (state.gameOver) {
    return (
      <div className="game-over">
        <h1>{state.gameOver.result === 'won' ? 'You won!' : state.gameOver.result === 'bankrupt' ? 'Bankrupt.' : 'Run ended.'}</h1>
        <p className="muted">Ended at turn {state.gameOver.turn}. Final net worth: {netWorth}g</p>
        <button onClick={onExit}>Choose a scenario</button>
      </div>
    );
  }

  function priceDelta(id: ResourceId, current: number) {
    const prev = prevPrices[id];
    if (prev === undefined || Math.abs(current - prev) < 0.05) return null;
    const up = current > prev;
    return <span className={up ? 'delta-up' : 'delta-down'}>{up ? '▲' : '▼'}{Math.abs(current - prev).toFixed(1)}</span>;
  }

  return (
    <div className="game">
      <header className="hud">
        <div className="title">
          License Economy
          <small>{scenario.name.toUpperCase()} · Turn {state.turn} / 60</small>
        </div>
        <div className="stat"><span className="label">Cash</span><span className="value">{Math.round(state.player.cash)}g</span></div>
        <div className="stat"><span className="label">Net worth</span><span className="value">{netWorth}g</span></div>
        <div className="stat"><span className="label">Reputation</span><span className="value">{Math.round(state.player.reputation)}</span></div>
        <div className="stat"><span className="label">Licenses</span><span className="value">{state.player.licenses.length}/{state.player.licenseSlots}</span></div>

        <div className="effects">
          {state.activeEffects.map((e) => (
            <div key={e.id} className="effect-badge">{e.label} · {e.turnsLeft} turns</div>
          ))}
        </div>

        <button className="exit-btn" onClick={onExit} title="Abandon this run and pick a different scenario">Switch scenario</button>
      </header>

      {state.pendingLawsuit && (
        <div className="prompt-overlay">
          <div className="prompt-card">
            <h3>⚖ {state.pendingLawsuit.label}</h3>
            <p className="muted">
              Settle for {state.pendingLawsuit.settleCost}g, or fight — {Math.round(state.pendingLawsuit.fightWinChance * 100)}% chance
              to win, losing costs {state.pendingLawsuit.fightLoseCost}g and reputation.
            </p>
            <div className="choices">
              <button onClick={() => cmd({ kind: 'lawsuitDecision', decision: 'settle' })}>Settle</button>
              <button onClick={() => cmd({ kind: 'lawsuitDecision', decision: 'fight' })}>Fight</button>
            </div>
            <p className="hint">You can resolve this whenever — it won't block ending your turn.</p>
          </div>
        </div>
      )}

      {pendingDisclosure && (
        <div className="prompt-overlay">
          <div className="prompt-card">
            <h3>🔬 You discovered {pendingDisclosure.resource.name}!</h3>
            <p className="muted">
              Decide what happens to this recipe. Whatever you pick, you keep using it yourself either way.
            </p>
            <div className="choices disclosure-choices">
              <button onClick={() => cmd({ kind: 'resolveDisclosure', choice: 'free' })}>
                <strong>Publish free</strong>
                <span className="desc">Public to every rival immediately. No reward, no downside.</span>
              </button>
              <button onClick={() => cmd({ kind: 'resolveDisclosure', choice: 'exclusive' })}>
                <strong>Stay exclusive (30 turns)</strong>
                <span className="desc">Only you can make it — until the countdown ends, then it auto-publishes.</span>
              </button>
              <button onClick={() => cmd({ kind: 'resolveDisclosure', choice: 'sell' })}>
                <strong>Sell privately (~{pendingDisclosure.salePrice}g)</strong>
                <span className="desc">One rival pays for it and learns it. Stays secret from everyone else.</span>
              </button>
            </div>
            {pendingDisclosure.queueLength > 1 && (
              <p className="hint">{pendingDisclosure.queueLength - 1} more discovery decision(s) waiting after this one.</p>
            )}
            <p className="hint">You can resolve this whenever — it won't block ending your turn.</p>
          </div>
        </div>
      )}

      <div className="main">
        <section className="panel market-col">
          <div className="panel-head market-head">
            <h2>Market &amp; Inventory</h2>
            <label className="show-all-toggle">
              <input type="checkbox" checked={showAllMarket} onChange={(e) => setShowAllMarket(e.target.checked)} />
              Show undiscovered{hiddenCount > 0 && !showAllMarket ? ` (${hiddenCount})` : ''}
            </label>
          </div>
          <div className="panel-body">
            <table>
              <thead>
                <tr><th>Resource</th><th className="num">Price</th><th className="num">Held</th><th className="num">Rate</th></tr>
              </thead>
              <tbody>
                {visibleResources.map((r) => {
                  const entry = state.market[r.id];
                  const licensed = state.player.licenses.some((l) => l.resourceId === r.id && l.status === 'active');
                  const recipe = state.recipes.find((rec) => rec.output === r.id);
                  const known = recipe !== undefined && state.player.knowledge.knownRecipeIds.has(recipe.id);
                  const facility = state.player.facilities.find((f) => f.type === r.facility && f.buildTurnsLeft === 0);
                  const on = state.player.autoProduce.includes(r.id);
                  // Capacity is a flat per-turn number.
                  const perTurn = facility ? Math.round(effectiveCapacity(facility)) : 0;
                  return (
                    <tr key={r.id} className="clickable-row" title="Click row for contracts & competitor intel"
                      onClick={() => setIntelResource(r.id)}>
                      <td className="cell-clip" title={`${r.name} — click for recipe tree`}>
                        <button className="resource-link" onClick={(e) => { e.stopPropagation(); setTreeResource(r.id); }}>{r.name}</button>
                        <span className="tier-chip">T{r.tier}</span>
                      </td>
                      <td className="num">{entry.price.toFixed(1)}g{priceDelta(r.id, entry.price)}</td>
                      <td className="num">{state.player.inventory[r.id]?.qty ?? 0}</td>
                      <td className="num">{licensed && known && facility ? `${perTurn}/turn${on ? '' : ' (off)'}` : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel tab-col">
          <div className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`} onClick={() => setTab(t.id)}>
                {t.label}
                {t.id === 'contracts' && state.contractBoard.length > 0 && <span className="badge">{state.contractBoard.length}</span>}
              </button>
            ))}
          </div>
          <div className="panel-body">
            {tab === 'licenses' && (
              <>
                {hiddenLicenseCount > 0 && (
                  <p className="hint" style={{ margin: '0 4px 8px' }}>
                    {hiddenLicenseCount} undiscovered license{hiddenLicenseCount === 1 ? '' : 's'} hidden — discover the resource first (Research tab).
                  </p>
                )}
                <table>
                <thead><tr><th>Resource</th><th>Class</th><th className="num">Cost</th><th>Status</th><th>Current owner(s)</th><th></th></tr></thead>
                <tbody>
                  {visibleLicenses.map((def) => {
                    const held = state.player.licenses.find((l) => l.resourceId === def.resourceId);
                    const recipe = state.recipes.find((rc) => rc.output === def.resourceId);
                    const recipeKnown = recipe !== undefined && state.player.knowledge.knownRecipeIds.has(recipe.id);
                    const owners: string[] = [];
                    if (held) owners.push(held.status === 'active' ? 'You' : `You (${held.status})`);
                    for (const rival of state.rivals) {
                      const rivalLic = rival.licenses.find((l) => l.resourceId === def.resourceId && l.status === 'active');
                      if (rivalLic) owners.push(rival.name);
                    }
                    return (
                      <tr key={def.resourceId}>
                        <td className="resource-name">{resourceName(def.resourceId)}</td>
                        <td className="muted">{def.class}</td>
                        <td className="num">{def.upfrontCost}g + {def.renewalCost}g/{def.renewalPeriod} turns</td>
                        <td>
                          {held ? (
                            <span className="lic-yes">{held.status}</span>
                          ) : (
                            <span className="muted">not held{recipeKnown ? ' — recipe known, license not bought' : ''}</span>
                          )}
                        </td>
                        <td className="muted">{owners.length > 0 ? owners.join(', ') : 'unclaimed'}</td>
                        <td>
                          {!held && (
                            <button
                              disabled={state.player.licenses.length >= state.player.licenseSlots || state.player.reputation < def.minReputation || state.player.cash < def.upfrontCost}
                              onClick={() => cmd({ kind: 'buyLicense', resourceId: def.resourceId })}>
                              Buy
                            </button>
                          )}
                          {held && <button onClick={() => cmd({ kind: 'dropLicense', resourceId: def.resourceId })}>Drop</button>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                </table>
              </>
            )}

            {tab === 'research' && (
              <>
                <p className="muted" style={{ margin: '6px 4px' }}>
                  Active commission:{' '}
                  {activeCommission
                    ? `${activeCommission.blind ? 'Breakthrough research' : `Experimenting with ${(activeCommission.ingredients ?? []).map(resourceName).join(', ')}`} — ${activeCommission.turnsLeft} turns left`
                    : 'none'}
                </p>

                <h3 className="sub">Breakthrough (3 ticks · {scenario.researchCost}g)</h3>
                <p className="hint" style={{ margin: '0 4px 8px' }}>
                  A breakthrough finds a random recipe you can now reach — one whose ingredients you already know how to make.
                  {discoverableCount > 0 ? ` ${discoverableCount} within reach.` : ' Nothing new within reach — discover more ingredients first.'}
                </p>
                <button className="discover-btn" disabled={!!activeCommission || discoverableCount === 0 || state.player.cash < scenario.researchCost} onClick={() => cmd({ kind: 'researchBlind' })}>
                  🔬 Breakthrough · {scenario.researchCost}g
                </button>

                <h3 className="sub">Or experiment with ingredients (3 ticks · {ingredientResearchCost(targetTier)}g)</h3>
                <p className="hint" style={{ margin: '0 4px 8px' }}>
                  Pick ingredients you know how to make and a tier to aim for; research finds a recipe of that tier built from them.
                  Costs more for higher tiers — you're paying for precision, not luck.
                </p>
                {knownResources.length === 0 ? (
                  <p className="muted" style={{ padding: '0 4px' }}>Discover an ingredient first (try a breakthrough).</p>
                ) : (
                  <>
                    <div className="btn-row">
                      {knownResources.map((r) => (
                        <button key={r.id} className={researchPick.includes(r.id) ? 'pick-chip selected' : 'pick-chip'}
                          disabled={!!activeCommission} onClick={() => toggleResearchPick(r.id)}>
                          {researchPick.includes(r.id) ? '✓ ' : ''}{r.name}
                        </button>
                      ))}
                    </div>
                    <div className="btn-row" style={{ marginTop: '6px' }}>
                      {availableTiers.map((t) => (
                        <button key={t} className={targetTier === t ? 'pick-chip selected' : 'pick-chip'}
                          disabled={!!activeCommission} onClick={() => setTargetTier(t)}>
                          {targetTier === t ? '✓ ' : ''}Tier {t} · {ingredientResearchCost(t)}g
                        </button>
                      ))}
                    </div>
                    <button className="discover-btn" disabled={!!activeCommission || researchPick.length === 0 || state.player.cash < ingredientResearchCost(targetTier)}
                      onClick={() => { cmd({ kind: 'researchByIngredients', ingredients: [...researchPick], targetTier }); setResearchPick([]); }}>
                      ⚗ Experiment with selection · {ingredientResearchCost(targetTier)}g
                    </button>
                    {researchPick.length > 0 && (
                      <p className="hint" style={{ margin: '6px 4px 0' }}>
                        {pickMatches > 0
                          ? `${pickMatches} undiscovered tier-${targetTier} recipe${pickMatches > 1 ? 's' : ''} can be built from this selection.`
                          : `No undiscovered tier-${targetTier} recipe uses only these ingredients — add or change your picks, or try a different tier.`}
                      </p>
                    )}
                  </>
                )}

                <h3 className="sub">Known recipes</h3>
                {state.player.knowledge.knownRecipeIds.size === 0 ? (
                  <div className="muted" style={{ padding: '0 4px' }}>None yet — research to discover recipes.</div>
                ) : (
                  <div className="btn-row" style={{ padding: '0 4px' }}>
                    {[...state.player.knowledge.knownRecipeIds].map((id) => {
                      const recipe = state.recipes.find((rc) => rc.id === id);
                      const exclusive = recipe && recipe.exclusiveTurnsLeft !== undefined && recipe.exclusiveTurnsLeft > 0;
                      return (
                        <span key={id} className="known-recipe-chip">
                          {resourceName(recipe?.output ?? id)}
                          {exclusive && <span className="exclusive-badge">🔒 exclusive · {recipe!.exclusiveTurnsLeft} turns</span>}
                          {!exclusive && recipe?.published && <span className="muted"> (public)</span>}
                        </span>
                      );
                    })}
                  </div>
                )}
              </>
            )}

            {tab === 'facilities' && (
              <>
                <table>
                  <thead><tr><th>Type</th><th>Producing</th><th>Output</th><th className="num">Level</th><th>Status</th><th className="num">Capacity</th><th>Workers</th><th></th></tr></thead>
                  <tbody>
                    {state.player.facilities.map((f) => {
                      const def = scenario.facilityTypes.find((ft) => ft.type === f.type)!;
                      const options = scenario.resources.filter((r) => r.facility === f.type && isDiscovered(r.id));
                      const upCost = levelUpCost(def, f.level);
                      const upDuration = levelUpDuration(def);
                      const atMax = f.level >= MAX_FACILITY_LEVEL;
                      const leveling = f.levelUpTurnsLeft !== undefined;
                      const building = f.buildTurnsLeft > 0;
                      const licensed = state.player.licenses.some((l) => l.resourceId === f.assignedResourceId && l.status === 'active');
                      const recipe = state.recipes.find((rec) => rec.output === f.assignedResourceId);
                      const known = recipe !== undefined && state.player.knowledge.knownRecipeIds.has(recipe.id);
                      const producing = state.player.autoProduce.includes(f.assignedResourceId);
                      return (
                        <tr key={f.id}>
                          <td className="resource-name">{f.type}</td>
                          <td>
                            <select value={f.assignedResourceId} disabled={building}
                              onChange={(e) => cmd({ kind: 'reassignFacility', facilityId: f.id, resourceId: e.target.value })}>
                              {options.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                            </select>
                          </td>
                          <td>
                            {building ? (
                              <span className="muted">—</span>
                            ) : !licensed ? (
                              <span className="muted">no license</span>
                            ) : !known ? (
                              <span className="muted">undiscovered</span>
                            ) : (
                              <button
                                className={producing ? 'toggle-on' : 'toggle-off'}
                                onClick={() => cmd({ kind: 'toggleAutoProduce', resourceId: f.assignedResourceId, on: !producing })}>
                                {producing ? '● On' : 'Enable'}
                              </button>
                            )}
                          </td>
                          <td className="num">L{f.level}</td>
                          <td className="muted">
                            {building ? `building · ${f.buildTurnsLeft} turns` : leveling ? `leveling · ${f.levelUpTurnsLeft} turns` : 'operational'}
                          </td>
                          <td className="num">{Math.round(effectiveCapacity(f))}/turn</td>
                          <td>
                            {f.hiredWorkers}/{f.requiredWorkers}{' '}
                            <button onClick={() => cmd({ kind: 'hireFire', facilityId: f.id, targetWorkers: f.hiredWorkers + 1 })}>+1</button>{' '}
                            <button onClick={() => cmd({ kind: 'hireFire', facilityId: f.id, targetWorkers: Math.max(0, f.hiredWorkers - 1) })}>−1</button>
                          </td>
                          <td>
                            <button
                              disabled={building || leveling || atMax || state.player.cash < upCost}
                              onClick={() => cmd({ kind: 'levelUpFacility', facilityId: f.id })}>
                              {atMax ? 'Max level' : `Level up · ${upCost}g · ${upDuration} turns`}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <p className="hint">Level up raises capacity and slows condition decay; the facility keeps running at its current level while upgrading.</p>

                <h3 className="sub">Build new</h3>
                <div className="supply-form">
                  <div className="form-row">
                    <div className="field">
                      <label>Facility type</label>
                      <select value={buildForm.facilityType}
                        onChange={(e) => {
                          const facilityType = e.target.value;
                          const resourceId = scenario.resources.find((r) => r.facility === facilityType && isDiscovered(r.id))!.id;
                          setBuildForm({ facilityType, resourceId });
                        }}>
                        {scenario.facilityTypes
                          .filter((f) => scenario.resources.some((r) => r.facility === f.type && isDiscovered(r.id)))
                          .map((f) => <option key={f.type} value={f.type}>{f.type}</option>)}
                      </select>
                    </div>
                    <div className="field field-wide">
                      <label>Produces</label>
                      <select value={buildForm.resourceId}
                        onChange={(e) => setBuildForm((f) => ({ ...f, resourceId: e.target.value }))}>
                        {scenario.resources.filter((r) => r.facility === buildForm.facilityType && isDiscovered(r.id)).map((r) => (
                          <option key={r.id} value={r.id}>{r.name}</option>
                        ))}
                      </select>
                    </div>
                  </div>
                  {(() => {
                    const def = scenario.facilityTypes.find((f) => f.type === buildForm.facilityType)!;
                    return (
                      <button className="discover-btn propose-btn"
                        disabled={state.player.cash < def.buildCost}
                        onClick={() => cmd({ kind: 'buildFacility', facilityType: buildForm.facilityType, resourceId: buildForm.resourceId })}>
                        Build · {def.buildCost}g · {def.buildTurns} turns
                      </button>
                    );
                  })()}
                </div>
              </>
            )}

            {tab === 'contracts' && (
              <>
                <h3 className="sub">Contract board — one-off quests</h3>
                <table>
                  <thead><tr><th>Issuer</th><th>Resource</th><th className="num">Qty</th><th className="num">Deadline</th><th className="num">Payout</th><th className="num">Rep</th><th className="num">Expires</th><th></th></tr></thead>
                  <tbody>
                    {state.contractBoard.map((offer) => (
                      <tr key={offer.id}>
                        <td className="muted">{offer.issuer}</td>
                        <td className="resource-name">{resourceName(offer.resourceId)}</td>
                        <td className="num">{offer.qty}</td>
                        <td className="num">{offer.deadlineTurnsLeft} turns</td>
                        <td className="num">{offer.payout}g{offer.lawsuitOnBreach ? ' *' : ''}</td>
                        <td className="num">+{offer.reputationReward}</td>
                        <td className="num">{offer.boardTurnsLeft} turns</td>
                        <td><button onClick={() => cmd({ kind: 'acceptQuestContract', id: offer.id })}>Accept</button></td>
                      </tr>
                    ))}
                    {state.contractBoard.length === 0 && <tr><td colSpan={8} className="muted">No offers right now — check back soon.</td></tr>}
                  </tbody>
                </table>
                <p className="hint">* large contracts trigger a breach lawsuit if missed</p>

                <h3 className="sub">Long quests — deliver the same amount every turn</h3>
                <table>
                  <thead><tr><th>Issuer</th><th>Resource</th><th className="num">Qty/turn</th><th className="num">Price</th><th className="num">Duration</th><th className="num">Expires</th><th></th></tr></thead>
                  <tbody>
                    {state.standingOfferBoard.map((offer) => (
                      <tr key={offer.id}>
                        <td className="muted">{offer.issuer}</td>
                        <td className="resource-name">{resourceName(offer.resourceId)}</td>
                        <td className="num">{offer.qtyPerTurn}</td>
                        <td className="num">{offer.price}g</td>
                        <td className="num">{offer.turnsLeft} turns</td>
                        <td className="num">{offer.boardTurnsLeft} turns</td>
                        <td><button onClick={() => cmd({ kind: 'acceptStandingOffer', id: offer.id })}>Accept</button></td>
                      </tr>
                    ))}
                    {state.standingOfferBoard.length === 0 && <tr><td colSpan={7} className="muted">No standing offers right now — check back soon.</td></tr>}
                  </tbody>
                </table>
                <p className="hint">A locked price for the full duration — deliver every turn or it breaches like any standing contract.</p>

                <h3 className="sub">My quest contracts</h3>
                <table>
                  <thead><tr><th>Resource</th><th>Progress</th><th className="num">Deadline</th><th className="num">Payout</th><th></th></tr></thead>
                  <tbody>
                    {state.player.questContracts.map((c) => {
                      const have = state.player.inventory[c.resourceId]?.qty ?? 0;
                      const needed = c.qty - c.deliveredQty;
                      const canDeliver = have >= needed;
                      const cancelFee = Math.round(c.penalty * 0.5);
                      return (
                        <tr key={c.id}>
                          <td className="resource-name">{resourceName(c.resourceId)}</td>
                          <td className="muted">{have} / {needed} needed</td>
                          <td className="num">{c.deadlineTurnsLeft} turns</td>
                          <td className="num">{c.payout}g</td>
                          <td>
                            <button disabled={!canDeliver} onClick={() => cmd({ kind: 'deliverQuestContract', id: c.id })}>Deliver</button>{' '}
                            <button onClick={() => cmd({ kind: 'cancelQuestContract', id: c.id })}>Cancel · {cancelFee}g</button>
                          </td>
                        </tr>
                      );
                    })}
                    {state.player.questContracts.length === 0 && <tr><td colSpan={5} className="muted">None accepted.</td></tr>}
                  </tbody>
                </table>

                <h3 className="sub">Standing supply contracts</h3>
                <table>
                  <thead><tr><th>Side</th><th>Resource</th><th className="num">Qty/turn</th><th className="num">Price</th><th className="num">Turns</th><th className="num">Missed</th><th></th><th></th></tr></thead>
                  <tbody>
                    {state.player.supplyContracts.map((c) => {
                      const have = state.player.inventory[c.resourceId]?.qty ?? 0;
                      const canSend = c.side === 'sell' ? have >= c.qtyPerTurn : state.player.cash >= c.qtyPerTurn * c.price;
                      return (
                        <tr key={c.id}>
                          <td className="muted">{c.side}</td>
                          <td className="resource-name">{resourceName(c.resourceId)}</td>
                          <td className="num">{c.qtyPerTurn}</td>
                          <td className="num">{c.price}g</td>
                          <td className="num">{c.turnsLeft} turns</td>
                          <td className="num">{c.missedStreak}</td>
                          <td>
                            {c.settledThisTurn ? (
                              <span className="muted">Sent</span>
                            ) : (
                              <button disabled={!canSend} onClick={() => cmd({ kind: 'sendSupplyContractNow', id: c.id })}>
                                Send now
                              </button>
                            )}
                          </td>
                          <td><button onClick={() => cmd({ kind: 'cancelSupplyContract', id: c.id })}>Cancel · {c.cancelFine}g</button></td>
                        </tr>
                      );
                    })}
                    {state.player.supplyContracts.length === 0 && <tr><td colSpan={8} className="muted">None active.</td></tr>}
                  </tbody>
                </table>
                <p className="hint">
                  "Send now" settles this turn's delivery/purchase early — the automatic end-of-turn settlement is skipped once it's sent.
                </p>
                <div className="supply-form">
                  <div className="form-row">
                    <div className="field">
                      <label>Side</label>
                      <select value={supplyForm.side} onChange={(e) => setSupplyForm((f) => ({ ...f, side: e.target.value as 'sell' | 'buy' }))}>
                        <option value="sell">Sell</option>
                        <option value="buy">Buy</option>
                      </select>
                    </div>
                    <div className="field field-wide">
                      <label>Resource</label>
                      <select value={supplyForm.resourceId} onChange={(e) => setSupplyForm((f) => ({ ...f, resourceId: e.target.value }))}>
                        {scenario.resources.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="form-row">
                    <div className="field">
                      <label>Qty/turn</label>
                      <input type="number" min={1} value={supplyForm.qtyPerTurn}
                        onChange={(e) => setSupplyForm((f) => ({ ...f, qtyPerTurn: Number(e.target.value) }))} />
                    </div>
                    <div className="field">
                      <label>Price</label>
                      <input type="number" min={0} value={supplyForm.price}
                        onChange={(e) => setSupplyForm((f) => ({ ...f, price: Number(e.target.value) }))} />
                    </div>
                    <div className="field">
                      <label>Duration</label>
                      <input type="number" min={1} value={supplyForm.turnsLeft}
                        onChange={(e) => setSupplyForm((f) => ({ ...f, turnsLeft: Number(e.target.value) }))} />
                    </div>
                  </div>
                  <p className="hint" style={{ margin: '2px 2px 0' }}>
                    {supplyForm.side === 'sell' ? 'Sell' : 'Buy'} {supplyForm.qtyPerTurn} {resourceName(supplyForm.resourceId)}/turn
                    {' '}@ {supplyForm.price}g for {supplyForm.turnsLeft} turns
                    {' '}(total {supplyForm.qtyPerTurn * supplyForm.price * supplyForm.turnsLeft}g)
                  </p>
                  <button className="discover-btn propose-btn" onClick={() => cmd({ kind: 'proposeSupplyContract', ...supplyForm })}>Propose</button>
                </div>
              </>
            )}

            {tab === 'bank' && (
              <>
                <div className="bank-summary">
                  <div>
                    <span className="label">Outstanding debt</span>
                    <span className="value">{Math.round(outstandingDebt(state.player))}g</span>
                  </div>
                  <div>
                    <span className="label">Credit limit</span>
                    <span className="value">{creditLimit}g</span>
                  </div>
                </div>

                <h3 className="sub">My loans</h3>
                <table>
                  <thead><tr><th className="num">Principal</th><th className="num">Remaining</th><th className="num">Payment/turn</th><th className="num">Term left</th><th className="num">Missed</th><th></th></tr></thead>
                  <tbody>
                    {state.player.loans.map((l) => (
                      <tr key={l.id}>
                        <td className="num">{l.principal}g</td>
                        <td className="num">{Math.round(l.remaining)}g</td>
                        <td className="num">{l.paymentPerTurn}g</td>
                        <td className="num">{l.termTurnsLeft} turns</td>
                        <td className="num">{l.missedPayments}</td>
                        <td>
                          <button disabled={state.player.cash < l.remaining}
                            onClick={() => cmd({ kind: 'repayLoanEarly', loanId: l.id })}>
                            Repay now
                          </button>
                        </td>
                      </tr>
                    ))}
                    {state.player.loans.length === 0 && <tr><td colSpan={6} className="muted">No active loans.</td></tr>}
                  </tbody>
                </table>

                <h3 className="sub">Borrow</h3>
                <div className="supply-form">
                  <div className="form-row">
                    <div className="field field-wide">
                      <label>Amount</label>
                      <input type="number" min={1} max={creditLimit} value={borrowAmount}
                        onChange={(e) => setBorrowAmount(Number(e.target.value))} />
                    </div>
                  </div>
                  <p className="hint" style={{ margin: '2px 2px 0' }}>
                    Borrow {borrowAmount}g now, repay {Math.round(borrowAmount * 1.2)}g total (20% interest) over {LOAN_TERM_TURNS} turns
                    {' '}(~{Math.round((borrowAmount * 1.2) / LOAN_TERM_TURNS)}g/turn). Unsecured — missed payments cost reputation, not assets.
                  </p>
                  <button className="discover-btn propose-btn"
                    disabled={borrowAmount <= 0 || borrowAmount > creditLimit}
                    onClick={() => cmd({ kind: 'takeLoan', amount: borrowAmount })}>
                    Borrow
                  </button>
                </div>
              </>
            )}

            {tab === 'payments' && (
              <>
                <div className="bank-summary">
                  <div>
                    <span className="label">Due next turn</span>
                    <span className="value">{Math.round(bills.totalPerTurn)}g</span>
                  </div>
                </div>

                <h3 className="sub">Facility upkeep &amp; payroll</h3>
                <table>
                  <thead><tr><th>Facility</th><th className="num">Upkeep</th><th className="num">Payroll</th><th className="num">Total</th><th></th></tr></thead>
                  <tbody>
                    {bills.facilities.map((f) => (
                      <tr key={f.facilityId}>
                        <td className="resource-name">{f.type}</td>
                        <td className="num">{Math.round(f.upkeep)}g</td>
                        <td className="num">{Math.round(f.payroll)}g</td>
                        <td className="num">{Math.round(f.upkeep + f.payroll)}g</td>
                        <td>
                          {f.prepaid ? (
                            <span className="muted">Paid</span>
                          ) : (
                            <button disabled={state.player.cash < f.upkeep + f.payroll}
                              onClick={() => cmd({ kind: 'payFacilityUpkeepNow', facilityId: f.facilityId })}>
                              Pay now
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                    {bills.facilities.length === 0 && <tr><td colSpan={5} className="muted">No operational facilities.</td></tr>}
                  </tbody>
                </table>

                <h3 className="sub">Defenses</h3>
                <table>
                  <thead><tr><th>Item</th><th className="num">Per turn</th></tr></thead>
                  <tbody>
                    <tr><td className="resource-name">Insurance</td><td className="num">{bills.insurance > 0 ? `${Math.round(bills.insurance)}g` : <span className="muted">off</span>}</td></tr>
                    <tr><td className="resource-name">Legal team</td><td className="num">{bills.legalRetainer > 0 ? `${bills.legalRetainer}g` : <span className="muted">off</span>}</td></tr>
                  </tbody>
                </table>

                <h3 className="sub">Loan payments</h3>
                <table>
                  <thead><tr><th className="num">Payment</th><th className="num">Remaining</th><th></th></tr></thead>
                  <tbody>
                    {state.player.loans.map((l) => {
                      const payment = Math.min(l.paymentPerTurn, l.remaining);
                      return (
                        <tr key={l.id}>
                          <td className="num">{Math.round(payment)}g</td>
                          <td className="num">{Math.round(l.remaining)}g</td>
                          <td>
                            <button disabled={state.player.cash < payment}
                              onClick={() => cmd({ kind: 'payLoanNow', loanId: l.id })}>
                              Pay now
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {state.player.loans.length === 0 && <tr><td colSpan={3} className="muted">No active loans.</td></tr>}
                  </tbody>
                </table>

                <h3 className="sub">Buy-side supply contracts</h3>
                <table>
                  <thead><tr><th>Resource</th><th className="num">Cost/turn</th></tr></thead>
                  <tbody>
                    {bills.buyContracts.map((c) => (
                      <tr key={c.contractId}>
                        <td className="resource-name">{resourceName(c.resourceId)}</td>
                        <td className="num">{Math.round(c.cost)}g</td>
                      </tr>
                    ))}
                    {bills.buyContracts.length === 0 && <tr><td colSpan={2} className="muted">None active.</td></tr>}
                  </tbody>
                </table>

                <h3 className="sub">Upcoming license renewals</h3>
                <table>
                  <thead><tr><th>Resource</th><th className="num">Cost</th><th className="num">Due in</th><th></th></tr></thead>
                  <tbody>
                    {bills.licenseRenewals.map((l) => {
                      const atRisk = state.player.cash < l.cost;
                      return (
                        <tr key={l.resourceId}>
                          <td className="resource-name">{resourceName(l.resourceId)}</td>
                          <td className="num">{l.cost}g</td>
                          <td className="num">
                            {l.turnsUntilRenewal} turns
                            {atRisk && (
                              <span className="warn-chip" title="You can't currently afford this renewal — it will suspend the license instead of charging you">
                                ⚠ can't afford
                              </span>
                            )}
                          </td>
                          <td>
                            <button disabled={state.player.cash < l.cost}
                              onClick={() => cmd({ kind: 'renewLicenseNow', resourceId: l.resourceId })}>
                              Renew now
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {bills.licenseRenewals.length === 0 && <tr><td colSpan={4} className="muted">No licenses held.</td></tr>}
                  </tbody>
                </table>
                <p className="hint">
                  If you can't afford a renewal when it comes due, the license suspends for a few turns instead of taking your cash negative.
                </p>
                <p className="hint">
                  Renewals are periodic (not charged every turn) — renewing early just resets the countdown, it doesn't discount the fee.
                  Facility upkeep/payroll can be paid a turn ahead — it just settles this turn's charge early, so the automatic
                  deduction is skipped once. Defenses and buy contracts still don't have a "pay now" — they're recalculated fresh
                  each turn with no balance to pay ahead of.
                </p>
              </>
            )}

            {tab === 'defenses' && (
              <>
                <label className="defense-option">
                  <input type="checkbox" checked={state.player.defenses.insurance} onChange={(e) => cmd({ kind: 'toggleInsurance', on: e.target.checked })} />
                  <span>Insurance<span className="desc"> — 2% of assets per turn; disasters do half damage</span></span>
                </label>
                <label className="defense-option">
                  <input type="checkbox" checked={state.player.defenses.legalTeam} onChange={(e) => cmd({ kind: 'toggleLegalTeam', on: e.target.checked })} />
                  <span>Legal team<span className="desc"> — 25g retainer per turn; fewer suspensions, better court odds</span></span>
                </label>
                <p className="hint">Safety is a tax on greed — every defense costs real profit.</p>
              </>
            )}

            {tab === 'leaderboard' && (
              <>
                <table>
                  <thead><tr><th className="num">Rank</th><th>Company</th><th className="num">Standing</th><th className="num">Reputation</th><th className="num">Licenses</th><th>Personality</th></tr></thead>
                  <tbody>
                    {leaderboard.map((entry, i) => (
                      <tr key={entry.name} className={entry.isPlayer ? 'leaderboard-you' : undefined}>
                        <td className="num">{i + 1}</td>
                        <td className="resource-name">{entry.name}</td>
                        <td className="num">{entry.standing}g</td>
                        <td className="num">{Math.round(entry.reputation)}</td>
                        <td className="num">{entry.licenses}</td>
                        <td className="muted">{entry.personality ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="hint">
                  Rivals in this simulation only track cash — no facilities or inventory — so "Standing" is your full net worth
                  (cash + facilities + inventory − debt) versus their cash alone. Not perfectly apples-to-apples, but the best
                  available comparison.
                </p>
              </>
            )}
          </div>
        </section>
      </div>

      <footer className="actionbar">
        <div className="chips">
          {flash.length === 0
            ? <span className="placeholder">Take your actions, then end the turn.</span>
            : flash.map((s, i) => <span key={i} className="chip">{s}</span>)}
        </div>
        <button className="end-turn" onClick={endTurn}>End Turn ➤</button>
      </footer>

      {recipeTree && <RecipeTreeView tree={recipeTree} onClose={() => setTreeResource(null)} />}
      {marketIntel && <MarketIntelView intel={marketIntel} onClose={() => setIntelResource(null)} />}
    </div>
  );
}

export default App;
