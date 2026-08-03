import { useRef, useState } from "react";
import { formatMinor } from "../lib/money";

export interface NetWorthPoint {
  date: string;
  netWorthMinor: number;
}

// A compact single-series line+area chart for the Net Worth trend (3.1).
// One series (Net Worth itself) needs no legend — the widget title names
// it — so this follows the dataviz skill's single-series path: thin 2px
// line in the app's accent, low-opacity area fill, a recessive zero-line
// when the range crosses it, and a hover crosshair+tooltip rather than a
// label on every point.
export function NetWorthChart({ points, currency }: { points: NetWorthPoint[]; currency: string }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const width = 640;
  const height = 180;
  const padding = { top: 12, right: 12, bottom: 20, left: 12 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (points.length === 0) {
    return <p className="muted">Not enough history yet — a snapshot is taken daily.</p>;
  }

  const values = points.map((p) => p.netWorthMinor);
  const minV = Math.min(...values, 0);
  const maxV = Math.max(...values, 0);
  const span = maxV - minV || 1;

  function xFor(i: number): number {
    return points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth;
  }
  function yFor(v: number): number {
    return plotHeight - ((v - minV) / span) * plotHeight;
  }

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(p.netWorthMinor).toFixed(1)}`).join(" ");
  // A single point has no width to fill — the area path would degenerate
  // into a zero-width sliver that some renderers still paint as a stray
  // vertical line, so skip it entirely rather than draw a misleading mark.
  const areaPath =
    points.length > 1 ? `${linePath} L ${xFor(points.length - 1).toFixed(1)} ${plotHeight} L ${xFor(0).toFixed(1)} ${plotHeight} Z` : null;
  const zeroY = yFor(0);
  const showZeroLine = minV < 0 && maxV > 0;

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * width - padding.left;
    const t = points.length === 1 ? 0 : relX / plotWidth;
    const idx = Math.round(t * (points.length - 1));
    setHoverIndex(Math.max(0, Math.min(points.length - 1, idx)));
  }

  const hovered = hoverIndex != null ? points[hoverIndex] : null;

  return (
    <div className="net-worth-chart">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Net worth trend from ${points[0].date} to ${points[points.length - 1].date}`}
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id="nwFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.25" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform={`translate(${padding.left},${padding.top})`}>
          {showZeroLine && (
            <line x1={0} y1={zeroY} x2={plotWidth} y2={zeroY} stroke="var(--border)" strokeWidth={1} strokeDasharray="3 3" />
          )}
          {areaPath && <path d={areaPath} fill="url(#nwFill)" stroke="none" />}
          <path d={linePath} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {points.length === 1 && <circle cx={xFor(0)} cy={yFor(points[0].netWorthMinor)} r={4} fill="var(--accent)" />}
          {hovered && hoverIndex != null && (
            <>
              <line x1={xFor(hoverIndex)} y1={0} x2={xFor(hoverIndex)} y2={plotHeight} stroke="var(--text-muted)" strokeWidth={1} />
              <circle cx={xFor(hoverIndex)} cy={yFor(hovered.netWorthMinor)} r={4} fill="var(--accent)" stroke="var(--surface)" strokeWidth={2} />
            </>
          )}
        </g>
        <text x={padding.left} y={height - 4} className="chart-axis-label">
          {points[0].date}
        </text>
        <text x={width - padding.right} y={height - 4} textAnchor="end" className="chart-axis-label">
          {points[points.length - 1].date}
        </text>
      </svg>
      <div className="chart-tooltip" aria-live="polite">
        {hovered ? (
          <>
            <strong>{formatMinor(hovered.netWorthMinor, currency)}</strong> <span className="muted">on {hovered.date}</span>
          </>
        ) : (
          <>
            <strong>{formatMinor(points[points.length - 1].netWorthMinor, currency)}</strong>{" "}
            <span className="muted">as of {points[points.length - 1].date}</span>
          </>
        )}
      </div>
    </div>
  );
}
