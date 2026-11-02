/**
 * Clearance (slow/dead) discount helpers.
 * Classification rules match Phase-1 PLAN; Schiesheim Left (7680782) always excluded.
 */
import {
  berlinToday,
  addDaysYmd,
  tierPrice,
  laneKey,
  MACHINES,
} from "./impressiot.mjs";

export const CLEARANCE_DAYS = 14;
export const OFFLINE_RTUS = new Set(["7680782"]);
export const HIDE_FROM_AD = new Set(["durex"]); // name substring match, lowercase
/**
 * Low-stock guard (Krisztian 2026-11-02): a clearance lane with <= LOW_STOCK_MAX units left
 * goes back to its normal price (suspended, not ended). It resumes if refilled to >= 2 before
 * endsAt. Expiry-tier discounts are NOT affected by this guard.
 */
export const LOW_STOCK_MAX = 1;

/**
 * Cost floor (Krisztian 2026-11-02): a clearance price is never below true cost × 1.20,
 * rounded UP to the next €0.05, and never above the normal price. If the floor reaches the
 * normal price the deal is dropped. True cost = originalCostPrice stored in discounts.json
 * (the machine's costPrice is skewed by past discount writes). Expiry tiers are NOT floored.
 */
export const COST_FLOOR_MARKUP = 1.2;
export function ceilTo005(n) {
  const cents = Math.round(Number(n) * 100 * 1000) / 1000; // kill float noise
  return Math.ceil(cents / 5 - 1e-9) * 5 / 100;
}
export function clearancePriceFor(original, pct, cost) {
  const orig = Number(original);
  const base = tierPrice(orig, pct);
  const c = Number(cost);
  if (!(c > 0)) return { price: base, base, floor: null, costKnown: false, blocked: false, floored: false };
  const floor = Math.round(ceilTo005(c * COST_FLOOR_MARKUP) * 100) / 100;
  if (floor >= orig) return { price: orig, base, floor, costKnown: true, blocked: true, floored: true };
  const price = Math.round(Math.max(base, floor) * 100) / 100;
  return { price, base, floor, costKnown: true, blocked: false, floored: price > base };
}
export function effectivePercent(original, price) {
  const o = Number(original);
  return o > 0 ? Math.round((1 - Number(price) / o) * 100) : 0;
}
export function isLowStock(cargo) {
  const n = Number(cargo?.stock || 0);
  return n > 0 && n <= LOW_STOCK_MAX;
}

/** Approved Phase-2 seed (Berlin 2026-10-20). Karamalz included per Krisztian. */
export const APPROVED_SEED = [
  // Steinsberg Right — dead −30%
  { rtu: "7680800", lane: "5", pct: 30, reason: "dead", hideFromAd: true },
  { rtu: "7680800", lane: "31", pct: 30, reason: "dead" },
  { rtu: "7680800", lane: "37", pct: 30, reason: "dead" },
  { rtu: "7680800", lane: "38", pct: 30, reason: "dead" },
  // Steinsberg Right — slow −20%
  { rtu: "7680800", lane: "11", pct: 20, reason: "slow" },
  { rtu: "7680800", lane: "12", pct: 20, reason: "slow" },
  { rtu: "7680800", lane: "22", pct: 20, reason: "slow" },
  { rtu: "7680800", lane: "32", pct: 20, reason: "slow" },
  { rtu: "7680800", lane: "33", pct: 20, reason: "slow" },
  { rtu: "7680800", lane: "42", pct: 20, reason: "slow" },
  // Steinsberg Left — dead −30%
  { rtu: "7680783", lane: "2", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "4", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "12", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "13", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "15", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "22", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "36", pct: 30, reason: "dead" },
  { rtu: "7680783", lane: "38", pct: 30, reason: "dead" },
  // Steinsberg Left — slow −20% (+ Karamalz 31/32/33 explicit)
  { rtu: "7680783", lane: "31", pct: 20, reason: "slow" },
  { rtu: "7680783", lane: "32", pct: 20, reason: "slow" },
  { rtu: "7680783", lane: "33", pct: 20, reason: "slow" },
  { rtu: "7680783", lane: "44", pct: 20, reason: "slow" },
  { rtu: "7680783", lane: "51", pct: 20, reason: "slow" },
  // Schiesheim Right — dead / slow
  { rtu: "7680787", lane: "12", pct: 30, reason: "dead" },
  { rtu: "7680787", lane: "1", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "15", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "22", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "33", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "34", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "37", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "38", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "48", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "51", pct: 20, reason: "slow" },
  { rtu: "7680787", lane: "55", pct: 20, reason: "slow" },
];

export function shouldHideFromAd(name, flag) {
  if (flag) return true;
  const n = String(name || "").toLowerCase();
  return [...HIDE_FROM_AD].some((s) => n.includes(s));
}

