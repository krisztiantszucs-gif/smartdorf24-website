// Per-location combined ads.
// In the ImpressIoT panel, "广告策略" (Advertising Strategy) under /market-strategy
// IS the program-group↔device bind list (POST /advertiseGroupItemBindRtu/page).
// There is no separate strategy/playlist entity — binding groups to RTUs is the strategy.
// Bind set per RTU = final1/final2 (night schedules) + location combined group.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MACHINES, api, BASE, fetchReplenish, berlinToday } from "./impressiot.mjs";

export const NIGHT_GROUPS = ["100000785", "100000786"]; // final1, final2 — never touch
export const LOCATIONS = {
  steinsberg: {
    groupName: "SD24-combined-steinsberg",
    rtus: ["7680800", "7680783"],
    segments: ["karamalz", "live", "deals", "sale"],
    karamalzPrice: { old: 1.0, new: 0.8, label: "Abverkauf" },
  },
  schiesheim: {
    groupName: "SD24-combined-schiesheim",
    rtus: ["7680787", "7680782"],
    segments: ["live", "deals", "sale"],
  },
};

function ok(r, what) {
  if (r.http !== 200 || r.json.code !== 200) throw new Error(`${what} failed: HTTP ${r.http} ${r.json.msg || ""}`);
  return r.json;
}

/** Active discounts for rtus whose live machine price still equals discountPrice. */
export async function verifiedDeals(token, state, rtus, today = berlinToday()) {
  const priceByLane = new Map();
  for (const rtu of rtus) {
    const row = await fetchReplenish(token, rtu);
    for (const c of row.cargos || []) {
      if (!c.commodityName) continue;
      priceByLane.set(`${rtu}:${c.cargoNumber}`, Number(c.price));
    }
  }
  const deals = [];
  const dropped = [];
  for (const a of Object.values(state.active || {})) {
    if (!rtus.includes(String(a.rtuNumber))) continue;
    const eff = a.effDate ? String(a.effDate).slice(0, 10) : "";
    if (!eff || eff < today) {
      dropped.push({ key: `${a.rtuNumber}:${a.lane}`, reason: "effDate-past", name: a.name });
      continue;
    }
    const key = `${a.rtuNumber}:${a.lane}`;
    const live = priceByLane.get(key);
    const want = Number(a.discountPrice);
    if (live == null || Number(live) !== want) {
      dropped.push({ key, reason: `live=${live} want=${want}`, name: a.name });
      continue;
    }
    deals.push({
      rtuNumber: String(a.rtuNumber),
      lane: String(a.lane),
      name: a.name,
      old: Number(a.originalPrice),
      new: want,
      pct: Number(a.percent || 50),
      until: eff,
    });
  }
  deals.sort((x, y) => y.pct - x.pct || x.until.localeCompare(y.until) || x.name.localeCompare(y.name));
  if (dropped.length) console.log(`deals dropped (stale/mismatch): ${dropped.map((d) => `${d.name}(${d.reason})`).join("; ")}`);
  console.log(`verified deals (${rtus.join(",")}): ${deals.map((d) => `${d.name} −${d.pct}% @${d.new}`).join("; ") || "(none)"}`);
  return deals;
}

