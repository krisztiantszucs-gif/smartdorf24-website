#!/usr/bin/env node
/**
 * Seed or weekly-reevaluate clearance map in data/discounts.json.
 * Does NOT write machine prices — run expiry-discount.mjs --apply afterwards.
 *
 *   node scripts/clearance-eval.mjs --seed          # Phase-2 approved list
 *   node scripts/clearance-eval.mjs --reeval         # weekly NEW/dead/slow scan
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
  shouldHideFromAd, locationOfRtu,
} from "./lib/clearance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(ROOT, "data", "discounts.json");
const args = new Set(process.argv.slice(2));
const SEED = args.has("--seed");
const REEVAL = args.has("--reeval");
const APPLY = args.has("--apply");
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
      const rate = days >= 1 ? units / days : null;
      let klass = "steady";
      if (!start || days < 14) klass = "NEW";
      else if (units === 0 && Number(c.stock) > 0) klass = "dead";
      else if (days >= 28 && rate < 0.05 && u14 === 0 && Number(c.stock) >= 2) klass = "slow";
      rows.push({
        rtu, lane, key, cid, name: String(c.commodityName).trim(),
        stock: Number(c.stock), days, units, u14, rate, klass, cargo: c,
      });
    }
  }
  return rows;
}

function reevalClearance(state, rows, { today = berlinToday() } = {}) {
  state.clearance ||= {};
  // Selling siblings: same loc+cid with u14>0
  const byLocCid = new Map();
  for (const r of rows) {
    const loc = locationOfRtu(r.rtu);
    const k = `${loc}|${r.cid}`;
    if (!byLocCid.has(k)) byLocCid.set(k, []);
    byLocCid.get(k).push(r);
  }
  let added = 0, skipped = 0;
  for (const r of rows) {
    if (r.klass !== "dead" && r.klass !== "slow") continue;
    // Karamalz: always allow (clearance desired)
    const isKaramalz = /karamalz/i.test(r.name);
    const loc = locationOfRtu(r.rtu);
    const sibs = (byLocCid.get(`${loc}|${r.cid}`) || []).filter((x) => x.key !== r.key && x.u14 > 0);
    if (sibs.length && !isKaramalz) {
      console.log(`  skip ${r.key} ${r.name}: duplicate of selling ${sibs.map((s) => s.key).join(",")}`);
      skipped++;
      continue;
    }
    // Don't steal lanes inside expiry window ≤4d — expiry job owns them (unless already clearance)
    const eff = r.cargo.effDate ? String(r.cargo.effDate).slice(0, 10) : "";
    if (eff) {
      const d = Math.round((Date.parse(eff + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / DAY_MS);
      if (d >= 0 && d <= 4 && !state.clearance[r.key]) {
        console.log(`  skip ${r.key} ${r.name}: expiry window d=${d}`);
        skipped++;
        continue;
      }
    }
    if (state.clearance[r.key]) continue; // keep existing end date / originals
    const pct = r.klass === "dead" ? 30 : 20;
    const active = state.active?.[r.key];
    const entry = makeClearanceEntry(r.rtu, r.cargo, {
      pct, reason: r.klass,
      originalPrice: active?.originalPrice,
      originalCostPrice: active?.originalCostPrice,
    });
    state.clearance[r.key] = entry;
    console.log(`  ADD ${r.key} ${r.name} −${pct}% ${r.klass} → ${entry.clearancePrice}€ until ${entry.endsAt}`);
    added++;
  }
  return { added, skipped };
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
    const { added, skipped } = reevalClearance(state, rows, { today });
    console.log(`Re-eval: added=${added} skipped=${skipped} total clearance=${Object.keys(state.clearance).length}`);
  }

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
