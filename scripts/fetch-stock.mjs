#!/usr/bin/env node
/**
 * Fetch live stock from ImpressIoT and write sanitized data/stock.json.
 * Requires env: IMPRESSIOT_USERNAME, IMPRESSIOT_PASSWORD
 *
 * - Missing secrets: exit 0 and keep the existing file (local / first run).
 * - Login failure or zero items across all machines: exit non-zero and do NOT write.
 */
import { createHash } from "node:crypto";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "stock.json");
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
  const res = await fetch(BASE + "/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`login HTTP ${res.status} code=${json.code} msg=${json.msg || ""}`);
  if (!res.ok || json.code !== 200 || !json.data?.token) {
    throw new Error(`Login failed (HTTP ${res.status}): ${json.msg || res.statusText}`);
  }
  // ImpressIoT expects the raw JWT in Authorization — NOT "Bearer <jwt>".
  return String(json.data.token);
}

async function fetchMachine(auth, rtuNumber) {
  const url = `${BASE}/rtu/replenishItem?rtuNumber=${encodeURIComponent(rtuNumber)}`;
  const res = await fetch(url, {
    headers: { Authorization: auth, Accept: "application/json" },
  });
  const json = await res.json().catch(() => ({}));
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

function buildOutput(machineResults) {
  const updatedAt = new Date().toISOString();
  const byLoc = Object.fromEntries(LOCATIONS.map((l) => [l.id, { ...l, machines: [] }]));

  for (const meta of MACHINES) {
    const result = machineResults[meta.rtuNumber];
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

function filesEqual(a, b) {
  try {
    return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b));
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
  const auth = await login(username, password);
  console.log("Logged in. Fetching machines…");

  const results = {};
  let fetchFailures = 0;
  for (const m of MACHINES) {
    try {
      results[m.rtuNumber] = await fetchMachine(auth, m.rtuNumber);
      const n = (results[m.rtuNumber]?.list?.[0]?.cargos || []).filter(cargoName).length;
      console.log(`  OK ${m.rtuNumber} (${m.name.en}) namedLanes=${n}`);
    } catch (err) {
      fetchFailures += 1;
      console.error(`  FAIL ${m.rtuNumber}: ${err.message}`);
      results[m.rtuNumber] = null;
    }
  }

  const out = buildOutput(results);
  const totalItems = countItems(out);
  console.log(`Total named items: ${totalItems}; fetchFailures=${fetchFailures}`);

  if (totalItems === 0) {
    console.error("Refusing to overwrite stock.json: no items from any machine.");
    process.exit(1);
  }

  const next = JSON.stringify(out, null, 2) + "\n";
  const prev = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  if (filesEqual(prev, next)) {
    console.log("No stock changes.");
    return;
  }
  writeFileSync(OUT, next, "utf8");
  console.log(`Wrote ${OUT}`);
  for (const loc of out.locations) {
    for (const mac of loc.machines) {
      console.log(`  ${mac.name.en}: online=${mac.online} items=${mac.items.length}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