/** Clearance items for rtus whose live price equals clearancePrice; hideFromAd excluded. */
export async function verifiedSale(token, state, rtus, today = berlinToday()) {
  const priceByLane = new Map();
  const stockByLane = new Map();
  const imgByLane = new Map();
  for (const rtu of rtus) {
    const row = await fetchReplenish(token, rtu);
    for (const c of row.cargos || []) {
      if (!c.commodityName) continue;
      const key = `${rtu}:${c.cargoNumber}`;
      priceByLane.set(key, Number(c.price));
      stockByLane.set(key, Number(c.stock || 0));
      imgByLane.set(key, c.commodityImg || c.img || c.imageUrl || null);
    }
  }
  const sale = [];
  const dropped = [];
  for (const a of Object.values(state.clearance || {})) {
    if (!rtus.includes(String(a.rtuNumber))) continue;
    if (a.hideFromAd) { dropped.push({ key: `${a.rtuNumber}:${a.lane}`, reason: "hideFromAd", name: a.name }); continue; }
    if (a.endsAt && String(a.endsAt).slice(0, 10) < today) {
      dropped.push({ key: `${a.rtuNumber}:${a.lane}`, reason: "endsAt-past", name: a.name }); continue;
    }
    const key = `${a.rtuNumber}:${a.lane}`;
    if ((stockByLane.get(key) || 0) <= 0) {
      dropped.push({ key, reason: "soldout", name: a.name }); continue;
    }
    const live = priceByLane.get(key);
    const want = Number(a.clearancePrice);
    if (live == null || Number(live) !== want) {
      dropped.push({ key, reason: `live=${live} want=${want}`, name: a.name }); continue;
    }
    // If a bigger expiry discount is the live price, clearancePrice won't match — correctly excluded.
    sale.push({
      rtuNumber: String(a.rtuNumber), lane: String(a.lane), name: a.name,
      old: Number(a.originalPrice), new: want, pct: Number(a.percent || 20),
      until: a.endsAt ? String(a.endsAt).slice(0, 10) : "", image: imgByLane.get(key),
    });
  }
  sale.sort((x, y) => y.pct - x.pct || (y.old - y.new) - (x.old - x.new) || x.name.localeCompare(y.name));
  if (dropped.length) console.log(`sale dropped: ${dropped.map((d) => `${d.name}(${d.reason})`).join("; ")}`);
  console.log(`verified sale (${rtus.join(",")}): ${sale.map((d) => `${d.name} −${d.pct}% @${d.new}`).join("; ") || "(none)"}`);
  return sale;
}

export function dealsHash(deals, segments = [], sale = [], karamalzPrice = null) {
  const items = deals.map((d) => [d.rtuNumber, d.lane, d.name, d.old, d.new, d.pct, d.until].join("|"));
  const saleItems = sale.map((d) => [d.rtuNumber, d.lane, d.name, d.old, d.new, d.pct, d.until].join("|"));
  return createHash("sha256").update(JSON.stringify({ items, saleItems, segments, karamalzPrice })).digest("hex").slice(0, 16);
}

/** @deprecated use dealsHash(verifiedDeals(...)) */
export function discountsHash(state, rtus, segments = []) {
  const items = Object.values(state.active || {})
    .filter((a) => !rtus || rtus.includes(String(a.rtuNumber)))
    .map((a) => [a.rtuNumber, a.lane, a.name, a.originalPrice, a.discountPrice, a.percent, a.effDate].join("|"))
    .sort();
  return createHash("sha256").update(JSON.stringify({ items, segments })).digest("hex").slice(0, 16);
}

export function renderCombined(root, outDir, loc = "all", rtus = [], segments = ["karamalz", "live", "deals"], deals = null, sale = null, karamalzPrice = null) {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `sd24-combined-${loc}.mp4`);
  const dealsPath = join(outDir, `deals-${loc}.json`);
  const salePath = join(outDir, `sale-${loc}.json`);
  // Drop empty deals segment when sale has items (keeps runtime shorter)
  let segs = segments.slice();
  if (sale && sale.length && (!deals || !deals.length)) segs = segs.filter((x) => x !== "deals");
  if (!sale || !sale.length) segs = segs.filter((x) => x !== "sale");
  if (deals) writeFileSync(dealsPath, JSON.stringify({ deals }, null, 2));
  if (sale) writeFileSync(salePath, JSON.stringify({ sale }, null, 2));
  const args = [
    join(root, "scripts", "make-combined-ad.py"),
    "--qr", join(root, "assets", "ads", "qr.png"),
    "--stock", join(root, "data", "stock.json"),
    "--discounts", join(root, "data", "discounts.json"),
    "--out", out,
    "--preview", join(outDir, `sd24-combined-${loc}-preview.png`),
    "--rtus", rtus.join(",") || "all",
    "--segments", segs.join(","),
  ];
  if (deals) args.push("--deals-json", dealsPath);
  if (sale && sale.length) args.push("--sale-json", salePath);
  if (segs.includes("karamalz")) {
    args.push("--karamalz", join(root, "assets", "ads", "karamalz.jpg"));
    if (karamalzPrice) args.push("--karamalz-old", String(karamalzPrice.old), "--karamalz-new", String(karamalzPrice.new), "--karamalz-label", karamalzPrice.label || "Abverkauf");
  }
  execFileSync("python3", args, { stdio: "inherit" });
  return out;
}

