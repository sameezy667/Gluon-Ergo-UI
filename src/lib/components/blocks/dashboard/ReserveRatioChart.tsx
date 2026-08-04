"use client";

import { useState, useMemo } from "react";
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, ReferenceLine,
  Tooltip as RechartsTooltip, ResponsiveContainer, Legend
} from "recharts";
import type { TooltipProps } from "recharts";
import { format as dateFnsFormat } from "date-fns";
import { Loader2 } from "lucide-react";
import { useGluonTransactionHistory } from "@/lib/hooks/useGluonTransactionHistory";
import { useTheme } from "next-themes";

type TimeRange = "ALL" | "90D" | "30D";
const SPARSE_THRESHOLD = 10;

interface ReserveRatioChartProps {
  /**
   * Current live gold price in nanoERG/kg from the oracle — used only as a
   * fallback for data points where the per-snapshot oracle price is unavailable
   * (i.e. when oracleHistory fetch failed). Historical calculation uses
   * s.goldPriceNanoErg from each snapshot for accuracy.
   */
  goldPriceNanoErg: number;
  totalNeutronSupply: number;
  oracleLoading?: boolean;
  oracleError?: string | null;
}

const CustomTooltip = ({ active, payload, label }: TooltipProps<number, string>) => {
  if (!active || !payload?.length) return null;
  const rr = payload.find(p => p.dataKey === "reserveRatio")?.value;
  const nrr = payload.find(p => p.dataKey === "normalizedReserveRatio")?.value;
  const dateStr = dateFnsFormat(new Date(label as number), "MMM d, yyyy HH:mm");

  return (
    <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1e1e1e] px-3 py-2 text-xs shadow-md dark:shadow-none min-w-[160px]">
      <p className="mb-1 text-gray-500 dark:text-white/40">{dateStr}</p>
      {typeof rr === "number" && (
        <p className="text-sm font-semibold text-rose-500">
          Reserve: {rr.toFixed(1)}%
        </p>
      )}
      {typeof nrr === "number" && (
        <p className="text-sm font-semibold text-violet-400">
          Normalized: {nrr.toFixed(1)}%
        </p>
      )}
    </div>
  );
};

