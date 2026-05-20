"use client";

import React, { useState, useEffect, useMemo } from "react";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip as RechartsTooltip, ReferenceLine, Legend } from "recharts";
import { format as dateFnsFormat } from "date-fns";

type TimeRange = "7D" | "30D";

interface RatioEntry {
  timestamp: number;
  ratio: number;
}

interface YieldPoint {
  timestamp: number;
  apy: number;
  apr: number;
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    const apy = payload.find((p: any) => p.dataKey === "apy");
    const apr = payload.find((p: any) => p.dataKey === "apr");
    const dateStr = dateFnsFormat(new Date(label), 'MMM d, yyyy HH:mm');
    return (
      <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1e1e1e] px-3 py-2 text-xs shadow-none">
        <p className="mb-1 text-gray-400 dark:text-white/40">{dateStr}</p>
        {apy && (
          <p className="text-sm font-semibold text-emerald-500">
            APY: {apy.value.toFixed(2)}%
          </p>
        )}
        {apr && (
          <p className="text-sm font-semibold text-emerald-400">
            APR: {apr.value.toFixed(2)}%
          </p>
        )}
      </div>
    );
  }
  return null;
};

const CustomLegend = ({ payload }: any) => {
  return (
    <div className="flex justify-center gap-4 pt-2">
      {payload.map((entry: any, index: number) => (
        <div key={`item-${index}`} className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-xs font-medium text-gray-500 dark:text-white/50">
            {entry.value === "apy" ? "APY (compounded)" : "APR (simple)"}
          </span>
        </div>
      ))}
    </div>
  );
};

export function GaucYieldChart() {
  const [range, setRange] = useState<TimeRange>("30D");
  const [chartData, setChartData] = useState<YieldPoint[]>([]);
  const [history, setHistory] = useState<RatioEntry[]>([]);

  const isDark = typeof window !== "undefined" && document.documentElement.classList.contains("dark");

  useEffect(() => {
    const refresh = () => {
      const raw = localStorage.getItem('gluon_reserve_history');
      if (raw) {
        try {
          setHistory(JSON.parse(raw));
        } catch {}
      }
    };
    refresh();
    const interval = setInterval(refresh, 65000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (history.length < 2) return;

    const windowDays = range === '7D' ? 7 : 30;
    const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
    const validHistory = history.filter(e => e.timestamp >= cutoff && e.timestamp >= Date.now() - 3 * 24 * 60 * 60 * 1000);

    const points: YieldPoint[] = [];
    for (const point of validHistory) {
      const windowEntries = history.filter(e => e.timestamp >= point.timestamp - 30 * 24 * 3600 * 1000 && e.timestamp <= point.timestamp);
      if (windowEntries.length < 2) continue;
      const oldest = windowEntries[0];
      const newest = windowEntries[windowEntries.length - 1];
      const days = (newest.timestamp - oldest.timestamp) / 86400000;
      if (days < 0.021) continue;
      
      const apy = newest.ratio > oldest.ratio
        ? (Math.pow(newest.ratio / oldest.ratio, 365 / days) - 1) * 100
        : 0;
      const apr = newest.ratio > oldest.ratio
        ? ((newest.ratio / oldest.ratio) - 1) * (365 / days) * 100
        : 0;
      
      if (!isNaN(apy) && !isNaN(apr) && isFinite(apy) && isFinite(apr) && !(Math.abs(apy) > 200 || Math.abs(apr) > 1000)) {
        points.push({ timestamp: point.timestamp, apy, apr });
      }
    }
    setChartData(points);
  }, [history, range]);

  const filteredData = chartData;

  return (
    <div className="mt-6">
      <div className="rounded-xl border border-gray-200 dark:border-white/[0.07] bg-white dark:bg-[#141414] p-5">
        <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">GAUC Yield Estimate</h3>
            <span className="text-xs font-normal text-gray-400 dark:text-white/40">rolling 30-day APY & APR from fee accumulation</span>
          </div>

          <div
            className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5"
            role="group"
            aria-label="Chart time range"
          >
            {(["7D", "30D"] as TimeRange[]).map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                aria-pressed={range === r}
                className={[
                  "rounded-md px-2.5 py-0.5 text-xs font-medium transition-colors duration-150",
                  range === r ? "bg-gray-200 dark:bg-white/10 text-gray-900 dark:text-white" : "text-gray-400 dark:text-white/40 hover:text-gray-600 dark:hover:text-white/60",
                ].join(" ")}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        <div className="h-56 w-full">
          {filteredData.length === 0 ? (
            <p className="text-xs text-gray-400 dark:text-white/40 text-center py-12">
              Collecting yield history — requires reserve ratio data over time
            </p>
          ) : (
            <>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={filteredData} margin={{ top: 5, right: 0, left: -20, bottom: 0 }}>
                  <CartesianGrid
                    strokeDasharray="0"
                    stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="timestamp"
                    tickFormatter={(v: number) => dateFnsFormat(new Date(v), 'MMM d')}
                    tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#9ca3af", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={48}
                    type="number"
                    domain={['dataMin', 'dataMax']}
                  />
                  <YAxis
                    tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#9ca3af", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                    domain={[
                      (dataMin: number) => Math.min(dataMin - 5, -10),
                      (dataMax: number) => Math.max(dataMax + 5, 10)
                    ]}
                  />
                  <RechartsTooltip content={<CustomTooltip />} />
                  <ReferenceLine y={0} stroke={isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.15)"} />
                  <Legend content={<CustomLegend />} />
                  <Line
                    type="monotone"
                    dataKey="apy"
                    stroke="#10b981"
                    strokeWidth={2}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="apr"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    strokeDasharray="4 4"
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              {filteredData.every(p => p.apy === 0) && (
                <p className="text-xs text-center text-gray-400 dark:text-white/40 mt-2">
                  Reserve ratio stable — yield estimate will update as fee accumulation occurs
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <div className="bg-gray-50 dark:bg-white/[0.03] border border-gray-200 dark:border-white/[0.06] rounded-lg p-3 mt-3 grid grid-cols-2 gap-4">
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-white/40 uppercase tracking-widest mb-1">APY</h4>
          <p className="text-xs text-gray-500 dark:text-white/40 leading-relaxed">
            Compounds continuously. Reflects the real return if fee accumulation rate holds over a full year.
          </p>
        </div>
        <div>
          <h4 className="text-xs font-semibold text-gray-500 dark:text-white/40 uppercase tracking-widest mb-1">APR</h4>
          <p className="text-xs text-gray-500 dark:text-white/40 leading-relaxed">
            Simple rate without compounding. Lower than APY. Standard comparison metric used across DeFi.
          </p>
        </div>
      </div>
    </div>
  );
}
