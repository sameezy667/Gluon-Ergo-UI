/**
 * @file ReserveRatioChart.tsx
 * @description Polls the Gluon box every 60 s to track the protocol reserve ratio.
 * Uses the same formula as GluonStats.tsx:
 *   ratio% = (tvl * 1e14) / (circNeutrons * goldPrice)
 * Renders a recharts AreaChart with thresholds: Healthy ≥300%, Caution 150–300%, Risk <150%.
 * @module frontend/components/blocks/dashboard
 */
"use client";

import { useEffect, useState, useMemo } from "react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";

// ─── Constants ────────────────────────────────────────────────────────────────

const HISTORY_KEY = "gluon_reserve_history";
const MAX_ENTRIES = 720; // 30 days @ 1/hr
const POLL_INTERVAL_MS = 60_000;

// ─── Types ────────────────────────────────────────────────────────────────────

interface RatioEntry {
  timestamp: number;
  ratio: number; // stored as percentage, e.g. 152 means 152%
}

type TimeRange = "7D" | "14D" | "30D";

const RANGE_DAYS: Record<TimeRange, number> = { "7D": 7, "14D": 14, "30D": 30 };

// ─── LocalStorage ─────────────────────────────────────────────────────────────

function loadHistory(): RatioEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? (JSON.parse(raw) as RatioEntry[]) : [];
  } catch {
    return [];
  }
}

function appendAndSave(entry: RatioEntry): RatioEntry[] {
  const history = loadHistory();
  history.push(entry);
  const capped = history.slice(-MAX_ENTRIES);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(capped));
  } catch {
    /* quota exceeded */
  }
  return capped;
}

// ─── Health helpers ───────────────────────────────────────────────────────────

/**
 * Thresholds calibrated to observed live values (56–160% range).
 * Healthy: ≥300 | Caution: 150–300 | Risk: <150
 */
function getStatus(ratio: number): { label: "Healthy" | "Caution" | "Risk"; color: string } {
  if (ratio >= 300) return { label: "Healthy", color: "#10b981" };
  if (ratio >= 150) return { label: "Caution", color: "#f59e0b" };
  return { label: "Risk", color: "#ef4444" };
}

function areaStrokeColor(ratio: number): string {
  return getStatus(ratio).color;
}

