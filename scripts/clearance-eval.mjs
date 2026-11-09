#!/usr/bin/env node
/**
 * Seed or weekly-reevaluate clearance map in data/discounts.json.
 * Does NOT write machine prices — run expiry-discount.mjs --apply afterwards.
 *
 *   node scripts/clearance-eval.mjs --seed          # Phase-2 approved list
 *   node scripts/clearance-eval.mjs --reeval [--dry-run]  # weekly lean-policy scan (see POLICY)
 *   node scripts/clearance-eval.mjs --seed --apply   # seed then apply prices+ads
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  MACHINES, login, api, fetchReplenish, berlinToday, addDaysYmd, laneKey, tierPrice,
} from "./lib/impressiot.mjs";
import {
  APPROVED_SEED, CLEARANCE_DAYS, OFFLINE_RTUS, seedClearance, makeClearanceEntry,
  shouldHideFromAd, locationOfRtu, isLowStock, clearanceBlocked, leanEligibility, POLICY,
} from "./lib/clearance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(ROOT, "data", "discounts.json");
const args = new Set(process.argv.slice(2));
const SEED = args.has("--seed");
const REEVAL = args.has("--reeval");
const APPLY = args.has("--apply");
const DRY = args.has("--dry-run");
const DAY_MS = 86400000;

function loadState() {
  if (!existsSync(STATE_PATH)) return { version: 1, active: {}, clearance: {}, machineAds: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}
function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function fmtDate(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

async function pullOrders(token, daysBack = 120) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * DAY_MS);
  const pad = (d) => {
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
    return { s: `${y}/${m}/${day} 00:00:00`, e: `${y}/${m}/${day} 23:59:59`, ms: d.getTime() };
  };
  // Use broad window like the panel
  const s = "2025/01/01 00:00:00", e = "2027/12/31 23:59:59";
  const base = {
    ownedUserId: "", rtuNumber: "", name: "", realName: "", transactionId: "",
    orderState: null, buyType: null, recommendCode: "", phone: "", cargoNumber: "",
    commodityName: "", mainTradeNo: "", plat: "", prizeState: null,
    startDate: s, endDate: e, startDate1: new Date(s).getTime(), endDate1: new Date(e).getTime(),
    pageSize: 200,
  };
  const all = [];
  let page = 1, total = Infinity;
  while (all.length < total && page < 60) {
    const { http, json } = await api(token, "POST", "/order/page", { body: { ...base, page } });
    if (http !== 200 || json.code !== 200) throw new Error(`order/page: ${json.msg}`);
    total = json.data.total;
    all.push(...(json.data.list || []));
    page++;
  }
  return all;
}

async function pullReplenishHistory(token) {
  const base = {
    rtuNumber: "", cargoNumber: "", commodityName: "",
    startDate: "2025/01/01 00:00:00", endDate: "2027/12/31 23:59:59", pageSize: 500,
  };
  const all = [];
  let page = 1, total = Infinity;
  while (all.length < total && page < 100) {
    const { http, json } = await api(token, "POST", "/replenishHistory/page", { body: { ...base, page } });
    if (http !== 200 || json.code !== 200) throw new Error(`replenishHistory: ${json.msg}`);
    total = json.data.total;
    all.push(...(json.data.list || []));
    page++;
  }
  return all;
}

function unitsSold(o) {
  if (o.orderState === 2) return o.successNum || o.buyCount || 0;
  if (o.orderState === 3) {
    const m = String(o.orderStateStr || "").match(/S:(\d+)/);
    return m ? Number(m[1]) : 0;
  }
  return 0;
}

/** Per-lane current-product stint metrics. */
function analyzeLanes(orders, hist, cargoByRtu) {
  const NOW = Date.now();
  const events = new Map(); // key -> [{t,cid,kind,units}]
  for (const o of orders) {
    const u = unitsSold(o);
    const key = `${o.rtuNumber}:${o.cargoNumber}`;
    if (!events.has(key)) events.set(key, []);
    events.get(key).push({ t: o.orderTime, cid: String(o.commodityId), kind: "o", units: u });
  }
  for (const h of hist) {
    const key = `${h.rtuNumber}:${h.cargoNumber}`;
    if (!events.has(key)) events.set(key, []);
    events.get(key).push({ t: h.createTime, cid: String(h.commodityId), kind: "r", units: Number(h.diff || 0) });
  }
  const rows = [];
  for (const [rtu, row] of cargoByRtu) {
    if (OFFLINE_RTUS.has(rtu)) continue;
    for (const c of row.cargos || []) {
      if (!c.commodityName || String(c.commodityId || "").length < 6) continue;
      if (Number(c.status) !== 0) continue;
      const lane = String(c.cargoNumber);
      const key = `${rtu}:${lane}`;
      const cid = String(c.commodityId);
      const E = (events.get(key) || []).slice().sort((a, b) => a.t - b.t);
      const other = E.filter((e) => e.cid !== cid).map((e) => e.t);
      const lastOther = other.length ? Math.max(...other) : 0;
      const mine = E.filter((e) => e.cid === cid && e.t > lastOther);
      const start = mine.length ? Math.min(...mine.map((e) => e.t)) : null;
      const days = start ? (NOW - start) / DAY_MS : 0;
      const sold = mine.filter((e) => e.kind === "o" && e.units > 0);
      const units = sold.reduce((s, e) => s + e.units, 0);
      const u14 = sold.filter((e) => e.t > NOW - 14 * DAY_MS).reduce((s, e) => s + e.units, 0);
      const u30 = sold.filter((e) => e.t > NOW - 30 * DAY_MS).reduce((s, e) => s + e.units, 0);
      const rate = days >= 1 ? units / days : null;
      let klass = "steady";
      if (!start || days < 14) klass = "NEW";
      else if (units === 0 && Number(c.stock) > 0) klass = "dead";
      else if (days >= 28 && rate < 0.05 && u14 === 0 && Number(c.stock) >= 2) klass = "slow";
      rows.push({
        rtu, lane, key, cid, name: String(c.commodityName).trim(),
        stock: Number(c.stock), days, units, u14, u30, rate, klass, cargo: c,
        effDate: c.effDate ? String(c.effDate).slice(0, 10) : "",
      });
    }
  }
  return rows;
}

