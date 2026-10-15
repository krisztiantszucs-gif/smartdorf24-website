// Combined 30s ad (Karamalz + Live-Bestand + Deals) as ONE group on all machines.
// Bind set per RTU = night screensavers (final1/final2) + SD24-combined-grp.
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MACHINES, api, BASE } from "./impressiot.mjs";

export const NIGHT_GROUPS = ["100000785", "100000786"]; // final1, final2 — never touch
export const GROUP_NAME = "SD24-combined-grp";

function ok(r, what) {
  if (r.http !== 200 || r.json.code !== 200) throw new Error(`${what} failed: HTTP ${r.http} ${r.json.msg || ""}`);
  return r.json;
}

export function discountsHash(state) {
  const items = Object.values(state.active || {})
    .map((a) => [a.rtuNumber, a.lane, a.name, a.originalPrice, a.discountPrice, a.effDate].join("|"))
    .sort();
  return createHash("sha256").update(JSON.stringify(items)).digest("hex").slice(0, 16);
}

export function renderCombined(root, outDir) {
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, "sd24-combined.mp4");
  execFileSync("python3", [
    join(root, "scripts", "make-combined-ad.py"),
    "--karamalz", join(root, "assets", "ads", "karamalz.jpg"),
    "--qr", join(root, "assets", "ads", "qr.png"),
    "--stock", join(root, "data", "stock.json"),
    "--discounts", join(root, "data", "discounts.json"),
    "--out", out,
    "--preview", join(outDir, "sd24-combined-preview.png"),
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
 * Regenerate (if hash changed or forced), upload new material, point the single
 * combined group at it, bind every machine to night groups + combined group,
 * verify, push update_ads. Rolls back bindings on verification failure.
 */
export async function swapCombined(token, state, { root, outDir, today, force = false, dryRun = false }) {
  state.permanentAds ||= {};
  const cur = state.permanentAds.combined || {};
  const hash = discountsHash(state);
  const needVideo = force || !cur.advertiseId || cur.hash !== hash;
  console.log(`combined: hash=${hash} prev=${cur.hash || "-"} regenerate=${needVideo}`);
  if (dryRun) return { changed: false, hash };

  let advertiseId = cur.advertiseId, adName = cur.adName, url = cur.url;
  if (needVideo) {
    const file = renderCombined(root, outDir);
    adName = `SD24-combined-${today}-${hash.slice(0, 6)}`;
    url = await uploadVideo(token, file, adName);
    ok(await api(token, "POST", "/advertise/save", {
      body: { name: adName, url, mediaType: "video", remark: "SmartDorf24 combined 30s", minutes: 0 } }), "advertise/save");
    const adv = await findByName(token, "/advertise/page", adName);
    if (!adv?.id) throw new Error("could not resolve new advertise id");
    advertiseId = String(adv.id);
  }

  const groupBody = { name: GROUP_NAME, advertiseIds: [String(advertiseId)], beginTime: "00:00:00",
    endTime: "23:59:59", mediaType: "video", isScreenProtection: "0" };
  let groupId = cur.advertiseGroupItemId || (await findByName(token, "/advertiseGroupItem/page", GROUP_NAME))?.id;
  if (!groupId) {
    ok(await api(token, "POST", "/advertiseGroupItem/save", { body: groupBody }), "group/save");
    groupId = (await findByName(token, "/advertiseGroupItem/page", GROUP_NAME))?.id;
    if (!groupId) throw new Error("could not resolve combined group id");
  } else if (needVideo) {
    ok(await api(token, "POST", "/advertiseGroupItem/update", { body: { id: String(groupId), ...groupBody } }), "group/update");
  }
  groupId = String(groupId);

  const want = [...NIGHT_GROUPS, groupId];
  const results = [];
  const rollbacks = [];
  try {
    for (const m of MACHINES) {
      const before = await listBound(token, m.rtuNumber);
      const same = before.length === want.length && want.every((id) => before.includes(id));
      if (!same) {
        rollbacks.push({ rtu: m.rtuNumber, before });
        await bind(token, m.rtuNumber, want);
      }
      const after = await listBound(token, m.rtuNumber);
      if (after.length !== want.length || !want.every((id) => after.includes(id)))
        throw new Error(`verify failed on ${m.rtuNumber}: got [${after}] want [${want}]`);
      results.push({ rtu: m.rtuNumber, sn: m.serial, before, after });
    }
  } catch (e) {
    console.error(`combined bind failed: ${e.message} — rolling back`);
    for (const r of rollbacks.reverse()) {
      try { await bind(token, r.rtu, r.before); console.error(`restored ${r.rtu} -> [${r.before}]`); }
      catch (e2) { console.error(`ROLLBACK FAILED ${r.rtu}: ${e2.message}`); }
    }
    throw e;
  }
  if (needVideo || rollbacks.length) {
    for (const r of results) r.updateAds = await pushUpdateAds(token, r.sn);
  }
  state.permanentAds.combined = { advertiseId: String(advertiseId), advertiseGroupItemId: groupId, adName,
    groupName: GROUP_NAME, url, hash, nightGroups: NIGHT_GROUPS, boundRtus: MACHINES.map((m) => String(m.rtuNumber)),
    previousAdvertiseId: needVideo && cur.advertiseId !== advertiseId ? cur.advertiseId || null : cur.previousAdvertiseId || null,
    updatedAt: new Date().toISOString() };
  return { changed: needVideo, results };
}