function areaFillOpacity(ratio: number): number {
  return ratio >= 800 ? 0.3 : ratio >= 400 ? 0.3 : 0.3;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

interface TooltipPayloadItem {
  payload: RatioEntry;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadItem[];
}

function CustomTooltip({ active, payload }: CustomTooltipProps) {
  if (!active || !payload?.length) return null;
  const entry = payload[0].payload;
  const { label, color } = getStatus(entry.ratio);

  const dateStr = new Date(entry.timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="rounded-lg border border-gray-200 dark:border-white/10 bg-white dark:bg-[#1e1e1e] px-3 py-2 text-xs shadow-none">
      <p className="mb-1 text-gray-400 dark:text-white/40">{dateStr}</p>
      <p className="mb-1.5 text-sm font-semibold text-gray-900 dark:text-white">
        {entry.ratio.toFixed(1)}%
      </p>
      <span
        className="rounded-full px-2 py-0.5 text-xs font-medium text-black"
        style={{ backgroundColor: color }}
      >
        {label}
      </span>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ReserveRatioChart() {
  const [history, setHistory] = useState<RatioEntry[]>([]);
  const [range, setRange] = useState<TimeRange>("7D");
  const [currentRatio, setCurrentRatio] = useState<number>(400);

  const isDark = typeof window !== "undefined" && document.documentElement.classList.contains("dark");

  // Poll getGluonBox every 60 s
  useEffect(() => {
    let mounted = true;

    async function fetchRatio() {
      try {
        const sdk = await import("gluon-ergo-sdk");
        const gluon = new sdk.Gluon();
        gluon.config.NETWORK = process.env.NEXT_PUBLIC_DEPLOYMENT || "testnet";
        const [gluonBox, oracleBox] = await Promise.all([
          gluon.getGluonBox(),
          gluon.getOracleBox(),
        ]);

        // Replicate the exact formula from GluonStats.tsx line 147:
        //   reserveRatioBN = BigNumber(+BigNumber(tvl) * 1e14 / (+BigNumber(circNeutrons) * goldPrice))
        // tvl and goldPrice are raw bigints from the SDK; circNeutrons is also a bigint.
        const [tvl, goldPrice, circNeutrons] = await Promise.all([
          gluon.getTVL(gluonBox, oracleBox),          // bigint, nanoErgs
          oracleBox.getPrice(),                        // bigint, nanoErgs/mg
          gluonBox.getNeutronsCirculatingSupply(),     // bigint, token subunits
        ]);

        // Both bigint operands must be converted to Number before multiplication
        // to avoid precision loss and match GluonStats.tsx exactly.
        const tvlNum = Number(tvl);
        const circNeutronsNum = Number(circNeutrons);
        const goldPriceNum = Number(goldPrice);

        if (
          !mounted ||
          tvlNum === 0 ||
          circNeutronsNum === 0 ||
          goldPriceNum === 0
        ) return;

        const ratio = (tvlNum * 1e14) / (circNeutronsNum * goldPriceNum);
        if (isNaN(ratio) || !isFinite(ratio)) return;

        setCurrentRatio(ratio);
        const existing = loadHistory();
        const lastEntry = existing[existing.length - 1];
        const hasChanged = !lastEntry || Math.abs(lastEntry.ratio - ratio) > 0.1;
        const isFirstEntry = existing.length === 0;
        if (hasChanged || isFirstEntry) {
          const updated = appendAndSave({ timestamp: Date.now(), ratio });
          setHistory(updated);
        }
      } catch (err) {
        console.error("[ReserveRatioChart]", err);
      }
    }

    // Wipe stale localStorage entries that are outside the valid 1–1000% range.
    // Values > 1000 are raw BigInt nanoErg amounts stored incorrectly.
    // Values < 1 are pre-normalisation decimals (0.57 etc.).
    try {
      const raw = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      const cleaned = (raw as { ratio: number }[]).filter(
        (e) => e.ratio >= 1 && e.ratio <= 1000
      );
      if (cleaned.length !== raw.length) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(cleaned));
      }
    } catch { /* ignore */ }

    // Seed from cache
    const cached = loadHistory();
    if (cached.length) {
      // Deduplicate: remove consecutive entries with the same value (keep first occurrence)
      const deduped = cached.filter((entry, i) => {
        if (i === 0) return true;
        return Math.abs(entry.ratio - cached[i - 1].ratio) > 0.1;
      });
      if (deduped.length !== cached.length) {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(deduped));
      }

      setHistory(deduped);
      setCurrentRatio(deduped[deduped.length - 1].ratio);
    }

    fetchRatio();
    const id = setInterval(fetchRatio, POLL_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, []);

  // Filter by selected range
  const filtered = useMemo(() => {
    const cutoff = Date.now() - RANGE_DAYS[range] * 24 * 60 * 60 * 1000;
    return history.filter((e) => e.timestamp >= cutoff);
  }, [history, range]);

  const chartData = filtered.map((e) => ({ ...e, ratio: +e.ratio.toFixed(1) }));
  const strokeColor = areaStrokeColor(currentRatio);
  const { color: currentColor } = getStatus(currentRatio);

  return (
    <div className="mt-6 rounded-xl border border-gray-200 dark:border-white/[0.07] bg-white dark:bg-[#141414] p-5">
      {/* Header row */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-baseline gap-2">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Reserve Ratio</h3>
          <span className="text-xs font-normal text-gray-400 dark:text-white/40">polled every 60s</span>
        </div>

        {/* Range toggle */}
        <div
          className="flex rounded-lg bg-gray-100 dark:bg-white/5 p-0.5"
          role="group"
          aria-label="Chart time range"
        >
          {(["7D", "14D", "30D"] as TimeRange[]).map((r) => (
            <button
              key={r}
              id={`reserve-ratio-range-${r}`}
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

      {/* Chart */}
      <div className="h-56 w-full">
        {chartData.length < 1 ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-xs text-gray-400 dark:text-white/40 text-center">
              Collecting history — chart populates over time
            </p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={chartData}
              margin={{ top: 4, right: 4, left: -16, bottom: 0 }}
            >
              <defs>
                <linearGradient id="reserveGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor={currentColor}
                    stopOpacity={areaFillOpacity(currentRatio)}
                  />
                  <stop offset="100%" stopColor={currentColor} stopOpacity={0} />
                </linearGradient>
              </defs>

              <CartesianGrid
                strokeDasharray="0"
                stroke={isDark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.06)"}
                vertical={false}
              />

              <XAxis
                dataKey="timestamp"
                tickFormatter={(v: number) =>
                  new Date(v).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })
                }
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#9ca3af", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                minTickGap={48}
              />

              <YAxis
                tick={{ fill: isDark ? "rgba(255,255,255,0.3)" : "#9ca3af", fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => v + "%"}
                domain={[0, (dataMax: number) => Math.max(Math.ceil(dataMax * 1.3), 350)]}
              />

              <RechartsTooltip
                content={<CustomTooltip />}
                cursor={{ stroke: isDark ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.08)", strokeWidth: 1 }}
              />

              {/* Healthy threshold */}
              <ReferenceLine
                y={300}
                stroke="#10b98166"
                strokeDasharray="4 4"
                label={{
                  value: "Healthy",
                  fill: "#10b98199",
                  fontSize: 10,
                  position: "insideTopRight",
                }}
              />
              {/* Caution threshold */}
              <ReferenceLine
                y={150}
                stroke="#f59e0b66"
                strokeDasharray="4 4"
                label={{
                  value: "Caution",
                  fill: "#f59e0b99",
                  fontSize: 10,
                  position: "insideTopRight",
                }}
              />
              {/* Risk threshold */}
              <ReferenceLine
                y={100}
                stroke="#ef444466"
                strokeDasharray="4 4"
                label={{
                  value: "Risk",
                  fill: "#ef444499",
                  fontSize: 10,
                  position: "insideTopRight",
                }}
              />

              <Area
                type="monotone"
                dataKey="ratio"
                stroke={strokeColor}
                strokeWidth={1.5}
                fill="url(#reserveGradient)"
                dot={false}
                connectNulls={false}
                activeDot={{ r: 4, fill: strokeColor, stroke: "#0f0f0f", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Explanatory text */}
      <div className="mt-3 rounded-lg border border-gray-100 dark:border-white/[0.06] bg-gray-50 dark:bg-white/[0.03] p-3">
        <p className="text-xs leading-relaxed text-gray-400 dark:text-white/40">
          The reserve ratio shows how much ERG collateral backs circulating GAU.
          Above 300% is well-collateralized. Between 150–300% is the caution zone.
          Below 150%, the protocol may restrict transmutations to protect the GAU peg.
        </p>
      </div>
    </div>
  );
}
