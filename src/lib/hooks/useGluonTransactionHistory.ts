/**
 * @file useGluonTransactionHistory.ts
 * @description Fetches Gluon Gold protocol box history from the Ergo Explorer API.
 *
 * FIX (v4): Previous versions fetched only limit=100 boxes, which caused history
 * to stop at Aug 13, 2024. There are 667+ valid protocol state boxes. This version
 * paginates through ALL pages.
 *
 * SECONDARY FINDING: A contract address upgrade happened at height ~1397584
 * (Nov 22, 2024). The NFT lineage (797e331d...) is continuous; the address changed
 * from E81MR2gGkYE1vDkdcGYns4wYehfJLdX6hpwHMGrh to
 * U2Jtp6oeBTnbGS7ed2PvkudukZYRBBSfi557aCmz. This is marked in snapshots.
 */

import { useEffect, useState } from "react";


export interface GluonBoxSnapshot {
  height: number;
  timestamp: number;       // unix ms (approximate)
  ergValue: number;        // in ERG (not nanoERG)
  neutronAmount: number;   // raw token units
  protonAmount: number;    // raw token units
  feePaidErg: number;      // ERG difference from previous box (0 if first or negative)
  spentTxId: string | null;
  source: "pre-migration" | "post-migration";
  migrationBoundary: boolean;
}

export interface UseGluonTransactionHistoryResult {
  snapshots: GluonBoxSnapshot[];
  loading: boolean;
  error: string | null;
  totalCount: number;
  migrationHeights: number[];
  notes: string[];
}

interface ExplorerAsset {
  tokenId: string;
  amount: number;
}

interface ExplorerBox {
  boxId: string;
  transactionId: string;
  blockId: string;
  creationHeight: number;
  value: number; // nanoErgs
  assets: ExplorerAsset[];
  address: string;
  spentTransactionId: string | null;
}

const CACHE_KEY = "gluon_box_history_v4";
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const EXPLORER_BASE = "https://api.ergoplatform.com/api/v1";
const BLOCK_TIME_MS = 120_000; // 2 minutes per block
const PAGE_SIZE = 100; // Max allowed by Explorer API

const NEUTRON_ID = "886b7721bef42f60c6317d37d8752da8aca01898cae7dae61808c4a14225edc8";
const PROTON_ID  = "9944ff273ff169f32b851b96bbecdbb67f223101c15ae143de82b3e7f75b19d2";

// Known contract upgrade: address changed at ~height 1397584 (Nov 22, 2024)
// Old: E81MR2gGkYE1vDkdcGYns4wYehfJLdX6hpwHMGrh
// New: U2Jtp6oeBTnbGS7ed2PvkudukZYRBBSfi557aCmz
const OLD_CONTRACT_ADDRESS = "E81MR2gGkYE1vDkdcGYns4wYehfJLdX6hpwHMGrh";
const NEW_CONTRACT_ADDRESS = "U2Jtp6oeBTnbGS7ed2PvkudukZYRBBSfi557aCmz";

interface CacheEntry {
  fetchedAt: number;
  snapshots: GluonBoxSnapshot[];
  totalCount: number;
  migrationHeights: number[];
  notes: string[];
}

function readCache(): CacheEntry | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCache(entry: CacheEntry): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {}
}

/**
 * Fetches ALL pages of boxes carrying the protocol NFT.
 * The Explorer API allows max 100 per page; we paginate until done.
 */
