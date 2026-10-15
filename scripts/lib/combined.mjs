// Combined 30s ad (Karamalz + Live-Bestand + Deals) as ONE group on all machines.
// Bind set per RTU = night screensavers (final1/final2) + SD24-combined-grp.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MACHINES, api, BASE } from "./impressiot.mjs";

export const NIGHT_GROUPS = ["100000785", "100000786"]; // final1, final2 — never touch
export const LOCATIONS = {
  steinsberg: { groupName: "SD24-combined-steinsberg", rtus: ["7680800", "7680783"] },
  schiesheim: { groupName: "SD24-combined-schiesheim", rtus: ["7680787", "7680782"] },
};

function ok(r, what) {
  if (r.http !== 200 || r.json.code !== 200) throw new Error(`${what} failed: HTTP ${r.http} ${r.json.msg || ""}`);
  return r.json;
}

export function discountsHash(state, rtus) {
  const items = Object.values(state.active || {})
    .filter((a) => !rtus || rtus.includes(String(a.rtuNumber)))
    .map((a) => [a.rtuNumber, a.lane, a.name, a.originalPrice, a.discountPrice, a.percent, a.effDate].join("|"))
    .sort();
  return createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
}

export function renderCombined(root, outDir, loc = "all", rtus = []) {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, `sd24-combined-${loc}.mp4`);
  execFileSync("python3", [
    join(root, "scripts", "make-combined-ad.py"),
    "--karamalz", join(root, "assets", "ads", "karamalz.jpg"),
    "--qr", join(root, "assets", "ads", "qr.png"),
    "--stock", join(root, "data", "stock.json"),
    "--discounts", join(root, "data", "discounts.json"),
    "--out", out,
    "--preview", join(outDir, `sd24-combined-${loc}-preview.png`),
    "--rtus", rtus.join(",") || "all",
  ], { stdio: "inherit" });
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

async function uploadVideo(token, file, name) {
  const form = new FormData();
  form.append("file", new Blob([readFileSync(file)], { type: "video/mp4" }), `${name}.mp4`);
  const j = ok(await api(token, "POST", "/file/upload", { formData: form }), "upload");
  const url = typeof j.data === "string" ? j.data : j.data?.url || j.data?.path;
  if (!url) throw new Error("upload returned no url");
  return url.startsWith("http") ? url : BASE + (url.startsWith("/") ? "" : "/") + url;
}

async function findByName(token, path, name) {
  const j = ok(await api(token, "POST", path, { body: { page: 1, pageSize: 50, name } }), path);
  return (j.data?.list || []).filter((x) => x.name === name).sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
}

/**
 * Per location: regenerate (if hash changed/forced), upload new material, point the
 * location group at it, bind each machine of that location to night groups + its
 * location group, verify, push update_ads. Rolls back bindings on failure.
 */
export async function swapCombined(token, state, { root, outDir, today, force = false, dryRun = false }) {
  state.permanentAds ||= {};
  const byLoc = (state.permanentAds.combinedByLocation ||= {});
  // migrate legacy single group: reuse its group id for Steinsberg
  const legacy = state.permanentAds.combined;
  if (legacy && !byLoc.steinsberg) byLoc.steinsberg = { advertiseGroupItemId: legacy.advertiseGroupItemId, legacy: true };
  const all = { changed: false, results: [] };
  const rollbacks = [];
  const pending = [];
  try {
    for (const [loc, cfg] of Object.entries(LOCATIONS)) {
      const cur = byLoc[loc] || {};
      const hash = discountsHash(state, cfg.rtus);
      const needVideo = force || !cur.advertiseId || cur.hash !== hash;
      console.log(`combined[${loc}]: hash=${hash} prev=${cur.hash || "-"} regenerate=${needVideo}`);
      if (dryRun) continue;
      let { advertiseId, adName, url } = cur;
      if (needVideo) {
        const file = renderCombined(root, outDir, loc, cfg.rtus);
        adName = `SD24-combined-${loc}-${today}-${hash.slice(0, 6)}`;
        url = await uploadVideo(token, file, adName);
        ok(await api(token, "POST", "/advertise/save", {
          body: { name: adName, url, mediaType: "video", remark: `SmartDorf24 combined 30s ${loc}`, minutes: 0 } }), "advertise/save");
        const adv = await findByName(token, "/advertise/page", adName);
        if (!adv?.id) throw new Error("could not resolve new advertise id");
        advertiseId = String(adv.id);
      }
      const groupBody = { name: cfg.groupName, advertiseIds: [String(advertiseId)], beginTime: "00:00:00",
        endTime: "23:59:59", mediaType: "video", isScreenProtection: "0" };
      let groupId = cur.advertiseGroupItemId || (await findByName(token, "/advertiseGroupItem/page", cfg.groupName))?.id;
      if (!groupId) {
        ok(await api(token, "POST", "/advertiseGroupItem/save", { body: groupBody }), "group/save");
        groupId = (await findByName(token, "/advertiseGroupItem/page", cfg.groupName))?.id;
        if (!groupId) throw new Error(`could not resolve group id for ${loc}`);
      } else if (needVideo || cur.legacy) {
        ok(await api(token, "POST", "/advertiseGroupItem/update", { body: { id: String(groupId), ...groupBody } }), "group/update");
      }
      groupId = String(groupId);
      const want = [...NIGHT_GROUPS, groupId];
      const locResults = [];
      for (const rtu of cfg.rtus) {
        const m = MACHINES.find((x) => String(x.rtuNumber) === rtu);
        const before = await listBound(token, rtu);
        const same = before.length === want.length && want.every((id) => before.includes(id));
        if (!same) { rollbacks.push({ rtu, before }); await bind(token, rtu, want); }
        const after = await listBound(token, rtu);
        if (after.length !== want.length || !want.every((id) => after.includes(id)))
          throw new Error(`verify failed on ${rtu}: got [${after}] want [${want}]`);
        locResults.push({ loc, rtu, sn: m.serial, before, after, rebound: !same });
      }
      pending.push({ loc, needVideo, locResults, entry: { advertiseId: String(advertiseId), advertiseGroupItemId: groupId, adName,
        groupName: cfg.groupName, url, hash, nightGroups: NIGHT_GROUPS, boundRtus: cfg.rtus,
        previousAdvertiseId: needVideo && cur.advertiseId !== advertiseId ? cur.advertiseId || null : cur.previousAdvertiseId || null,
        updatedAt: new Date().toISOString() } });
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
      if (p.needVideo || r.rebound) r.updateAds = await pushUpdateAds(token, r.sn);
      all.results.push(r);
    }
    byLoc[p.loc] = p.entry;
    all.changed ||= p.needVideo;
  }
  if (pending.length === Object.keys(LOCATIONS).length) delete state.permanentAds.combined;
  return all;
}
