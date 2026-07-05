import type { RecipeTreeNode, RecipeTreeResult } from '../engine/recipeTree';

function TreeNode({ node, isRoot }: { node: RecipeTreeNode; isRoot?: boolean }) {
  const isLeaf = node.children.length === 0;
  const lineCost = (node.marketPrice * node.qty).toFixed(0);
  // Hide the recipe internals of an undiscovered intermediate — you know it
  // exists and its market price, but not how it's made. The root is always
  // expanded (you clicked it to inspect); its own recipe secrecy is shown via tag.
  const revealChildren = !isLeaf && (node.known || isRoot);
  return (
    <li className="tree-node">
      <div className="tree-row">
        <span className="tree-qty">{isRoot ? '' : `${node.qty}×`}</span>
        <span className="tree-name">{node.name}</span>
        <span className="tier-chip">T{node.tier}</span>
        {isLeaf ? (
          <span className="tree-tag raw">raw · buy</span>
        ) : node.known ? (
          <span className="tree-tag known">recipe known</span>
        ) : (
          <span className="tree-tag unknown">🔒 undiscovered</span>
        )}
        {node.cyclic && <span className="tree-tag unknown">cycle</span>}
        <span className="tree-cost">{node.marketPrice.toFixed(1)}g ea · {lineCost}g</span>
      </div>
      {revealChildren && (
        <ul className="tree-children">
          {node.children.map((c, i) => (
            <TreeNode key={`${c.resourceId}_${i}`} node={c} />
          ))}
        </ul>
      )}
      {!isLeaf && !revealChildren && (
        <ul className="tree-children">
          <li className="tree-node">
            <div className="tree-row locked">
              <span className="tree-locked">🔒 Recipe undiscovered — research to reveal its ingredients</span>
            </div>
          </li>
        </ul>
      )}
    </li>
  );
}

export function RecipeTreeView({ tree, onClose }: { tree: RecipeTreeResult; onClose: () => void }) {
  const { root, rawMaterialCost, buyDirectPrice } = tree;
  const margin = buyDirectPrice - rawMaterialCost;
  const marginPct = rawMaterialCost > 0 ? (margin / rawMaterialCost) * 100 : 0;
  const canMake = root.children.length > 0;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal tree-modal" onClick={(e) => e.stopPropagation()}>
        <div className="tree-head">
          <h3>🍺 {root.name} — recipe tree</h3>
          <button className="tree-close" onClick={onClose}>✕</button>
        </div>

        {canMake ? (
          <>
            <ul className="tree-root">
              <TreeNode node={root} isRoot />
            </ul>
            <div className="tree-summary">
              <div>
                <span className="label">Raw material cost</span>
                <span className="value">{rawMaterialCost.toFixed(0)}g</span>
              </div>
              <div>
                <span className="label">Sell at market</span>
                <span className="value">{buyDirectPrice.toFixed(0)}g</span>
              </div>
              <div>
                <span className="label">Margin</span>
                <span className={`value ${margin >= 0 ? 'pos' : 'neg'}`}>
                  {margin >= 0 ? '+' : ''}{margin.toFixed(0)}g ({marginPct >= 0 ? '+' : ''}{marginPct.toFixed(0)}%)
                </span>
              </div>
            </div>
            <p className="hint">
              Margin ignores license fees, wages, and facility upkeep — it's the raw ingredient spread only.
              {tree.hasUndiscovered
                ? ' Undiscovered intermediates are costed at their market buy price — discover their recipes to make them cheaper.'
                : ' Intermediate goods you can’t produce must be bought at their own market price.'}
            </p>
          </>
        ) : (
          <p className="muted" style={{ padding: '12px 4px' }}>
            {root.name} is a raw material (tier {root.tier}) — extract it directly with a license and facility, no recipe needed.
          </p>
        )}
      </div>
    </div>
  );
}