async function fetchAllBoxesByNft(nftId: string): Promise<ExplorerBox[]> {
  const all: ExplorerBox[] = [];
  let offset = 0;
  let pageNum = 0;

  while (true) {
    const url = `${EXPLORER_BASE}/boxes/byTokenId/${nftId}?limit=${PAGE_SIZE}&offset=${offset}&sortDirection=asc`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Explorer boxes fetch failed: ${res.status} at offset ${offset}`);

    const data = await res.json();
    const items: ExplorerBox[] = data.items || [];
    all.push(...items);
    pageNum++;

    console.log(`[GluonHistory] Page ${pageNum}: offset=${offset} got=${items.length} cumulative=${all.length}`);

    if (items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;

    // Safety: stop at 10000 boxes to prevent runaway loops
    if (all.length >= 10000) {
      console.warn("[GluonHistory] Safety limit reached at 10000 boxes");
      break;
    }
  }

  return all;
}

export function useGluonTransactionHistory(): UseGluonTransactionHistoryResult {
  const [snapshots, setSnapshots] = useState<GluonBoxSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [totalCount, setTotalCount] = useState(0);
  const [migrationHeights, setMigrationHeights] = useState<number[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      // Try cache first
      const cached = readCache();
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        if (!cancelled) {
          setSnapshots(cached.snapshots);
          setTotalCount(cached.totalCount);
          setMigrationHeights(cached.migrationHeights);
          setNotes(cached.notes);
          setLoading(false);
        }
        return;
      }

      // Show stale data while fetching fresh
      if (cached) {
        if (!cancelled) {
          setSnapshots(cached.snapshots);
          setTotalCount(cached.totalCount);
          setMigrationHeights(cached.migrationHeights || []);
          setNotes(cached.notes || []);
        }
      }

      try {
        console.log("[GluonHistory] Starting full paginated history fetch...");

        const sdk = await import("gluon-ergo-sdk");
        const GLUON_NFT_ID = sdk.GLUON_NFT;

        const [allBoxes, headersRes] = await Promise.all([
          fetchAllBoxesByNft(GLUON_NFT_ID),
          fetch(`${EXPLORER_BASE}/blocks/headers?limit=1`)
        ]);

        if (!headersRes.ok) throw new Error(`Explorer headers fetch failed: ${headersRes.status}`);

        const headersData = await headersRes.json();
        const currentHeight: number = headersData.items[0].height;
        const currentTimestamp: number = headersData.items[0].timestamp;

        console.log(`[GluonHistory] Total boxes from NFT lineage: ${allBoxes.length}`);

        // Filter to valid protocol state boxes (must carry both neutron and proton)
        const validBoxes = allBoxes.filter(b => {
          if (b.value === 0) return false;
          const hasNeutron = b.assets.some(a => a.tokenId === NEUTRON_ID);
          const hasProton = b.assets.some(a => a.tokenId === PROTON_ID);
          return hasNeutron && hasProton;
        });

        console.log(`[GluonHistory] Valid state boxes (has neutron+proton): ${validBoxes.length}`);

        // Detect migration: track when contract address changes
        const detectedMigrationHeights: number[] = [];
        const migrationNotes: string[] = [];
        let prevAddress: string | null = null;
        let inMigration = false;

        // Pre-scan to detect address transitions
        for (const b of validBoxes) {
          const addr = b.address;
          if (prevAddress && addr !== prevAddress && !inMigration) {
            detectedMigrationHeights.push(b.creationHeight);
            migrationNotes.push(
              `Contract address changed at height ${b.creationHeight}: ${prevAddress.slice(0, 16)}... → ${addr.slice(0, 16)}...`
            );
            inMigration = true;
          }
          if (addr === NEW_CONTRACT_ADDRESS && prevAddress === OLD_CONTRACT_ADDRESS) {
            inMigration = false; // Reset after we've logged it
          }
          prevAddress = addr;
        }

        if (detectedMigrationHeights.length === 0) {
          migrationNotes.push("No contract address change detected in fetched boxes.");
        }

        console.log("[GluonHistory] Migration heights detected:", detectedMigrationHeights);

        // Build snapshots
        const newSnapshots: GluonBoxSnapshot[] = [];
        const migrationHeightSet = new Set(detectedMigrationHeights);

        for (let i = 0; i < validBoxes.length; i++) {
          const b = validBoxes[i];
          const prev = i > 0 ? validBoxes[i - 1] : null;

          const nAsset = b.assets.find(a => a.tokenId === NEUTRON_ID);
          const pAsset = b.assets.find(a => a.tokenId === PROTON_ID);

          const ergValue = b.value / 1e9;
          const prevErg = prev ? prev.value / 1e9 : 0;
          const feePaidErg = prev ? Math.max(0, +(ergValue - prevErg).toFixed(6)) : 0;

          const approxTimestamp =
            currentTimestamp - (currentHeight - b.creationHeight) * BLOCK_TIME_MS;

          // Determine source: pre or post migration
          const source: "pre-migration" | "post-migration" =
            detectedMigrationHeights.length > 0 &&
            b.creationHeight >= detectedMigrationHeights[0]
              ? "post-migration"
              : "pre-migration";

          newSnapshots.push({
            height: b.creationHeight,
            timestamp: approxTimestamp,
            ergValue,
            neutronAmount: nAsset ? nAsset.amount : 0,
            protonAmount: pAsset ? pAsset.amount : 0,
            feePaidErg,
            spentTxId: b.spentTransactionId,
            source,
            migrationBoundary: migrationHeightSet.has(b.creationHeight),
          });
        }

        const total = validBoxes.length;
        const lastSnapshot = newSnapshots[newSnapshots.length - 1];
        const firstSnapshot = newSnapshots[0];
        const postMigCount = newSnapshots.filter(s => s.source === "post-migration").length;

        console.log("[GluonHistory] old lineage snapshots:", newSnapshots.filter(s => s.source === "pre-migration").length);
        console.log("[GluonHistory] post-migration snapshots:", postMigCount);
        console.log("[GluonHistory] migration heights:", detectedMigrationHeights);
        console.log("[GluonHistory] merged snapshots total:", newSnapshots.length);
        if (lastSnapshot) {
          console.log("[GluonHistory] last snapshot date:", new Date(lastSnapshot.timestamp).toISOString());
        }
        if (firstSnapshot) {
          console.log("[GluonHistory] first snapshot date:", new Date(firstSnapshot.timestamp).toISOString());
        }

        const diagnosticNotes = [
          `Total valid boxes fetched: ${total}`,
          `Pre-migration: ${newSnapshots.filter(s => s.source === "pre-migration").length} boxes`,
          `Post-migration: ${postMigCount} boxes`,
          firstSnapshot
            ? `First box: ${new Date(firstSnapshot.timestamp).toISOString().split("T")[0]}`
            : "No first box",
          lastSnapshot
            ? `Last box: ${new Date(lastSnapshot.timestamp).toISOString().split("T")[0]}`
            : "No last box",
          ...migrationNotes,
        ];

        const entry: CacheEntry = {
          fetchedAt: Date.now(),
          snapshots: newSnapshots,
          totalCount: total,
          migrationHeights: detectedMigrationHeights,
          notes: diagnosticNotes,
        };

        if (!cancelled) {
          writeCache(entry);
          setSnapshots(newSnapshots);
          setTotalCount(total);
          setMigrationHeights(detectedMigrationHeights);
          setNotes(diagnosticNotes);
          setError(null);
          setLoading(false);
        }
      } catch (err) {
        console.error("[GluonHistory] Fetch failed:", err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { snapshots, loading, error, totalCount, migrationHeights, notes };
}
