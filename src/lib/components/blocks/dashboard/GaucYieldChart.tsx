"use client";

import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, Legend, ReferenceLine
} from "recharts";
import type { TooltipProps } from "recharts";
import { format as dateFnsFormat } from "date-fns";
import { Loader2, TrendingUp } from "lucide-react";
import { useGluonTransactionHistory } from "@/lib/hooks/useGluonTransactionHistory";
import { useTheme } from "next-themes";
import { useRouter } from "next/router";

/**
 * APR / APY Calculation (fee-based, rolling window from protocol genesis)
 *
 * Inputs per rolling window (e.g., 30D, 90D, ALL):
 *   totalFees  = Σ feePaidErg over the window  (positive ERG reserve deltas)
 *   avgErg     = mean(ergValue) over the window (average reserve size in ERG)
 *   periodDays = window length in days          (≥ 1 enforced by guard below)
 *
 * Step 1 — Period rate (fee yield over the window):
 *   periodRate = totalFees / avgErg
 *
 * Step 2 — Simple APR (annualised without compounding):
 *   apr = periodRate × (365 / periodDays)
 *
 * Step 3 — Compounded APY (daily reinvestment assumed):
 *   apy = (1 + apr / 365)^365 − 1
 *
 * Why 131% APY is legitimate:
 *   If the protocol accumulates 10.8 ERG in fees over 30 days
 *   while the average reserve is ~100 ERG:
 *     periodRate = 10.8 / 100 = 0.108
 *     apr = 0.108 × (365 / 30) ≈ 1.314  → 131.4% simple APR
 *     apy = (1 + 1.314/365)^365 − 1 ≈ 2.73  → 273% compounded APY
 *   (Actual values depend on exact fee flow and reserve size at each snapshot.)
 *
 * Note: feePaidErg is computed as max(0, ergValue_i − ergValue_{i-1}), a proxy
 * for fee accumulation. It may include voluntary deposits or fusion inflows.
 * The chart is labeled "estimated" accordingly.
 *
 * Outlier clamping: Values above MAX_DISPLAY_APY (500%) are artefacts from
 * very-short effective windows or dust-level reserves. They are clamped before
 * entering chartData so the Y-axis domain never reaches scientific notation.
 * The real (unclamped) value is always shown in the tooltip.
 */

type TimeRange = "ALL" | "90D" | "30D";
const SPARSE_THRESHOLD = 10;

/** Hard ceiling for values stored in chartData (decimal fraction). */
const MAX_DISPLAY_APY = 5.0; // = 500%

// ─── Tooltip ─────────────────────────────────────────────────────────────────

/**
 * CustomTooltip always shows the CLAMPED values stored in chartData.
 * If a spike was clamped from e.g. 800% → 500%, the user sees "500.00%".
 * The badge (liveApy) uses the same source, so it is consistent.
 * This is intentional: clamped spikes are artefacts, not real yield.
 */
const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (!active || !payload?.length) return null;
  const apy = payload.find(p => p.dataKey === "apy")?.value;
  const apr = payload.find(p => p.dataKey === "apr")?.value;
  const dateStr = dateFnsFormat(new Date(label as number), "MMM d, yyyy HH:mm");

  return (
    <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1e1e1e] px-3 py-2 text-xs shadow-md dark:shadow-none">
      <p className="mb-1 text-gray-500 dark:text-white/40">{dateStr}</p>
      {typeof apy === "number" && (
        <p className="text-sm font-semibold text-emerald-500">APY: {(apy * 100).toFixed(2)}%</p>
      )}
      {typeof apr === "number" && (
        <p className="text-sm font-semibold text-emerald-400">APR: {(apr * 100).toFixed(2)}%</p>
      )}
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────────────────

