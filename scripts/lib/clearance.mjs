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

/**
 * Protected products (Krisztian 2026-11-09): "stop discounting high value items even if they
 * dont move, eg redbull, and monster. no discounts on those, unless i approve also no discounts
 * on milka products unless expiry rule apply. also no discounts on Patisserie Apple Cakes,
 * unless expiry..."
 *   group A — NO automatic discount at all (no clearance, no expiry tier) unless approved in
 *             state.approvedDiscounts. A would-be expiry tier prints "APPROVAL NEEDED expiry …".
 *   group B — never clearance/slow-seller deals; expiry tiers still apply.
 * Case-insensitive match on the lane's commodityName.
 */
export const PROTECTED_PRODUCTS = [
  { id: "redbull", group: "A", re: /red[\s-]*bull/i },
  { id: "monster", group: "A", re: /\bmonster\b/i },
  { id: "milka", group: "B", re: /\bmilka\b/i },
  { id: "patisserie-apple-cakes", group: "B", re: /patisserie\s*apple\s*cakes?/i },
  // Krisztian 2026-11-09 15:02: "stop discount for now on mikado, oreo, paulner spezi" (+ Minecraft figure)
  { id: "minecraft", group: "B", re: /minecraft/i },
  { id: "mikado", group: "B", re: /mikado/i },
  { id: "oreo", group: "B", re: /oreo/i },
  { id: "spezi", group: "B", re: /\bspezi\b/i },
];
export function protectionFor(name) {
  const n = String(name || "");
  return PROTECTED_PRODUCTS.find((p) => p.re.test(n)) || null;
}
/**
 * Approvals: state.approvedDiscounts = { "<rtu>:<lane>" | "product:<id>": { kinds?: ["expiry","clearance"],
 * until?: "YYYY-MM-DD", note?, approvedAt } }. kinds defaults to ["expiry"]. until is inclusive (Berlin day).
 * A lane-key approval only counts while that lane still holds a product with the same protection id
 * (stored as `product`). Manage with scripts/approve-discount.mjs.
 */
export function approvalFor(state, rtuNumber, lane, name, kind, today = berlinToday()) {
  const prot = protectionFor(name);
  const map = state?.approvedDiscounts || {};
  const cands = [map[laneKey(rtuNumber, lane)], prot ? map[`product:${prot.id}`] : null];
  for (const a of cands) {
    if (!a) continue;
    if (a.until && String(a.until).slice(0, 10) < today) continue;
    const kinds = Array.isArray(a.kinds) && a.kinds.length ? a.kinds : ["expiry"];
    if (!kinds.includes(kind)) continue;
    if (a.product && prot && a.product !== prot.id) continue;
    return a;
  }
  return null;
}
/** True when a clearance (slow/dead) deal is not allowed for this product. */
export function clearanceBlocked(state, rtuNumber, lane, name, today = berlinToday()) {
  const prot = protectionFor(name);
  if (!prot) return null;
  if (prot.group === "A" && approvalFor(state, rtuNumber, lane, name, "clearance", today)) return null;
  return prot;
}
/** True when an expiry tier is not allowed (group A without an expiry approval). */
export function expiryBlocked(state, rtuNumber, lane, name, today = berlinToday()) {
  const prot = protectionFor(name);
  if (!prot || prot.group !== "A") return null;
  if (approvalFor(state, rtuNumber, lane, name, "expiry", today)) return null;
  return prot;
}

/**
 * Lean clearance policy (Krisztian approved 2026-11-09 15:12). Expiry tiers are separate and unchanged.
 * A lane is eligible only if it has a best-before date (effDate) and either
 *   waste  — best-before within WASTE_DAYS and the 30-day sales rate won't clear the stock by then, or
 *   dead   — 0 sales in 30 days, stocked >= 30 days, best-before within DEAD_PERISHABLE_DAYS.
 * Lanes without a date, long-life slow sellers, NEW (<14 d) lanes, protected products, qty <= 1 and
 * lanes inside the expiry window (<= 4 d) are not eligible. Max MAX_PER_LOCATION non-pinned deals per
 * location: running deals keep their slot while still eligible (no weekly churn); free slots go to the
 * highest waste risk = expected unsold units × true cost, then soonest best-before. −20% default; −30%
 * only for dead stock with best-before < 30 d. Cost floor ×1.2 applies (clearancePriceFor).
 */