export function ReserveRatioChart({
  goldPriceNanoErg,
  totalNeutronSupply,
  oracleLoading,
  oracleError,
}: ReserveRatioChartProps) {
  const [range, setRange] = useState<TimeRange>("ALL");
  const { snapshots, loading, error, migrationHeights } = useGluonTransactionHistory();
  const { resolvedTheme } = useTheme();

  const isDark = resolvedTheme === "dark";
  const isSparse = snapshots.length < SPARSE_THRESHOLD;

  // True when at least one snapshot has a historical oracle price (oracle fetch succeeded)
  const hasOracleData = useMemo(
    () => snapshots.some(s => s.goldPriceNanoErg > 0),
    [snapshots]
  );

  const chartData = useMemo(() => {
    if (!totalNeutronSupply) return [];

    let filtered = snapshots;
    if (!isSparse && range !== "ALL") {
      const days = range === "90D" ? 90 : 30;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      filtered = snapshots.filter(s => s.timestamp >= cutoff);
    }

    const finalData = filtered.map(s => {
      const circNeutronsRaw = totalNeutronSupply - s.neutronAmount;
      let reserveRatio = 0;
      let normalizedReserveRatio = 0;

      // Use per-snapshot historical oracle price. Fall back to live prop only
      // when the oracle history fetch failed (goldPriceNanoErg = 0 on snapshot).
      const effectiveGoldPrice = s.goldPriceNanoErg > 0 ? s.goldPriceNanoErg : goldPriceNanoErg;

      if (circNeutronsRaw > 0 && effectiveGoldPrice > 0) {
        // Use fissioned TVL (minus 1,000,000 nanoERG) as per SDK's getTVL() and getErgFissioned()
        const tvlNano = s.ergValue * 1e9;
        const tvlFissioned = Math.max(1, tvlNano - 1000000); 

        // Formula matching GluonStats.tsx line 128 exactly:
        // reserveRatioBN = BigNumber(+BigNumber(tvl) * 1e14 / (+BigNumber(circNeutrons) * goldPrice))
        // tvl is in nanoERG (tvlFissioned), goldPrice is nanoERG/Kg (effectiveGoldPrice)
        const rawRatio = (tvlFissioned * 1e14) / (circNeutronsRaw * effectiveGoldPrice);
        reserveRatio = Math.min(1000, rawRatio); // Clamp to 1000% max for visual sanity

        // Exact normalized reserve ratio logic from Gluon SDK (gluon.getReserveRatio)
        const qstar = BigInt(660000000);
        const pricePerGram = effectiveGoldPrice / 1000;
        
        const rightHandMinVal = (BigInt(Math.floor(circNeutronsRaw)) * BigInt(Math.floor(pricePerGram))) / BigInt(Math.floor(tvlFissioned));
        const fusionRatio = rightHandMinVal < qstar ? rightHandMinVal : qstar;
        if (fusionRatio > 0) {
          const rawNormalized = (100 * 1e9) / Number(fusionRatio);
          normalizedReserveRatio = Math.min(1000, rawNormalized); // Clamp to 1000% max
        }
      }

      return {
        timestamp: s.timestamp,
        reserveRatio: +reserveRatio.toFixed(1),
        normalizedReserveRatio: +normalizedReserveRatio.toFixed(1),
      };
    }).filter(d => d.reserveRatio > 0 && d.reserveRatio <= 1000);

    return finalData;
  }, [snapshots, range, isSparse, goldPriceNanoErg, totalNeutronSupply]);

  // Dynamic Y-axis max scaling. Ceiling of 1000%, floor of 400% to ensure reference lines are visible.
  const yAxisMax = useMemo(() => {
    if (chartData.length === 0) return 500;
    const maxVal = Math.max(...chartData.map(d => Math.max(d.reserveRatio, d.normalizedReserveRatio)));
    return Math.min(1000, Math.max(400, maxVal * 1.1));
  }, [chartData]);

  // Fix 1: One tick per calendar month — placed at the first data point of
  // each month. Prevents Recharts from auto-placing multiple ticks in the same
  // month that all collapse to the same "MMM" label (e.g. "Aug Aug Aug").
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

  // Find migration timestamps for a subtle vertical divider (no label, neutral color)
  const migrationTimestamps = useMemo(() => {
    if (migrationHeights.length === 0 || snapshots.length === 0) return [];
    return migrationHeights.map(mh => {
      const closest = snapshots.reduce((best, s) =>
        Math.abs(s.height - mh) < Math.abs(best.height - mh) ? s : best
      );
      return closest.timestamp;
    });
  }, [migrationHeights, snapshots]);

  return (
    <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/[0.07] bg-white dark:bg-[#141414] p-5">
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Reserve Ratio</h3>
          <span className="text-xs font-normal text-gray-400 dark:text-white/40">from on-chain box history</span>
          {!hasOracleData && !loading && snapshots.length > 0 && (
            <span className="text-xs font-medium text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">
              Oracle history unavailable — using live gold price for all points
            </span>
          )}
          {isSparse && (
            <span className="text-xs font-medium text-amber-500 bg-amber-500/10 px-2 py-0.5 rounded">
              Showing all {snapshots.length} available snapshots
            </span>
          )}
        </div>

        <div className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5">
          {(["ALL", "90D", "30D"] as TimeRange[]).map((r) => (
            <button
              key={r}
              type="button"
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

      <div className="h-56 w-full">
        {loading || (oracleLoading && !totalNeutronSupply) ? (
          <div className="flex h-full items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400 dark:text-white/40" />
            <span className="text-xs text-gray-400 dark:text-white/40">Loading on-chain history…</span>
          </div>
        ) : (error || oracleError) && chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-red-400 text-center max-w-xs">{error || oracleError}</p>
          </div>
        ) : chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-gray-400 dark:text-white/40 text-center">No reserve data available</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
              <defs>
                <linearGradient id="colorReserve" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#e11d48" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#e11d48" stopOpacity={0}/>
                </linearGradient>
                <linearGradient id="colorNormalized" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"} vertical={false} />
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
              <YAxis
                domain={[0, yAxisMax]}
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#6b7280", fontSize: 11 }}
                axisLine={false} tickLine={false}
              />
              <RechartsTooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />

              {/*
                Protocol health reference lines — these are documented Gluon Gold
                protocol parameters, NOT placeholders or mock data:
                  350% → Healthy reserve (above target backing threshold)
                  180% → Caution zone (depeg risk increases)
                   90% → Risk zone (GAU backing compromised)
              */}
              <ReferenceLine y={350} stroke="#10b981" strokeDasharray="4 4" label={{ value: "Healthy", fill: "#10b981", fontSize: 10, position: "insideTopRight" }} />
              <ReferenceLine y={180} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: "Caution", fill: "#f59e0b", fontSize: 10, position: "insideTopRight" }} />
              <ReferenceLine y={90} stroke="#ef4444" strokeDasharray="4 4" label={{ value: "Risk", fill: "#ef4444", fontSize: 10, position: "insideTopRight" }} />

              {/* Subtle vertical divider at contract address change — no label, no color */}
              {migrationTimestamps.map((ts, idx) => (
                <ReferenceLine
                  key={`migration-${idx}`}
                  x={ts}
                  stroke={isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)"}
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              ))}

              <Area type="monotone" dataKey="normalizedReserveRatio" name="Normalized Reserve Ratio" stroke="#8b5cf6" fillOpacity={1} fill="url(#colorNormalized)" strokeWidth={2} isAnimationActive={true} />
              <Area type="monotone" dataKey="reserveRatio" name="Reserve Ratio" stroke="#e11d48" fillOpacity={1} fill="url(#colorReserve)" strokeWidth={2} isAnimationActive={true} />
            </AreaChart>
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
