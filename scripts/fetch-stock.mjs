#!/usr/bin/env node
/**
 * Fetch live stock from ImpressIoT and write sanitized data/stock.json.
 * Requires env: IMPRESSIOT_USERNAME, IMPRESSIOT_PASSWORD
 *
 * - Missing secrets: exit 0 and keep the existing file (local / first run).
 * - Login failure, or every machine failing: exit non-zero and do NOT write.
 * - A single machine that still fails after retries keeps its last good entry from the
 *   existing stock.json (marked stale:true, original fetchedAt kept) instead of going empty.
 * - Per-request timeouts plus an overall watchdog so the script can never hang.
 * - Only timestamps changed? The file is rewritten at most every HEARTBEAT_MIN minutes.
 *
 * Test hooks (env): FORCE_FAIL_RTU=7680787[,..]  STOCK_OUT=/tmp/stock.json
 */
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = process.env.STOCK_OUT || join(ROOT, "data", "stock.json");
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const SCRIPT_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS || 150000);
const HEARTBEAT_MIN = Number(process.env.HEARTBEAT_MIN || 30);
const STALE_OFFLINE_MS = 6 * 60 * 60 * 1000; // stale longer than 6h -> show offline
const FORCE_FAIL = new Set(String(process.env.FORCE_FAIL_RTU || "").split(",").map((x) => x.trim()).filter(Boolean));

// Overall watchdog: never let a tick hang (exit non-zero, nothing written).
setTimeout(() => {
  console.error(`fetch-stock: overall timeout after ${SCRIPT_TIMEOUT_MS}ms — aborting without writing.`);
  process.exit(3);
}, SCRIPT_TIMEOUT_MS).unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fetch + read JSON body, both under one timeout. Returns { res, json }.
async function fetchJson(url, opts = {}, ms = REQUEST_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json = {};
    try { json = JSON.parse(text); } catch {}
    return { res, json };
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`timeout after ${ms}ms`);
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function withRetry(label, fn, attempts = 3, backoffMs = [2000, 5000]) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn(i);
    } catch (err) {
      lastErr = err;
      console.error(`  ${label} attempt ${i}/${attempts} failed: ${err.message}`);
      if (i < attempts) await sleep(backoffMs[Math.min(i - 1, backoffMs.length - 1)]);
    }
  }
  throw lastErr;
}
const BASE = "https://usa.impressiot.com";

const MACHINES = [
  { rtuNumber: "7680787", locationId: "schiesheim", name: { de: "Schiesheim Rechts", en: "Schiesheim Right" } },
  { rtuNumber: "7680782", locationId: "schiesheim", name: { de: "Schiesheim Links", en: "Schiesheim Left" } },
  { rtuNumber: "7680800", locationId: "steinsberg", name: { de: "Steinsberg Rechts", en: "Steinsberg Right" } },
  { rtuNumber: "7680783", locationId: "steinsberg", name: { de: "Steinsberg Links", en: "Steinsberg Left" } },
];

const LOCATIONS = [
  {
    id: "schiesheim",
    name: { de: "Schiesheim", en: "Schiesheim" },
    address: "Lindenstraße 35, 65623 Schiesheim",
    lat: 50.2757388,
    lng: 8.0527833,
  },
  {
    id: "steinsberg",
    name: { de: "Steinsberg", en: "Steinsberg" },
    address: "Steinsberg, Rheinland-Pfalz",
    lat: 50.3233221,
    lng: 7.9441574,
  },
];

function md5(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

function absImg(url) {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("/")) return BASE + url;
  return BASE + "/" + url;
}