export const POLICY = {
  WASTE_DAYS: 30,
  DEAD_PERISHABLE_DAYS: 90,
  DEAD_MIN_STOCKED_DAYS: 30,
  RATE_WINDOW_DAYS: 30,
  MIN_LEFTOVER: 1, // waste rule: at least 1 unit expected unsold at best-before
  MAX_PER_LOCATION: 3,
  DEFAULT_PCT: 20,
  DEAD_SOON_PCT: 30,
};
/**
 * @param {{stock:number, days:number, u30:number, effDate:string}} r  days = days since current product stocked
 * @returns {{eligible:boolean, why:string, kind?:string, pct?:number, dLeft?:number}}
 */
export function leanEligibility(r, today = berlinToday()) {
  const eff = r.effDate ? String(r.effDate).slice(0, 10) : "";
  if (!eff) return { eligible: false, why: "no best-before date" };
  const dLeft = Math.round((Date.parse(eff + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  if (dLeft < 0) return { eligible: false, why: `expired ${eff}`, dLeft };
  if (dLeft <= 4) return { eligible: false, why: `expiry window d=${dLeft} (expiry tiers own it)`, dLeft };
  const stock = Number(r.stock || 0);
  const dead = Number(r.u30 || 0) === 0 && Number(r.days || 0) >= POLICY.DEAD_MIN_STOCKED_DAYS;
  const rateDays = Math.max(1, Math.min(POLICY.RATE_WINDOW_DAYS, Number(r.days || 0)));
  const projected = (Number(r.u30 || 0) / rateDays) * dLeft;
  const pct = dead && dLeft < POLICY.WASTE_DAYS ? POLICY.DEAD_SOON_PCT : POLICY.DEFAULT_PCT;
  const leftover = Math.max(0, stock - projected); // units expected unsold at best-before
  if (dLeft <= POLICY.WASTE_DAYS && leftover >= POLICY.MIN_LEFTOVER)
    return { eligible: true, kind: "waste", why: `bb in ${dLeft}d, ~${projected.toFixed(1)} of ${stock} would sell`, pct, dLeft, leftover };
  if (dead && dLeft <= POLICY.DEAD_PERISHABLE_DAYS)
    return { eligible: true, kind: "dead", why: `0 sold 30d, stocked ${Math.round(r.days)}d, bb in ${dLeft}d`, pct, dLeft, leftover };
  return { eligible: false, why: dLeft > POLICY.DEAD_PERISHABLE_DAYS ? `long shelf life (bb in ${dLeft}d)` : `sells fast enough (~${projected.toFixed(1)}/${stock})`, dLeft };
}

/** LEGACY Phase-2 seed (Berlin 2026-10-20) — superseded by POLICY; clearance-eval --seed needs --legacy. */
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

/**
 * Why a clearance entry should end now (or null).
 * - entry.endRequested (string): set by the weekly re-eval (rule/cap) or by hand → ends on next run.
 * - entry.pinned: manual exception (Karamalz, Krisztian 2026-11-09). Ignores endsAt, sell-out and
 *   refill; ends only on product change / lane gone / endRequested. Outside the per-location cap.
 */
export function clearanceEndReason(entry, cargo, today = berlinToday()) {
  if (!entry) return null;
  if (entry.endRequested) return `requested(${entry.endRequested})`;
  if (!cargo) return "missing";
  const cid = String(cargo.commodityId || "");
  const name = String(cargo.commodityName || "").trim();
  if (entry.cid && cid && entry.cid !== cid) return "product-change";
  if (entry.name && name && entry.name !== name) return "product-change";
  if (entry.pinned) return null;
  if (entry.endsAt && String(entry.endsAt).slice(0, 10) < today) return "endsAt";
  if (Number(cargo.stock || 0) <= 0) return "soldout";
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
    const prot = clearanceBlocked(state, s.rtu, s.lane, cargo.commodityName, today);
    if (prot) {
      console.warn(`seed skip ${s.rtu}:${s.lane} ${cargo.commodityName} — protected (${prot.id}, group ${prot.group})`);
      delete state.clearance[key];
      continue;
    }
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
