import { useId, useMemo, useState } from 'react';

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 46;
const PAD_RIGHT = 10;
const PAD_TOP = 10;
const PAD_BOTTOM = 22;
const INNER_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const INNER_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

// A TradingView-style price line: gridlines with axis labels, a gradient
// area fill under the line (green if the visible window is up, red if
// down), and a hover crosshair + tooltip showing turn/price at the nearest
// point. history is oldest-first; currentTurn lets us label the x-axis
// since the history array itself only stores prices, not turn numbers.
// Used for both the universal Gold price and any scenario resource's
// per-turn market price — both are plain number[] histories.
export function PriceChart({ history, currentTurn }: { history: number[]; currentTurn: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const gradientId = useId();

  const { points, min, max, linePath, areaPath, up } = useMemo(() => {
    const min = Math.min(...history);
    const max = Math.max(...history);
    const range = max - min || 1;
    const points = history.map((p, i): [number, number] => {
      const x = PAD_LEFT + (history.length === 1 ? INNER_W : (i / (history.length - 1)) * INNER_W);
      const y = PAD_TOP + INNER_H - ((p - min) / range) * INNER_H;
      return [x, y];
    });
    const linePath = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    const floorY = PAD_TOP + INNER_H;
    const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${floorY} L${points[0][0].toFixed(1)},${floorY} Z`;
    const up = history[history.length - 1] >= history[0];
    return { points, min, max, linePath, areaPath, up };
  }, [history]);

  const turnForIndex = (i: number) => currentTurn - (history.length - 1 - i);
  const color = up ? 'var(--green)' : 'var(--red)';
  const hover = hoverIdx !== null ? points[hoverIdx] : null;
  const shownIdx = hoverIdx ?? history.length - 1;

  return (
    <div className="price-chart">
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} onMouseLeave={() => setHoverIdx(null)}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0, 0.5, 1].map((f) => {
          const y = PAD_TOP + f * INNER_H;
          const val = max - f * (max - min);
          return (
            <g key={f}>
              <line x1={PAD_LEFT} y1={y} x2={WIDTH - PAD_RIGHT} y2={y} className="price-chart-grid" />
              <text x={PAD_LEFT - 6} y={y + 3} className="price-chart-axis" textAnchor="end">{val.toFixed(1)}</text>
            </g>
          );
        })}
        <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
        <path d={linePath} fill="none" stroke={color} strokeWidth={1.6} />
        {hover && (
          <>
            <line x1={hover[0]} y1={PAD_TOP} x2={hover[0]} y2={PAD_TOP + INNER_H} className="price-chart-crosshair" />
            <circle cx={hover[0]} cy={hover[1]} r={3.2} fill={color} stroke="var(--bg)" strokeWidth={1} />
          </>
        )}
        <rect
          x={PAD_LEFT}
          y={PAD_TOP}
          width={INNER_W}
          height={INNER_H}
          fill="transparent"
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            const frac = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
            setHoverIdx(Math.round(frac * (history.length - 1)));
          }}
        />
      </svg>
      <div className="price-chart-tooltip">
        <span>Turn {turnForIndex(shownIdx)}</span>
        <span>{history[shownIdx].toFixed(2)}g</span>
      </div>
    </div>
  );
}
