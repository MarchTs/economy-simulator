import type {
  QuestContract,
  ResourceId,
  RivalCompany,
  StandingOfferContract,
  SupplyContract,
} from '../engine/types';
import { PriceChart } from './PriceChart';

export interface MarketIntel {
  resourceId: ResourceId;
  resourceName: string;
  priceHistory: number[];
  currentTurn: number;
  boardQuests: QuestContract[];
  boardStanding: StandingOfferContract[];
  myQuests: QuestContract[];
  mySupply: SupplyContract[];
  rivals: { rival: RivalCompany; postedPrice?: number; licensed: boolean }[];
}

export function MarketIntelView({ intel, onClose }: { intel: MarketIntel; onClose: () => void }) {
  const { resourceName, priceHistory, currentTurn, boardQuests, boardStanding, myQuests, mySupply, rivals } = intel;
  const nothingAtAll =
    boardQuests.length === 0 &&
    boardStanding.length === 0 &&
    myQuests.length === 0 &&
    mySupply.length === 0 &&
    rivals.length === 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal intel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tree-head">
          <h3>📋 {resourceName} — contracts &amp; competitors</h3>
          <button className="tree-close" onClick={onClose}>✕</button>
        </div>

        <h3 className="sub">Price history</h3>
        <PriceChart history={priceHistory} currentTurn={currentTurn} />

        {nothingAtAll && (
          <p className="muted" style={{ padding: '12px 4px' }}>
            No board offers, active contracts, or known competitor activity for {resourceName} right now.
          </p>
        )}

        {(boardQuests.length > 0 || boardStanding.length > 0) && (
          <>
            <h3 className="sub">Companies wanting to buy this from you</h3>
            <table>
              <thead><tr><th>Issuer</th><th>Type</th><th className="num">Qty</th><th className="num">Price/Payout</th><th className="num">Expires</th></tr></thead>
              <tbody>
                {boardQuests.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{o.issuer}</td>
                    <td className="muted">one-off</td>
                    <td className="num">{o.qty}</td>
                    <td className="num">{o.payout}g total</td>
                    <td className="num">{o.boardTurnsLeft} turns</td>
                  </tr>
                ))}
                {boardStanding.map((o) => (
                  <tr key={o.id}>
                    <td className="muted">{o.issuer}</td>
                    <td className="muted">long quest</td>
                    <td className="num">{o.qtyPerTurn}/turn</td>
                    <td className="num">{o.price}g/unit</td>
                    <td className="num">{o.boardTurnsLeft} turns</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {(myQuests.length > 0 || mySupply.length > 0) && (
          <>
            <h3 className="sub">Your active contracts</h3>
            <table>
              <thead><tr><th>Kind</th><th className="num">Qty</th><th className="num">Price/Payout</th><th className="num">Time left</th></tr></thead>
              <tbody>
                {myQuests.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">quest delivery</td>
                    <td className="num">{c.qty - c.deliveredQty} needed</td>
                    <td className="num">{c.payout}g total</td>
                    <td className="num">{c.deadlineTurnsLeft} turns</td>
                  </tr>
                ))}
                {mySupply.map((c) => (
                  <tr key={c.id}>
                    <td className="muted">standing · {c.side}</td>
                    <td className="num">{c.qtyPerTurn}/turn</td>
                    <td className="num">{c.price}g/unit</td>
                    <td className="num">{c.turnsLeft} turns</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}

        {rivals.length > 0 && (
          <>
            <h3 className="sub">Competitor activity</h3>
            <table>
              <thead><tr><th>Company</th><th>Personality</th><th>Licensed</th><th className="num">Posted price</th></tr></thead>
              <tbody>
                {rivals.map(({ rival, postedPrice, licensed }) => (
                  <tr key={rival.id}>
                    <td className="resource-name">{rival.name}</td>
                    <td className="muted">{rival.personality}</td>
                    <td>{licensed ? <span className="lic-yes">✓</span> : <span className="muted">–</span>}</td>
                    <td className="num">{postedPrice !== undefined ? `${postedPrice.toFixed(1)}g` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">Competitor intel is partial — most companies don't yet trade every good.</p>
          </>
        )}
      </div>
    </div>
  );
}
