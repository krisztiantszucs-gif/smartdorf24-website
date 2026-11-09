#!/usr/bin/env node
// Weekly night-screensaver windows (Krisztian 2026-11-09):
//   final2 (group 100000786): 30 min after sunset → 23:59:59
//   final1 (group 100000785): 00:00:00 → sunrise
// Run every Monday. Covers the next 7 days: final2 start = earliest sunset of the
// coming 7 days + 30 min, floored to 5 min; final1 end = latest sunrise of the coming
// 7 days, ceiled to the minute. Uses the earlier/later value across both locations,
// because final1/final2 are shared groups bound to all 4 machines.
// ONLY the beginTime/endTime of final1/final2 change: same videos, same flags, same
// bindings (re-bound with the identical set per RTU so the device list refreshes).
// Usage: node scripts/night-screensaver-schedule.mjs [--dry-run|--apply] [--date YYYY-MM-DD]
import { login, api, MACHINES, berlinToday, addDaysYmd } from "./lib/impressiot.mjs";
import { listBound, pushUpdateAds } from "./lib/combined.mjs";

const FINAL1 = "100000785"; // 00:00:00 → sunrise
const FINAL2 = "100000786"; // sunset+30 → 23:59:59
const LOCS = {
  schiesheim: { lat: 50.3614, lon: 8.0569 },  // Schiesheim, Lindenstraße
  steinsberg: { lat: 50.3244, lon: 7.9439 },  // Steinsberg
};
const DAYS = 7, OFFSET_MIN = 30;

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const dIdx = args.indexOf("--date");
const startDay = dIdx >= 0 ? args[dIdx + 1] : berlinToday();

// --- NOAA sunrise/sunset (zenith 90.833°), returns UTC Date ---
const rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;
function sunUtc(ymd, lat, lon, rise) {
  const [y, m, d] = ymd.split("-").map(Number);
  const jd = Date.UTC(y, m - 1, d, 12) / 86400000 + 2440587.5;
  let t = (jd - 2451545) / 36525;
  // iterate twice for accuracy around event time
  let minutes = 720;
  for (let i = 0; i < 3; i++) {
    const jc = (jd - 0.5 + minutes / 1440 - 2451545) / 36525;
    const L0 = (280.46646 + jc * (36000.76983 + jc * 0.0003032)) % 360;
    const M = 357.52911 + jc * (35999.05029 - 0.0001537 * jc);
    const e = 0.016708634 - jc * (0.000042037 + 0.0000001267 * jc);
    const C = Math.sin(rad(M)) * (1.914602 - jc * (0.004817 + 0.000014 * jc)) + Math.sin(rad(2 * M)) * (0.019993 - 0.000101 * jc) + Math.sin(rad(3 * M)) * 0.000289;
    const trueLong = L0 + C;
    const omega = 125.04 - 1934.136 * jc;
    const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));
    const eps0 = 23 + (26 + (21.448 - jc * (46.815 + jc * (0.00059 - jc * 0.001813))) / 60) / 60;
    const eps = eps0 + 0.00256 * Math.cos(rad(omega));
    const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));
    const yv = Math.tan(rad(eps / 2)) ** 2;
    const eqTime = 4 * deg(yv * Math.sin(2 * rad(L0)) - 2 * e * Math.sin(rad(M)) + 4 * e * yv * Math.sin(rad(M)) * Math.cos(2 * rad(L0)) - 0.5 * yv * yv * Math.sin(4 * rad(L0)) - 1.25 * e * e * Math.sin(2 * rad(M)));
    const cosH = Math.cos(rad(90.833)) / (Math.cos(rad(lat)) * Math.cos(rad(decl))) - Math.tan(rad(lat)) * Math.tan(rad(decl));
    const H = deg(Math.acos(cosH));
    minutes = 720 - 4 * (lon + (rise ? H : -H)) - eqTime;
  }
  void t;
  return new Date(Date.UTC(y, m - 1, d) + minutes * 60000);
}
const berlinHM = (dt) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(dt);
const toSec = (hms) => { const [h, m, s] = hms.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
const fmt = (sec) => [Math.floor(sec / 3600), Math.floor((sec % 3600) / 60), sec % 60].map((n) => String(n).padStart(2, "0")).join(":");

export function computeWindows(start = startDay) {
  const rows = [];
  let minSet = Infinity, maxRise = -Infinity;
  for (let i = 0; i < DAYS; i++) {
    const day = addDaysYmd(start, i);
    for (const [loc, { lat, lon }] of Object.entries(LOCS)) {
      const rise = berlinHM(sunUtc(day, lat, lon, true));
      const set = berlinHM(sunUtc(day, lat, lon, false));
      rows.push({ day, loc, sunrise: rise.slice(0, 5), sunset: set.slice(0, 5) });
      minSet = Math.min(minSet, toSec(set));
      maxRise = Math.max(maxRise, toSec(rise));
    }
  }
  const f2 = Math.floor((minSet + OFFSET_MIN * 60) / 300) * 300; // floor to 5 min (never later)
  const f1 = Math.ceil(maxRise / 60) * 60;                       // ceil to minute
  return { rows, earliestSunset: fmt(Math.floor(minSet)), latestSunrise: fmt(Math.ceil(maxRise)),
    final2: { beginTime: fmt(f2), endTime: "23:59:59" }, final1: { beginTime: "00:00:00", endTime: fmt(f1) } };
}

const okj = (r, what) => { if (r.http !== 200 || r.json.code !== 200) throw new Error(`${what}: HTTP ${r.http} code=${r.json.code} ${r.json.msg || ""}`); return r.json; };
async function retry(fn, what, n = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) { if (i >= n) throw e; console.warn(`${what} attempt ${i} failed: ${e.message}; retrying`); await new Promise((r) => setTimeout(r, 2000 * i)); }
  }
}
async function groups(token) {
  const j = okj(await api(token, "POST", "/advertiseGroupItem/page", { body: { page: 1, pageSize: 100 } }), "group page");
  return Object.fromEntries((j.data?.list || []).filter((g) => [FINAL1, FINAL2].includes(String(g.id))).map((g) => [String(g.id), g]));
}