export async function listBound(token, rtu) {
  const j = ok(await api(token, "POST", "/advertiseGroupItemBindRtu/page", {
    body: { page: 1, pageSize: 100, rtuNumber: String(rtu) } }), "bind page");
  return [...new Set((j.data?.list || []).filter((x) => String(x.rtuNumber) === String(rtu)).map((x) => String(x.id)))];
}

async function bind(token, rtu, ids) {
  ok(await api(token, "POST", "/advertiseGroupItem/advertiseGroupItemBindRtu", {
    body: { advertiseGroupItemIds: ids.map(String), rtuNumbers: [String(rtu)] } }), `bind ${rtu}`);
}

export async function pushUpdateAds(token, sn) {
  const r = await api(token, "POST", "/mobile/appcmd", {
    body: { instruction: "update_ads", offlineMessage: 1, content: "更新广告", sn } });
  console.log(`update_ads ${sn} HTTP ${r.http} code=${r.json.code} msg=${r.json.msg || ""}`);
  return r.http === 200 && r.json.code === 200;
}

async function uploadVideo(token, file, name, { retries = 3 } = {}) {
  const buf = readFileSync(file);
  console.log(`upload ${name}.mp4 size=${buf.length}`);
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const form = new FormData();
      form.append("file", new Blob([buf], { type: "video/mp4" }), `${name}.mp4`);
      const j = ok(await api(token, "POST", "/file/upload", { formData: form }), "upload");
      const url = typeof j.data === "string" ? j.data : j.data?.url || j.data?.path;
      if (!url) throw new Error("upload returned no url");
      return url.startsWith("http") ? url : BASE + (url.startsWith("/") ? "" : "/") + url;
    } catch (e) {
      lastErr = e;
      console.warn(`upload attempt ${i}/${retries} failed: ${e.message}`);
      if (i < retries) await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw lastErr;
}


async function removeAdvertise(token, id) {
  if (!id) return false;
  const r = await api(token, "POST", "/advertise/remove", { body: { id: String(id) } });
  console.log(`advertise/remove ${id} HTTP ${r.http} code=${r.json.code} msg=${r.json.msg || ""}`);
  return r.http === 200 && r.json.code === 200;
}