/**
 * Weekly re-eval under the lean POLICY (lib/clearance.mjs). Evaluates every analysed lane plus every
 * existing non-pinned clearance entry; picks max POLICY.MAX_PER_LOCATION per location (running deals
 * first, then waste risk € = expected unsold × cost, then soonest best-before); existing entries that fail the rules or the cap get endRequested
 * (expiry-discount.mjs ends them and restores the normal price). Pinned entries are untouched except
 * that their endsAt is rolled forward.
 */
function reevalClearance(state, rows, { today = berlinToday() } = {}) {
  state.clearance ||= {};
  const byKey = new Map(rows.map((r) => [r.key, r]));
  // Selling siblings: same loc+cid with u14>0 → don't discount a duplicate lane of a seller
  const byLocCid = new Map();
  for (const r of rows) {
    const k = `${locationOfRtu(r.rtu)}|${r.cid}`;
    if (!byLocCid.has(k)) byLocCid.set(k, []);
    byLocCid.get(k).push(r);
  }
  const cands = [];
  let skipped = 0;
  const reject = (r, why) => {
    const ex = state.clearance[r.key];
    if (ex && !ex.pinned) { ex.endRequested = why; console.log(`  END ${r.key} ${r.name}: ${why}`); }
    else if (!ex) { if (r.klass !== "steady" || why.startsWith("bb in")) console.log(`  skip ${r.key} ${r.name}: ${why}`); skipped++; }
  };
  for (const r of rows) {
    const ex = state.clearance[r.key];
    if (ex?.pinned) {
      ex.endsAt = addDaysYmd(today, CLEARANCE_DAYS);
      console.log(`  PINNED ${r.key} ${r.name} (manual exception, outside cap) until ${ex.endsAt}`);
      continue;
    }
    const prot = clearanceBlocked(state, r.rtu, r.lane, r.name, today);
    if (prot) { reject(r, `protected (${prot.id}, group ${prot.group})`); continue; }
    if (r.klass === "NEW") { reject(r, "new product (<14 d)"); continue; }
    if (isLowStock(r.cargo) && !ex) { reject(r, `low stock (qty ${r.stock})`); continue; }
    const sibs = (byLocCid.get(`${locationOfRtu(r.rtu)}|${r.cid}`) || []).filter((x) => x.key !== r.key && x.u14 > 0);
    if (sibs.length) { reject(r, `duplicate of selling ${sibs.map((x) => x.key).join(",")}`); continue; }
    const el = leanEligibility(r, today);
    if (!el.eligible) { reject(r, el.why); continue; }
    const origCost = Number(ex?.originalCostPrice ?? state.active?.[r.key]?.originalCostPrice ?? r.cargo.costPrice ?? 0);
    cands.push({ r, el, ex, risk: origCost * el.leftover });
  }
  // Existing entries whose lane vanished from analysis (not named / status≠0) are left to expiry-discount.
  const byLoc = new Map();
  for (const c of cands) {
    const loc = locationOfRtu(c.r.rtu);
    if (!byLoc.has(loc)) byLoc.set(loc, []);
    byLoc.get(loc).push(c);
  }
  let added = 0, kept = 0, ended = 0;
  for (const [loc, list] of byLoc) {
    // Running (eligible) deals keep their slot; then highest waste risk (€ expected unsold), then soonest bb.
    list.sort((a, b) => (a.ex ? 0 : 1) - (b.ex ? 0 : 1) || b.risk - a.risk || a.el.dLeft - b.el.dLeft);
    list.forEach((c, i) => {
      const { r, el, ex } = c;
      if (i >= POLICY.MAX_PER_LOCATION) {
        if (ex) { ex.endRequested = `over cap (${loc} #${i + 1})`; console.log(`  END ${r.key} ${r.name}: over cap #${i + 1}`); ended++; }
        else console.log(`  skip ${r.key} ${r.name}: eligible (${el.why}) but over cap #${i + 1}`);
        return;
      }
      if (ex) { delete ex.endRequested; console.log(`  KEEP ${r.key} ${r.name} −${ex.percent}% (${el.kind}: ${el.why}) until ${ex.endsAt}`); kept++; return; }
      const active = state.active?.[r.key];
      const entry = makeClearanceEntry(r.rtu, r.cargo, {
        pct: el.pct, reason: el.kind,
        originalPrice: active?.originalPrice, originalCostPrice: active?.originalCostPrice,
      });
      if (entry.floorBlocked) { console.log(`  skip ${r.key} ${r.name}: cost floor ${entry.costFloor} >= normal ${entry.originalPrice}`); return; }
      if (!entry.costKnown) console.log(`  WARN ${r.key} ${r.name}: cost unknown — no floor`);
      state.clearance[r.key] = entry;
      console.log(`  ADD ${r.key} ${r.name} −${el.pct}% ${el.kind} (${el.why}) → ${entry.clearancePrice}€ until ${entry.endsAt}`);
      added++;
    });
  }
  ended = Object.values(state.clearance).filter((e) => e.endRequested).length;
  return { added, kept, ended, skipped };
}