/** Build a clearance entry from live cargo + seed/eval params. Uses stored original if already discounted. */
export function makeClearanceEntry(rtuNumber, cargo, { pct, reason, originalPrice, originalCostPrice, stockAtStart, endsAt, startedAt, hideFromAd }) {
  const lane = String(cargo.cargoNumber);
  const name = String(cargo.commodityName || "").trim();
  const orig = Number(originalPrice ?? cargo.price);
  const origCost = Number(originalCostPrice ?? cargo.costPrice ?? 0);
  const cp = clearancePriceFor(orig, pct, origCost);
  const price = cp.price;
  const today = berlinToday();
  return {
    rtuNumber: String(rtuNumber),
    lane,
    name,
    cid: String(cargo.commodityId || ""),
    originalPrice: orig,
    originalCostPrice: origCost,
    clearancePrice: price,
    clearanceCostPrice: Math.min(origCost, price),
    percent: pct,
    effectivePercent: effectivePercent(orig, price),
    costFloor: cp.floor,
    costKnown: cp.costKnown,
    floorBlocked: cp.blocked,
    reason: reason || "slow",
    startedAt: startedAt || new Date().toISOString(),
    endsAt: endsAt || addDaysYmd(today, CLEARANCE_DAYS),
    stockAtStart: stockAtStart != null ? Number(stockAtStart) : Number(cargo.stock || 0),
    hideFromAd: shouldHideFromAd(name, hideFromAd),
    updatedAt: new Date().toISOString(),
  };
}

/** Why a clearance entry should end now (or null). */
export function clearanceEndReason(entry, cargo, today = berlinToday()) {
  if (!entry) return null;
  if (entry.endsAt && String(entry.endsAt).slice(0, 10) < today) return "endsAt";
  if (!cargo) return "missing";
  if (Number(cargo.stock || 0) <= 0) return "soldout";
  const cid = String(cargo.commodityId || "");
  const name = String(cargo.commodityName || "").trim();
  if (entry.cid && cid && entry.cid !== cid) return "product-change";
  if (entry.name && name && entry.name !== name) return "product-change";
  // A low-stock-suspended entry is resumed (not ended) by a refill — see planForMachine.
  if (!entry.suspended && Number(cargo.stock || 0) > Number(entry.stockAtStart || 0)) return "refill";
  return null;
}

/**
 * Seed clearance map from APPROVED_SEED using live replenish rows.
 * Keeps existing clearance entries that still match; refreshes price from original.
 * @param {object} state discounts.json state
 * @param {Map<string, object>} cargoByRtu rtu -> replenish row
 */
export function seedClearance(state, cargoByRtu, { today = berlinToday(), forceEndsAt = null } = {}) {
  state.clearance ||= {};
  const seeded = [];
  for (const s of APPROVED_SEED) {
    if (OFFLINE_RTUS.has(s.rtu)) continue;
    const row = cargoByRtu.get(String(s.rtu));
    const cargo = (row?.cargos || []).find((c) => String(c.cargoNumber) === String(s.lane));
    if (!cargo?.commodityName) {
      console.warn(`seed skip ${s.rtu}:${s.lane} — no named cargo`);
      continue;
    }
    const key = laneKey(s.rtu, s.lane);
    const prev = state.clearance[key];
    const active = state.active?.[key];
    // Prefer stored original (active/clearance) so we never compound.
    const originalPrice = prev?.originalPrice ?? active?.originalPrice ?? Number(cargo.price);
    const originalCostPrice = prev?.originalCostPrice ?? active?.originalCostPrice ?? Number(cargo.costPrice ?? 0);
    const entry = makeClearanceEntry(s.rtu, cargo, {
      pct: s.pct,
      reason: s.reason,
      originalPrice,
      originalCostPrice,
      stockAtStart: prev?.stockAtStart ?? Number(cargo.stock || 0),
      endsAt: forceEndsAt || prev?.endsAt || addDaysYmd(today, CLEARANCE_DAYS),
      startedAt: prev?.startedAt,
      hideFromAd: s.hideFromAd,
    });
    if (entry.floorBlocked) {
      console.warn(`seed skip ${s.rtu}:${s.lane} ${entry.name} — cost floor ${entry.costFloor} >= normal ${entry.originalPrice}`);
      delete state.clearance[key];
      continue;
    }
    if (!entry.costKnown) console.warn(`seed ${s.rtu}:${s.lane} ${entry.name} — COST UNKNOWN, no floor`);
    state.clearance[key] = entry;
    seeded.push(entry);
  }
  return seeded;
}

export function locationOfRtu(rtu) {
  return MACHINES.find((m) => String(m.rtuNumber) === String(rtu))?.locationId || null;
}