async function findByName(token, path, name) {
  const j = ok(await api(token, "POST", path, { body: { page: 1, pageSize: 50, name } }), path);
  return (j.data?.list || []).filter((x) => x.name === name).sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

/**
 * Per location: verify deals vs live prices, regenerate when that set/hash changes,
 * upload, point location group at new material, bind night+location groups, verify,
 * ALWAYS push update_ads (so devices retry sync even when hash was unchanged).
 */
export async function swapCombined(token, state, { root, outDir, today, force = false, dryRun = false, onlyLoc = null } = {}) {
  state.permanentAds ||= {};
  const byLoc = (state.permanentAds.combinedByLocation ||= {});
  const legacy = state.permanentAds.combined;
  if (legacy && !byLoc.steinsberg) byLoc.steinsberg = { advertiseGroupItemId: legacy.advertiseGroupItemId, legacy: true };
  const all = { changed: false, results: [] };
  const rollbacks = [];
  const pending = [];
  try {
    for (const [loc, cfg] of Object.entries(LOCATIONS)) {
      if (onlyLoc && loc !== onlyLoc) continue;
      const cur = byLoc[loc] || {};
      const segments = cfg.segments || ["karamalz", "live", "deals", "sale"];
      const deals = await verifiedDeals(token, state, cfg.rtus, today);
      const sale = await verifiedSale(token, state, cfg.rtus, today);
      const karamalzPrice = cfg.karamalzPrice || null;
      const hash = dealsHash(deals, segments, sale, karamalzPrice);
      const needVideo = force || !cur.advertiseId || cur.hash !== hash;
      console.log(`combined[${loc}]: hash=${hash} prev=${cur.hash || "-"} regenerate=${needVideo} deals=${deals.length} sale=${sale.length}`);
      if (dryRun) continue;
      let { advertiseId, adName, url } = cur;
      if (needVideo) {
        const file = renderCombined(root, outDir, loc, cfg.rtus, segments, deals, sale, karamalzPrice);
        adName = `SD24-combined-${loc}-${today}-${hash.slice(0, 6)}`;
        url = await uploadVideo(token, file, adName);
        ok(await api(token, "POST", "/advertise/save", {
          body: { name: adName, url, mediaType: "video", remark: `SmartDorf24 combined ${loc}`, minutes: 0 } }), "advertise/save");
        const adv = await findByName(token, "/advertise/page", adName);
        if (!adv?.id) throw new Error("could not resolve new advertise id");
        advertiseId = String(adv.id);
      }
      const groupBody = {
        name: cfg.groupName, advertiseIds: [String(advertiseId)], beginTime: "00:00:00",
        endTime: "23:59:59", mediaType: "video", isScreenProtection: "0",
      };
      let groupId = cur.advertiseGroupItemId || (await findByName(token, "/advertiseGroupItem/page", cfg.groupName))?.id;
      if (!groupId) {
        ok(await api(token, "POST", "/advertiseGroupItem/save", { body: groupBody }), "group/save");
        groupId = (await findByName(token, "/advertiseGroupItem/page", cfg.groupName))?.id;
        if (!groupId) throw new Error(`could not resolve group id for ${loc}`);
      } else {
        ok(await api(token, "POST", "/advertiseGroupItem/update", { body: { id: String(groupId), ...groupBody } }), "group/update");
      }
      groupId = String(groupId);
      const want = [...NIGHT_GROUPS, groupId];
      const locResults = [];
      for (const rtu of cfg.rtus) {
        const m = MACHINES.find((x) => String(x.rtuNumber) === rtu);
        const before = await listBound(token, rtu);
        const same = before.length === want.length && want.every((id) => before.includes(id));
        // Always re-bind (bind replaces) so the panel's 广告策略 list refreshes
        // denormalized group names after a rename/material swap.
        rollbacks.push({ rtu, before });
        await bind(token, rtu, want);
        const after = await listBound(token, rtu);
        if (after.length !== want.length || !want.every((id) => after.includes(id)))
          throw new Error(`verify failed on ${rtu}: got [${after}] want [${want}]`);
        locResults.push({ loc, rtu, sn: m.serial, before, after, rebound: !same });
      }
      pending.push({
        loc, needVideo, locResults, deals,
        entry: {
          advertiseId: String(advertiseId), advertiseGroupItemId: groupId, adName,
          groupName: cfg.groupName, url, hash, segments, verifiedDeals: deals, verifiedSale: sale,
          karamalzPrice,
          nightGroups: NIGHT_GROUPS, boundRtus: cfg.rtus,
          previousAdvertiseId: needVideo && cur.advertiseId !== advertiseId ? cur.advertiseId || null : cur.previousAdvertiseId || null,
          updatedAt: new Date().toISOString(),
        },
      });
    }
  } catch (e) {
    console.error(`combined swap failed: ${e.message} — rolling back bindings`);
    for (const r of rollbacks.reverse()) {
      try { await bind(token, r.rtu, r.before); console.error(`restored ${r.rtu} -> [${r.before}]`); }
      catch (e2) { console.error(`ROLLBACK FAILED ${r.rtu}: ${e2.message}`); }
    }
    throw e;
  }
  for (const p of pending) {
    for (const r of p.locResults) {
      // Always push update_ads so a missed device sync is retried on every job run.
      r.updateAds = await pushUpdateAds(token, r.sn);
      all.results.push(r);
    }
    const prevId = p.entry.previousAdvertiseId;
    byLoc[p.loc] = p.entry;
    all.changed ||= p.needVideo;
    // After a successful swap, delete the previous SD24-combined material (panel remove wants {id}).
    if (p.needVideo && prevId && prevId !== p.entry.advertiseId) {
      const removed = await removeAdvertise(token, prevId);
      if (removed) byLoc[p.loc].previousAdvertiseId = null;
    }
  }
  if (!onlyLoc && pending.length === Object.keys(LOCATIONS).length) delete state.permanentAds.combined;
  return all;
}
