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
  goldPriceNanoErg: number;
  totalNeutronSupply: number;
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
        <p className="text-sm font-semibold text-amber-500">
          Normalized: {nrr.toFixed(1)}%
        </p>
      )}
    </div>
  );
};

export function ReserveRatioChart({ goldPriceNanoErg, totalNeutronSupply }: ReserveRatioChartProps) {
  const [range, setRange] = useState<TimeRange>("ALL");
  const { snapshots, loading, error, migrationHeights } = useGluonTransactionHistory();
  const { resolvedTheme } = useTheme();

  const isDark = resolvedTheme === "dark";
  const isSparse = snapshots.length < SPARSE_THRESHOLD;

  const chartData = useMemo(() => {
    if (!goldPriceNanoErg || !totalNeutronSupply) return [];

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

      if (circNeutronsRaw > 0 && goldPriceNanoErg > 0) {
        // Formula matching GluonStats.tsx line 128:
        // reserveRatioBN = BigNumber(+BigNumber(tvl) * 1e14 / (+BigNumber(circNeutrons) * goldPrice))
        // tvl here is in nanoERG, goldPrice is in nanoERG/unit, circNeutrons is raw token units
        const tvlNano = s.ergValue * 1e9;
        const tvlErg = s.ergValue;
        reserveRatio = (tvlNano * 1e14) / (circNeutronsRaw * goldPriceNanoErg);
        
        // Exact normalized reserve ratio logic from Gluon SDK (gluon.getReserveRatio)
        const qstar = BigInt(660000000);
        const rightHandMinVal = (BigInt(Math.floor(circNeutronsRaw)) * BigInt(goldPriceNanoErg)) / BigInt(Math.floor(tvlErg));
        const fusionRatio = rightHandMinVal < qstar ? rightHandMinVal : qstar;
        normalizedReserveRatio = (100 * 1e9) / Number(fusionRatio);
      }

      return {
        timestamp: s.timestamp,
        reserveRatio: +reserveRatio.toFixed(1),
        normalizedReserveRatio: +normalizedReserveRatio.toFixed(1),
      };
    }).filter(d => d.reserveRatio > 0 && d.reserveRatio < 100000);
    
    return finalData;
  }, [snapshots, range, isSparse, goldPriceNanoErg, totalNeutronSupply]);

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
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Reserve Ratio</h3>
          <span className="text-xs font-normal text-gray-400 dark:text-white/40">from on-chain box history</span>
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
        {loading || !goldPriceNanoErg || !totalNeutronSupply ? (
          <div className="flex h-full items-center justify-center gap-2">
            <Loader2 className="h-5 w-5 animate-spin text-gray-400 dark:text-white/40" />
            <span className="text-xs text-gray-400 dark:text-white/40">Loading on-chain history…</span>
          </div>
        ) : error && chartData.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-red-400 text-center max-w-xs">{error}</p>
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
                  <stop offset="5%" stopColor="#d97706" stopOpacity={0.3}/>
                  <stop offset="95%" stopColor="#d97706" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"} vertical={false} />
              <XAxis
                dataKey="timestamp"
                tickFormatter={(v: number) => dateFnsFormat(new Date(v), "MMM d")}
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#6b7280", fontSize: 11 }}
                axisLine={false} tickLine={false} minTickGap={30}
              />
              <YAxis
                tickFormatter={(v) => `${v}%`}
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#6b7280", fontSize: 11 }}
                axisLine={false} tickLine={false}
              />
              <RechartsTooltip content={<CustomTooltip />} />
              <Legend wrapperStyle={{ fontSize: 11 }} />

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

              <Area type="monotone" dataKey="normalizedReserveRatio" name="Normalized Reserve Ratio" stroke="#d97706" fillOpacity={1} fill="url(#colorNormalized)" strokeWidth={2} isAnimationActive={true} />
              <Area type="monotone" dataKey="reserveRatio" name="Reserve Ratio" stroke="#e11d48" fillOpacity={1} fill="url(#colorReserve)" strokeWidth={2} isAnimationActive={true} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