async function main() {
  if (!SEED && !REEVAL) {
    console.error("Specify --seed and/or --reeval");
    process.exit(2);
  }
  const username = process.env.IMPRESSIOT_USERNAME;
  const password = process.env.IMPRESSIOT_PASSWORD;
  if (!username || !password) {
    console.error("Missing IMPRESSIOT credentials");
    process.exit(1);
  }
  const token = await login(username, password);
  const today = berlinToday();
  const state = loadState();
  state.clearance ||= {};

  const cargoByRtu = new Map();
  for (const m of MACHINES) {
    cargoByRtu.set(m.rtuNumber, await fetchReplenish(token, m.rtuNumber));
  }

  if (SEED && !args.has("--legacy")) {
    console.error("--seed re-adds the old Phase-2 list and is superseded by the lean policy; add --legacy to force.");
    process.exit(2);
  }
  if (SEED) {
    const seeded = seedClearance(state, cargoByRtu, { today });
    console.log(`Seeded ${seeded.length} clearance entries`);
    for (const e of seeded) {
      console.log(`  ${e.rtuNumber}:${e.lane} ${e.name} ${e.originalPrice}→${e.clearancePrice} (−${e.percent}% ${e.reason}) until ${e.endsAt}${e.hideFromAd ? " [no-ad]" : ""}`);
    }
  }

  if (REEVAL) {
    console.log("Pulling orders + replenish history for weekly re-eval…");
    const orders = await pullOrders(token);
    const hist = await pullReplenishHistory(token);
    const rows = analyzeLanes(orders, hist, cargoByRtu);
    console.log(`Analyzed ${rows.length} named lanes`);
    const { added, kept, ended, skipped } = reevalClearance(state, rows, { today });
    console.log(`Re-eval: added=${added} kept=${kept} endRequested=${ended} skipped=${skipped} total clearance=${Object.keys(state.clearance).length}`);
  }

  if (DRY) { console.log("Dry-run — discounts.json not written."); return; }
  state.lastClearanceEvalAt = new Date().toISOString();
  state.lastClearanceEvalDay = today;
  saveState(state);
  console.log(`Wrote ${STATE_PATH}`);

  if (APPLY) {
    console.log("Running expiry-discount --apply (prices + ads under shared lock)…");
    const r = spawnSync(process.execPath, [join(ROOT, "scripts", "expiry-discount.mjs"), "--apply"], {
      stdio: "inherit", env: process.env, cwd: ROOT,
    });
    process.exit(r.status ?? 1);
  }
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