async function login(username, password) {
  const passHex = /^[a-f0-9]{32}$/i.test(password) ? password.toLowerCase() : md5(password);
  const body = {
    username,
    password: passHex,
    id: hashCode("SmartDorf24-StockFetcher/1.0"),
  };
  const { res, json } = await fetchJson(BASE + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  console.log(`login HTTP ${res.status} code=${json.code} msg=${json.msg || ""}`);
  if (!res.ok || json.code !== 200 || !json.data?.token) {
    throw new Error(`Login failed (HTTP ${res.status}): ${json.msg || res.statusText}`);
  }
  // ImpressIoT expects the raw JWT in Authorization — NOT "Bearer <jwt>".
  return String(json.data.token);
}

async function fetchMachine(auth, rtuNumber) {
  if (FORCE_FAIL.has(rtuNumber)) throw new Error("forced failure (FORCE_FAIL_RTU test hook)");
  const url = `${BASE}/rtu/replenishItem?rtuNumber=${encodeURIComponent(rtuNumber)}`;
  const { res, json } = await fetchJson(url, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  console.log(`  ${rtuNumber} HTTP ${res.status} code=${json.code} msg=${json.msg || ""}`);
  if (!res.ok || json.code !== 200) {
    throw new Error(`Stock fetch ${rtuNumber} failed (HTTP ${res.status}): ${json.msg || res.statusText}`);
  }
  return json.data;
}

function cargoName(c) {
  const commodity = c.commodity || {};
  return String(c.commodityName || commodity.name || commodity.brandName || "").trim();
}

const TODAY_BERLIN = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

function sanitizeCargo(c) {
  const commodity = c.commodity || {};
  const name = cargoName(c);
  if (!name) return null;
  return {
    lane: String(c.cargoNumber ?? ""),
    level: Number(c.level ?? 0),
    name,
    image: absImg(c.img || commodity.img || commodity.bigImg || ""),
    price: Number(c.price ?? 0),
    stock: Number(c.stock ?? 0),
    capacity: Number(c.capacity ?? 0),
    // best-before passed (Berlin) and still stocked -> shown as "Abgelaufen / Expired"
    expired: (() => {
      const eff = c.effDate ? String(c.effDate).slice(0, 10) : "";
      return !!eff && eff < TODAY_BERLIN && Number(c.stock ?? 0) > 0;
    })(),
  };
}

function isOnline(row) {
  if (!row) return false;
  const st = row.state;
  // Panel "state" is an object: { status, upTime, ... }. Live machines report a recent upTime.
  if (st && typeof st === "object") {
    if (st.status === true) return true;
    const up = Number(st.upTime);
    if (Number.isFinite(up) && up > 0) {
      const ageMs = Date.now() - up;
      return ageMs >= 0 && ageMs < 6 * 60 * 60 * 1000; // seen in last 6h
    }
    return false;
  }
  if (typeof st === "number" || typeof st === "string" || typeof st === "boolean") {
    return Number(st) === 1 || st === true || st === "1";
  }
  return true;
}

function prevMachines(prevJson) {
  const map = {};
  try {
    const prev = JSON.parse(prevJson);
    for (const loc of prev.locations || []) for (const m of loc.machines || []) map[m.rtuNumber] = m;
  } catch {}
  return map;
}

function buildOutput(machineResults, prevByRtu = {}) {
  const updatedAt = new Date().toISOString();
  const byLoc = Object.fromEntries(LOCATIONS.map((l) => [l.id, { ...l, machines: [] }]));

  for (const meta of MACHINES) {
    const result = machineResults[meta.rtuNumber];
    const prevM = prevByRtu[meta.rtuNumber];
    if (result == null && prevM) {
      // Fetch failed: keep last good data instead of showing the machine empty.
      const ageMs = Date.now() - Date.parse(prevM.fetchedAt || 0);
      const keep = { ...prevM, name: meta.name, stale: true, staleSince: prevM.staleSince || updatedAt };
      if (!(ageMs < STALE_OFFLINE_MS)) keep.online = false;
      byLoc[meta.locationId].machines.push(keep);
      continue;
    }
    const list = result?.list || [];
    const row = Array.isArray(list) ? list[0] : null;
    const cargos = row?.cargos || [];
    const items = cargos
      .map(sanitizeCargo)
      .filter(Boolean)
      .sort((a, b) => a.level - b.level || String(a.lane).localeCompare(String(b.lane), undefined, { numeric: true }));

    byLoc[meta.locationId].machines.push({
      rtuNumber: meta.rtuNumber,
      name: meta.name,
      online: result != null && isOnline(row),
      fetchedAt: updatedAt,
      items,
    });
  }

  return {
    sample: false,
    updatedAt,
    note: "Live data from ImpressIoT (public fields only).",
    locations: LOCATIONS.map((l) => byLoc[l.id]),
  };
}

function countItems(stock) {
  return (stock.locations || []).reduce(
    (n, loc) => n + (loc.machines || []).reduce((m, mac) => m + (mac.items || []).length, 0),
    0
  );
}

// Compare ignoring timestamps (updatedAt / fetchedAt / staleSince).
function sameContent(a, b) {
  try {
    const strip = (k, v) => (k === "updatedAt" || k === "fetchedAt" || k === "staleSince" ? undefined : v);
    return JSON.stringify(JSON.parse(a), strip) === JSON.stringify(JSON.parse(b), strip);
  } catch {
    return a === b;
  }
}

async function main() {
  const username = process.env.IMPRESSIOT_USERNAME;
  const password = process.env.IMPRESSIOT_PASSWORD;

  if (!username || !password) {
    console.warn("IMPRESSIOT_USERNAME / IMPRESSIOT_PASSWORD not set — skipping live fetch, keeping existing stock.json.");
    if (!existsSync(OUT)) {
      console.error("No stock.json present and no secrets; nothing to write.");
      process.exit(1);
    }
    process.exit(0);
  }

  console.log("Logging in to ImpressIoT…");
  const auth = await withRetry("login", () => login(username, password));
  console.log("Logged in. Fetching machines…");

  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  const prevByRtu = prevMachines(prev);

  const results = {};
  let fetchFailures = 0;
  for (const m of MACHINES) {
    try {
      results[m.rtuNumber] = await withRetry(`machine ${m.rtuNumber}`, async () => {
        const data = await fetchMachine(auth, m.rtuNumber);
        const n = (data?.list?.[0]?.cargos || []).filter(cargoName).length;
        const prevN = (prevByRtu[m.rtuNumber]?.items || []).length;
        // A machine that had products suddenly returning none is treated as a bad response.
        if (n === 0 && prevN > 0) throw new Error(`empty response (previously ${prevN} items)`);
        return data;
      });
      const n = (results[m.rtuNumber]?.list?.[0]?.cargos || []).filter(cargoName).length;
      console.log(`  OK ${m.rtuNumber} (${m.name.en}) namedLanes=${n}`);
    } catch (err) {
      fetchFailures += 1;
      console.error(`  FAIL ${m.rtuNumber}: ${err.message}`);
      results[m.rtuNumber] = null;
    }
  }

  if (fetchFailures === MACHINES.length) {
    console.error("Refusing to write stock.json: every machine fetch failed.");
    process.exit(1);
  }

  const out = buildOutput(results, prevByRtu);
  const totalItems = countItems(out);
  console.log(`Total named items: ${totalItems}; fetchFailures=${fetchFailures}`);

  if (totalItems === 0) {
    console.error("Refusing to overwrite stock.json: no items from any machine.");
    process.exit(1);
  }

  const next = JSON.stringify(out, null, 2) + "\n";
  if (prev && sameContent(prev, next)) {
    let prevAgeMin = Infinity;
    try { prevAgeMin = (Date.now() - Date.parse(JSON.parse(prev).updatedAt)) / 60000; } catch {}
    if (prevAgeMin < HEARTBEAT_MIN) {
      console.log(`No stock changes (last write ${prevAgeMin.toFixed(0)} min ago) — not rewriting.`);
      return;
    }
    console.log(`No stock changes; refreshing timestamp (heartbeat, last write ${prevAgeMin.toFixed(0)} min ago).`);
  }
  writeFileSync(OUT, next, "utf8");
  console.log(`Wrote ${OUT}`);
  for (const loc of out.locations) {
    for (const mac of loc.machines) {
      console.log(`  ${mac.name.en}: online=${mac.online} items=${mac.items.length}${mac.stale ? ` STALE (kept from ${mac.fetchedAt})` : ""}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