async function main() {
  const w = computeWindows();
  console.log(`period ${startDay} +${DAYS - 1}d`);
  for (const r of w.rows) console.log(`  ${r.day} ${r.loc.padEnd(10)} sunrise ${r.sunrise} sunset ${r.sunset}`);
  console.log(`earliest sunset ${w.earliestSunset} → final2 ${w.final2.beginTime}-${w.final2.endTime}`);
  console.log(`latest sunrise ${w.latestSunrise} → final1 ${w.final1.beginTime}-${w.final1.endTime}`);
  const { IMPRESSIOT_USERNAME: u, IMPRESSIOT_PASSWORD: p } = process.env;
  if (!u || !p) { console.error("Missing IMPRESSIOT_USERNAME / IMPRESSIOT_PASSWORD"); process.exit(2); }
  const token = await retry(() => login(u, p), "login");
  const cur = await retry(() => groups(token), "read groups");
  const want = { [FINAL1]: w.final1, [FINAL2]: w.final2 };
  let changed = false;
  for (const id of [FINAL1, FINAL2]) {
    const g = cur[id];
    if (!g) throw new Error(`group ${id} not found`);
    const same = g.beginTime === want[id].beginTime && g.endTime === want[id].endTime;
    console.log(`${g.name} (${id}): ${g.beginTime}-${g.endTime} → ${want[id].beginTime}-${want[id].endTime}${same ? " (unchanged)" : ""}`);
    if (same || !APPLY) continue;
    const body = { id, name: g.name, advertiseIds: (g.advertiseIds || []).map(String), beginTime: want[id].beginTime,
      endTime: want[id].endTime, mediaType: g.mediaType, isScreenProtection: String(g.isScreenProtection) };
    await retry(async () => okj(await api(token, "POST", "/advertiseGroupItem/update", { body }), `update ${g.name}`), `update ${g.name}`);
    changed = true;
  }
  if (!APPLY) { console.log("dry-run: nothing changed"); return; }
  const after = await retry(() => groups(token), "re-read groups");
  for (const id of [FINAL1, FINAL2]) {
    const g = after[id], o = cur[id];
    const bad = g.beginTime !== want[id].beginTime || g.endTime !== want[id].endTime ||
      JSON.stringify((g.advertiseIds || []).map(String)) !== JSON.stringify((o.advertiseIds || []).map(String)) ||
      String(g.isScreenProtection) !== String(o.isScreenProtection) || g.name !== o.name;
    if (bad) throw new Error(`VERIFY FAILED ${o.name}: ${JSON.stringify(g)}`);
    console.log(`VERIFY ${g.name}: ${g.beginTime}-${g.endTime} video=${g.advertiseIds} screenProtection=${g.isScreenProtection} OK`);
  }
  for (const m of MACHINES) {
    const bound = await retry(() => listBound(token, m.rtuNumber), `bind list ${m.rtuNumber}`);
    if (!bound.includes(FINAL1) || !bound.includes(FINAL2)) { console.warn(`WARN ${m.rtuNumber}: final1/final2 not both bound [${bound}] — left as is`); continue; }
    if (changed) {
      // Re-bind the identical set so the per-device list shows the new times (bind replaces the set).
      await retry(async () => okj(await api(token, "POST", "/advertiseGroupItem/advertiseGroupItemBindRtu", {
        body: { advertiseGroupItemIds: bound, rtuNumbers: [String(m.rtuNumber)] } }), `rebind ${m.rtuNumber}`), `rebind ${m.rtuNumber}`);
    }
    const j = okj(await api(token, "POST", "/advertiseGroupItemBindRtu/page", { body: { page: 1, pageSize: 100, rtuNumber: m.rtuNumber } }), "bind page");
    const rows = (j.data?.list || []).filter((x) => String(x.rtuNumber) === m.rtuNumber);
    const ids = [...new Set(rows.map((x) => String(x.id)))];
    if (ids.length !== bound.length || !bound.every((i) => ids.includes(i))) throw new Error(`VERIFY FAILED bindings ${m.rtuNumber}: [${ids}] vs [${bound}]`);
    const show = rows.filter((x) => [FINAL1, FINAL2].includes(String(x.id))).map((x) => `${x.name} ${x.beginTime}-${x.endTime}`).join(", ");
    console.log(`${m.name.en} ${m.rtuNumber}: bound [${ids}] ${show}`);
    await pushUpdateAds(token, m.serial);
  }
  console.log(changed ? "applied" : "already up to date");
}
main().catch((e) => { console.error(`ERROR ${e.message}`); process.exit(1); });