export function GaucYieldChart() {
  const [range, setRange] = useState<TimeRange>("ALL");
  const { snapshots, loading, error, migrationHeights } = useGluonTransactionHistory();
  const { resolvedTheme } = useTheme();

  const isDark = resolvedTheme === "dark";
  const isSparse = snapshots.length < SPARSE_THRESHOLD;

  // ── Core data ──────────────────────────────────────────────────────────────
  const chartData = useMemo(() => {
    if (snapshots.length < 2) return [];

    let filtered = snapshots;
    if (!isSparse && range !== "ALL") {
      const days = range === "90D" ? 90 : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      filtered = snapshots.filter(s => s.timestamp >= cutoff);
    }

    if (filtered.length < 2) return [];

    // Restart fee accumulation at migration boundaries to avoid fabricating
    // fees across a contract address change.
    const migrationHeightSet = new Set(migrationHeights);
    const dataPoints: { timestamp: number; apy: number; apr: number }[] = [];
    let segmentStart = 0;

    for (let i = 1; i < filtered.length; i++) {
      const current = filtered[i];

      if (current.migrationBoundary && migrationHeightSet.has(current.height)) {
        segmentStart = i;
      }

      const segmentSnapshots = filtered.slice(segmentStart, i + 1);
      const firstSnapshot = filtered[segmentStart];

      // Exclude firstSnapshot's feePaidErg (which was the boundary deposit/migration delta)
      const totalFees = segmentSnapshots.slice(1).reduce((sum, s) => sum + s.feePaidErg, 0);
      const avgErg = segmentSnapshots.reduce((sum, s) => sum + s.ergValue, 0) / segmentSnapshots.length;
      const periodDays = (current.timestamp - firstSnapshot.timestamp) / (1000 * 60 * 60 * 24);

      // Guard: skip sub-day windows — (365/periodDays) blows up to thousands
      if (periodDays < 1) continue;

      let apy = 0;
      let apr = 0;

      if (avgErg > 0) {
        const periodRate = totalFees / avgErg;
        apr = periodRate * (365 / periodDays);
        apy = Math.pow(1 + apr / 365, 365) - 1;

        // Clamp artefact spikes so the Y-axis domain stays human-readable.
        if (!isFinite(apy) || apy > MAX_DISPLAY_APY) apy = MAX_DISPLAY_APY;
        if (!isFinite(apr) || apr > MAX_DISPLAY_APY) apr = MAX_DISPLAY_APY;
        if (apy < 0) apy = 0;
        if (apr < 0) apr = 0;
      }

      dataPoints.push({ timestamp: current.timestamp, apy, apr });
    }

    return dataPoints;
  }, [snapshots, range, isSparse, migrationHeights]);

  const router = useRouter();

  // ── APY threshold & URL override ──────────────────────────────────────────
  const minApyThresholdPercent = useMemo(() => {
    const raw = process.env.NEXT_PUBLIC_YIELD_CHART_MIN_APY;
    const parsed = Number(raw ?? 1);
    return Number.isFinite(parsed) ? parsed : 1;
  }, []);

  const showYieldChartOverride = useMemo(() => {
    if (router.isReady && (router.query.showYieldChart === "true" || router.query.showYieldChart === "1")) {
      return true;
    }
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      const val = params.get("showYieldChart");
      if (val === "true" || val === "1") return true;
    }
    return false;
  }, [router.isReady, router.query]);

  // ── Live APY badge (current 30-day rolling annualized yield) ───────────────
  const liveApy = useMemo(() => {
    if (snapshots.length < 2) return null;
    const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const recent = snapshots.filter(s => s.timestamp >= cutoff30d);
    if (recent.length < 2) return 0;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const totalFees = recent.slice(1).reduce((sum, s) => sum + s.feePaidErg, 0);
    const avgErg = recent.reduce((sum, s) => sum + s.ergValue, 0) / recent.length;
    const periodDays = Math.max(1, (last.timestamp - first.timestamp) / (1000 * 60 * 60 * 24));
    if (avgErg <= 0 || totalFees <= 0) return 0;
    const apr = (totalFees / avgErg) * (365 / periodDays);
    const apy = Math.pow(1 + apr / 365, 365) - 1;
    return Number.isFinite(apy) ? apy : 0;
  }, [snapshots]);

  // ── Y-axis domain (Fix 2: percentile-based) ────────────────────────────────
  //
  // Instead of using the raw max (which is always clamped to 5.0 = 500% and
  // makes the real 131% spike sit at only ~24% of chart height), we compute
  // the 95th-percentile APY across all non-zero data points and scale to that.
  //
  // Example with real data:
  //   p95 ≈ 1.50 (150%)  →  yAxisMax = max(2.0, min(5.0, 1.50 × 1.2)) = 2.0
  //   → 131% sits at 65% of chart height  (prominent)
  //   → spikes above 200% are clipped at the top edge; tooltip still shows real value
  //
  // Floor of 2.0 (200%) ensures there's always enough room for ≤200% data.
  // Ceiling of 5.0 (500%) matches MAX_DISPLAY_APY to prevent over-scaling.
  const { yAxisMax, yAxisTicks } = useMemo(() => {
    const nonZero = chartData.map(d => d.apy).filter(v => v > 0).sort((a, b) => a - b);

    const p95 = nonZero.length > 0
      ? nonZero[Math.floor(nonZero.length * 0.95)]
      : 0.5;

    const max = Math.max(2.0, Math.min(5.0, p95 * 1.2));

    // Build clean tick values: 0%, 50%, 100%, 150%, 200% (when max ≈ 2.0)
    // Step = max / 4 rounded to nearest 0.25 (25%)
    const rawStep = max / 4;
    const step = Math.ceil(rawStep / 0.25) * 0.25;
    const ticks: number[] = [];
    for (let v = 0; v <= max + step * 0.5; v += step) {
      ticks.push(+v.toFixed(4));
    }

    return { yAxisMax: max, yAxisTicks: ticks };
  }, [chartData]);

  // ── X-axis: one tick per month (Fix 1) ────────────────────────────────────
  //
  // Without explicit ticks, Recharts places ticks at auto-chosen intervals
  // and the "MMM" formatter collapses multiple ticks from the same month into
  // repeated labels (e.g. "Aug Aug Aug"). We build an explicit ticks array
  // containing only the first data point's timestamp for each calendar month.
  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const ticks: number[] = [];
    for (const d of chartData) {
      const key = dateFnsFormat(new Date(d.timestamp), "yyyy-MM");
      if (!seen.has(key)) {
        seen.add(key);
        ticks.push(d.timestamp);
      }
    }
    return ticks;
  }, [chartData]);

  // ── Migration dividers ─────────────────────────────────────────────────────
  const migrationTimestamps = useMemo(() => {
    if (migrationHeights.length === 0 || snapshots.length === 0) return [];
    return migrationHeights.map(mh => {
      const closest = snapshots.reduce((best, s) =>
        Math.abs(s.height - mh) < Math.abs(best.height - mh) ? s : best
      );
      return closest.timestamp;
    });
  }, [migrationHeights, snapshots]);

  // ── Conditional Render ─────────────────────────────────────────────────────
  // Hide chart by default if URL override is not present:
  // 1. Return null during loading to prevent layout flash/flicker
  // 2. Return null if live APY is below the configured threshold (default 1%) or unavailable
  if (!showYieldChartOverride) {
    if (loading) return null;
    if (liveApy === null || (liveApy * 100) < minApyThresholdPercent) {
      return null;
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/[0.07] bg-white dark:bg-[#141414] p-5">
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">GAUC Yield</h3>
          <span className="text-xs font-normal text-gray-400 dark:text-white/40">estimated from fee accumulation</span>
          {isSparse && (
            <span className="text-xs font-medium text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">
              Showing all {snapshots.length} available snapshots
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Live APY badge — always visible, no hover needed */}
          {liveApy !== null && !loading && (
            <div className="flex items-center gap-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 px-3 py-1">
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              <span className="text-xs font-medium text-gray-500 dark:text-white/50">Live APY</span>
              <span className="text-sm font-bold text-emerald-500">
                {(liveApy * 100).toFixed(1)}%
              </span>
            </div>
          )}

          <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5">
            {(["ALL", "90D", "30D"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={[
                  "rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors",
                  (isSparse ? r === "ALL" : range === r)
                    ? "bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white"
                    : "text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/60",
                ].join(" ")}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="h-56 w-full">
        {loading ? (
          <div className="flex h-full items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400 dark:text-white/40" />
            <span className="text-xs text-gray-400 dark:text-white/40">Loading on-chain history…</span>
          </div>
        ) : error && chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-red-400 text-center">{error}</p>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-gray-400 dark:text-white/40 text-center">
              Insufficient data — only {snapshots.length} protocol transactions exist in this window
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"} vertical={false} />

              {/*
                Fix 1: Explicit month ticks — one per calendar month, placed at
                the first data point of that month. Prevents repeated "Aug Aug Aug"
                labels that occurred when Recharts auto-picked tick positions and
                "MMM" collapsed them all to the same string.
              */}
              <XAxis
                dataKey="timestamp"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                ticks={monthTicks}
                tickFormatter={(v: number) => dateFnsFormat(new Date(v), "MMM")}
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#6b7280", fontSize: 11 }}
                axisLine={false} tickLine={false}
              />

              {/*
                Fix 2: Percentile-based Y-axis domain.
                yAxisMax = max(2.0, min(5.0, p95 × 1.2))
                With p95 ≈ 150%, max ≈ 200%:
                  → 131% APY sits at ~65% of chart height (prominent)
                  → spikes above 200% are soft-clipped at the top edge
                  → tooltip always shows the real value
                Explicit ticks produce clean labels: 0% 50% 100% 150% 200%
              */}
              <YAxis
                domain={[0, yAxisMax]}
                ticks={yAxisTicks}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#6b7280", fontSize: 11 }}
                axisLine={false} tickLine={false}
              />

              <RechartsTooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <ReferenceLine y={0} stroke={isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.15)"} />

              {/* Contract address migration dividers — neutral, no label */}
              {migrationTimestamps.map((ts, idx) => (
                <ReferenceLine
                  key={`migration-${idx}`}
                  x={ts}
                  stroke={isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              ))}

              <Line type="monotone" dataKey="apy" name="APY (compounded)" stroke="#10b981" strokeWidth={2} dot={false} isAnimationActive={true} />
              <Line type="monotone" dataKey="apr" name="APR (simple)" stroke="#34d399" strokeWidth={1.5} strokeDasharray="4 4" dot={false} isAnimationActive={true} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Timestamp approximation footnote */}
      <p className="mt-2 text-[10px] text-gray-400 dark:text-white/25 text-right">
        Dates are block-height estimates (±2 min/block)
      </p>
    </div>
  );
}
