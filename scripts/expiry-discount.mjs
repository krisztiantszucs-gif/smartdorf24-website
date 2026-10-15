#!/usr/bin/env node
/**
 * Automatic near-expiry discounts + optional screen ads.
 *
 * Usage:
 *   node scripts/expiry-discount.mjs --dry-run
 *   node scripts/expiry-discount.mjs --noop-test
 *   node scripts/expiry-discount.mjs --apply
 *   node scripts/expiry-discount.mjs --apply --skip-ads
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MACHINES,
  login,
  api,
  fetchReplenish,
  berlinToday,
  discountWindow,
  halfPrice,
  laneKey,
  BASE,
} from "./lib/impressiot.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(ROOT, "data", "discounts.json");
const AD_WIDTH = 1792;
const AD_HEIGHT = 1008;

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const NOOP = args.has("--noop-test");
const APPLY = args.has("--apply");
const SKIP_ADS = args.has("--skip-ads");
const FORCE = args.has("--force"); // ignore lastRunDay guard

function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { version: 1, lastRunAt: null, lastRunDay: null, active: {}, machineAds: {} };
  }
  return JSON.parse(readFileSync(STATE_PATH, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
}

function money(n) {
  return (Math.round(Number(n) * 100) / 100).toFixed(2);
}

function priceMap(cargos) {
  const m = new Map();
  for (const c of cargos || []) {
    m.set(String(c.cargoNumber), Number(c.price));
  }
  return m;
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

async function postCargoList(token, rtuNumber, cargos) {
  const { http, json } = await api(token, "POST", "/rtu/updatecargolist", {
    body: { rtuNumber: String(rtuNumber), cargos },
  });
  console.log(`updatecargolist ${rtuNumber} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200) {
    throw new Error(`updatecargolist failed: HTTP ${http} code=${json.code} msg=${json.msg}`);
  }
  return json;
}

function verifyPrices(beforeCargos, afterCargos, expectedPriceByLane) {
  const before = new Map(beforeCargos.map((c) => [String(c.cargoNumber), c]));
  const after = new Map(afterCargos.map((c) => [String(c.cargoNumber), c]));
  const problems = [];
  if (before.size !== after.size) {
    problems.push(`cargo count changed ${before.size} -> ${after.size}`);
  }
  for (const [lane, b] of before) {
    const a = after.get(lane);
    if (!a) {
      problems.push(`lane ${lane} missing after write`);
      continue;
    }
    const expected =
      expectedPriceByLane.has(lane) ? expectedPriceByLane.get(lane) : Number(b.price);
    if (Number(a.price) !== Number(expected)) {
      problems.push(`lane ${lane} price ${a.price} != expected ${expected}`);
    }
    // Non-price critical fields must match
    for (const k of ["commodityId", "commodityName", "stock", "capacity", "level", "effDate"]) {
      if (String(b[k] ?? "") !== String(a[k] ?? "")) {
        problems.push(`lane ${lane} field ${k} changed: ${b[k]} -> ${a[k]}`);
      }
    }
  }
  return problems;
}

async function listBindings(token, rtuNumber) {
  const { http, json } = await api(token, "POST", "/advertiseGroupItemBindRtu/page", {
    body: { page: 1, pageSize: 200, rtuNumber: String(rtuNumber) },
  });
  if (http !== 200 || json.code !== 200) {
    throw new Error(`bind page failed: ${json.msg}`);
  }
  return (json.data?.list || []).filter((x) => String(x.rtuNumber) === String(rtuNumber));
}

async function bindGroups(token, rtuNumber, groupIds) {
  const { http, json } = await api(token, "POST", "/advertiseGroupItem/advertiseGroupItemBindRtu", {
    body: {
      advertiseGroupItemIds: groupIds.map(String),
      rtuNumbers: [String(rtuNumber)],
    },
  });
  console.log(`bind rtu=${rtuNumber} groups=${groupIds.length} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200) {
    throw new Error(`bind failed: ${json.msg}`);
  }
}

async function unbindGroup(token, groupId, rtuNumber) {
  const { http, json } = await api(token, "POST", "/advertiseGroupItem/advertiseGroupItemUnBindRtu", {
    body: { id: String(groupId), rtuNumber: String(rtuNumber) },
  });
  console.log(`unbind group=${groupId} rtu=${rtuNumber} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200) {
    throw new Error(`unbind failed: ${json.msg}`);
  }
}

async function uploadPng(token, buffer, filename) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "image/png" }), filename);
  const { http, json } = await api(token, "POST", "/file/upload", { formData: form });
  console.log(`upload ${filename} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200 || !json.data) {
    throw new Error(`upload failed: ${json.msg || http}`);
  }
  // data is URL string
  const url = typeof json.data === "string" ? json.data : json.data.url || json.data.path;
  if (!url) throw new Error("upload returned no url");
  return url.startsWith("http") ? url : BASE + (url.startsWith("/") ? url : "/" + url);
}

async function saveAdvertise(token, { name, url, mediaType = "img", remark = "", minutes = 10 }) {
  const { http, json } = await api(token, "POST", "/advertise/save", {
    body: { name, url, mediaType, remark, minutes: mediaType === "img" ? minutes : 0 },
  });
  console.log(`advertise/save ${name} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200) throw new Error(`advertise/save failed: ${json.msg}`);
  // id may be in data
  const id = json.data?.id || json.data?.list?.[0]?.id || json.data;
  return { id: id != null ? String(id) : null, raw: json.data };
}

async function findAdvertiseByName(token, name) {
  const { json } = await api(token, "POST", "/advertise/page", {
    body: { page: 1, pageSize: 50, name },
  });
  const list = json.data?.list || [];
  return list.find((x) => x.name === name) || null;
}

async function saveGroup(token, { name, advertiseIds, mediaType = "img" }) {
  const body = {
    name,
    advertiseIds: advertiseIds.map(String),
    beginTime: "00:00:00",
    endTime: "23:59:59",
    mediaType,
    isScreenProtection: "0",
  };
  const { http, json } = await api(token, "POST", "/advertiseGroupItem/save", { body });
  console.log(`group/save ${name} HTTP ${http} code=${json.code} msg=${json.msg || ""}`);
  if (http !== 200 || json.code !== 200) throw new Error(`group/save failed: ${json.msg}`);
  const id = json.data?.id || json.data;
  return { id: id != null ? String(id) : null, raw: json.data };
}

async function findGroupByName(token, name) {
  const { json } = await api(token, "POST", "/advertiseGroupItem/page", {
    body: { page: 1, pageSize: 50, name },
  });
  const list = json.data?.list || [];
  return list.find((x) => x.name === name) || null;
}

async function removeAdvertise(token, id) {
  const { http, json } = await api(token, "POST", "/advertise/remove", {
    body: { ids: [String(id)] },
  });
  console.log(`advertise/remove ${id} HTTP ${http} code=${json.code}`);
}

async function removeGroup(token, id) {
  const { http, json } = await api(token, "POST", "/advertiseGroupItem/remove", {
    body: { ids: [String(id)] },
  });
  console.log(`group/remove ${id} HTTP ${http} code=${json.code}`);
}

async function generateDiscountAdPng({ machineName, products, today }) {
  const sharp = (await import("sharp")).default;
  const lines = products.slice(0, 8).map((p) => {
    const until = String(p.effDate).slice(0, 10);
    return `−50%  ${p.name}  ·  bis ${until}  ·  statt ${money(p.originalPrice)}€ → ${money(p.discountPrice)}€`;
  });
  const extra = products.length > 8 ? `\n(+${products.length - 8} weitere)` : "";
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${AD_WIDTH}" height="${AD_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#0b1220"/>
      <stop offset="100%" stop-color="#16352f"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#g)"/>
  <rect x="48" y="48" width="${AD_WIDTH - 96}" height="${AD_HEIGHT - 96}" rx="32" fill="rgba(255,255,255,0.06)" stroke="#3dd6c6" stroke-width="3"/>
  <text x="96" y="160" font-family="DejaVu Sans, Arial, sans-serif" font-size="72" font-weight="700" fill="#3dd6c6">−50% Abverkauf</text>
  <text x="96" y="240" font-family="DejaVu Sans, Arial, sans-serif" font-size="40" fill="#e8eefc">${escapeXml(machineName)} · MHD bald erreicht</text>
  <text x="96" y="310" font-family="DejaVu Sans, Arial, sans-serif" font-size="28" fill="#9db0d0">Nur noch heute / morgen / übermorgen · smartdorf24.de</text>
  ${lines
    .map(
      (ln, i) =>
        `<text x="96" y="${390 + i * 56}" font-family="DejaVu Sans, Arial, sans-serif" font-size="32" fill="#eef3ff">${escapeXml(ln)}</text>`
    )
    .join("\n")}
  <text x="96" y="${AD_HEIGHT - 80}" font-family="DejaVu Sans, Arial, sans-serif" font-size="26" fill="#6ea8ff">Stand ${today}${escapeXml(extra)}</text>
</svg>`;
  const buf = await sharp(Buffer.from(svg)).png().toBuffer();
  if (buf.length > 2 * 1024 * 1024) throw new Error("ad png > 2MB");
  return buf;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function permanentGroupIds(state) {
  const ids = [];
  const live = state?.permanentAds?.liveStock?.advertiseGroupItemId;
  if (live) ids.push(String(live));
  return [...new Set(ids)];
}

async function safeBindAppend(token, rtuNumber, newGroupId, state) {
  const before = await listBindings(token, rtuNumber);
  const beforeIds = [...new Set(before.map((b) => String(b.id)))];
  const mustKeep = permanentGroupIds(state);
  // Confirmed: advertiseGroupItemBindRtu REPLACES the machine's group set.
  // Always re-bind previous + permanent + new, then verify.
  const full = [...new Set([...beforeIds, ...mustKeep, String(newGroupId)])];
  if (beforeIds.includes(String(newGroupId)) && mustKeep.every((id) => beforeIds.includes(id))) {
    console.log(`group ${newGroupId} already bound to ${rtuNumber} (permanents present)`);
    return { mode: "already", beforeIds };
  }
  await bindGroups(token, rtuNumber, full);
  const after = await listBindings(token, rtuNumber);
  const afterIds = after.map((b) => String(b.id));
  const missing = beforeIds.filter((id) => !afterIds.includes(id));
  const missingPerm = mustKeep.filter((id) => !afterIds.includes(id));
  if (missing.length || missingPerm.length || !afterIds.includes(String(newGroupId))) {
    console.error("Full-set bind verification failed — restoring originals");
    if (beforeIds.length) await bindGroups(token, rtuNumber, beforeIds);
    throw new Error(
      `Could not safely append ad on ${rtuNumber}. missing=${missing.join(",")} missingPerm=${missingPerm.join(",")} hasNew=${afterIds.includes(String(newGroupId))}`
    );
  }
  console.log(
    `Bound ${full.length} groups on ${rtuNumber} (prev ${beforeIds.length} + permanent ${mustKeep.length} + expiry)`
  );
  return { mode: "replaced-full-set", beforeIds };
}

async function noopTest(token) {
  const online = [];
  for (const m of MACHINES) {
    try {
      const row = await fetchReplenish(token, m.rtuNumber);
      const up = Number(row.state?.upTime || 0);
      const age = Date.now() - up;
      if (up && age >= 0 && age < 6 * 3600 * 1000) online.push({ m, row });
    } catch (e) {
      console.warn(m.rtuNumber, e.message);
    }
  }
  if (!online.length) throw new Error("No online machine for noop test");
  const { m, row } = online[0];
  console.log(`NOOP test on ${m.name.en} (${m.rtuNumber}), cargos=${row.cargos.length}`);
  const before = deepClone(row.cargos);
  const beforePrices = priceMap(before);
  await postCargoList(token, m.rtuNumber, before);
  const afterRow = await fetchReplenish(token, m.rtuNumber);
  const problems = verifyPrices(before, afterRow.cargos, beforePrices);
  if (problems.length) {
    console.error("NOOP verification FAILED", problems);
    // try restore
    await postCargoList(token, m.rtuNumber, before);
    throw new Error("noop verification failed");
  }
  console.log("NOOP OK — payload format verified, no price changes");
  return m.rtuNumber;
}

function planForMachine(rtuNumber, row, state, window) {
  const meta = MACHINES.find((x) => x.rtuNumber === rtuNumber);
  const cargos = row.cargos || [];
  const named = cargos.filter((c) => c.commodityName);
  const toDiscount = [];
  const toRestore = [];
  const stay = [];

  for (const c of named) {
    const lane = String(c.cargoNumber);
    const key = laneKey(rtuNumber, lane);
    const eff = c.effDate ? String(c.effDate).slice(0, 10) : "";
    const active = state.active[key];
    const inWindow = eff && window.includes(eff);

    if (active) {
      if (!inWindow || eff !== active.effDate) {
        toRestore.push({
          key,
          lane,
          name: c.commodityName,
          currentPrice: Number(c.price),
          restorePrice: Number(active.originalPrice),
          effDate: eff,
          active,
        });
      } else {
        // still valid — ensure price is discount price
        const want = Number(active.discountPrice);
        if (Number(c.price) !== want) {
          const originalCost = Number(active.originalCostPrice ?? c.costPrice ?? 0);
          toDiscount.push({
            key,
            lane,
            name: c.commodityName,
            originalPrice: Number(active.originalPrice),
            originalCostPrice: originalCost,
            discountPrice: want,
            discountCostPrice: Math.min(originalCost, want),
            effDate: eff,
            already: true,
            fixPrice: true,
          });
        } else {
          stay.push({ key, lane, name: c.commodityName, effDate: eff });
        }
      }
      continue;
    }

    if (inWindow) {
      const original = Number(c.price);
      const discountPrice = halfPrice(original);
      const originalCost = Number(c.costPrice ?? 0);
      toDiscount.push({
        key,
        lane,
        name: c.commodityName,
        originalPrice: original,
        originalCostPrice: originalCost,
        discountPrice,
        // API requires costPrice <= retail price
        discountCostPrice: Math.min(originalCost, discountPrice),
        effDate: eff,
        already: false,
      });
    }
  }

  // Active state entries whose lane disappeared
  for (const [key, active] of Object.entries(state.active)) {
    if (!key.startsWith(rtuNumber + ":")) continue;
    if (!named.find((c) => String(c.cargoNumber) === String(active.lane))) {
      toRestore.push({
        key,
        lane: String(active.lane),
        name: active.name,
        currentPrice: null,
        restorePrice: Number(active.originalPrice),
        effDate: active.effDate,
        active,
        missing: true,
      });
    }
  }

  return { meta, cargos, toDiscount, toRestore, stay };
}

async function applyPriceChanges(token, rtuNumber, cargos, changes) {
  // changes: [{lane, newPrice, newCostPrice?}]
  if (!changes.length) return { changed: false };
  const before = deepClone(cargos);
  const expected = priceMap(before);
  const next = deepClone(cargos);
  for (const ch of changes) {
    const c = next.find((x) => String(x.cargoNumber) === String(ch.lane));
    if (!c) throw new Error(`lane ${ch.lane} not in cargo list`);
    c.price = ch.newPrice;
    if (ch.newCostPrice != null) c.costPrice = ch.newCostPrice;
    // keep vip/act in range if present
    for (const k of ["vipPrice", "actPrice", "oldPrice"]) {
      if (c[k] != null && Number(c[k]) > Number(ch.newPrice)) {
        /* leave oldPrice as original marker if set; vip/act clamp */
        if (k !== "oldPrice") c[k] = ch.newPrice;
      }
    }
    expected.set(String(ch.lane), Number(ch.newPrice));
  }
  await postCargoList(token, rtuNumber, next);
  const after = await fetchReplenish(token, rtuNumber);
  const problems = verifyPrices(before, after.cargos, expected);
  if (problems.length) {
    console.error("VERIFY FAIL — restoring original list", problems.slice(0, 20));
    await postCargoList(token, rtuNumber, before);
    const again = await fetchReplenish(token, rtuNumber);
    const restoreProblems = verifyPrices(before, again.cargos, priceMap(before));
    throw new Error(
      `verification failed (${problems.length}); restoreProblems=${restoreProblems.length}`
    );
  }
  return { changed: true, cargos: after.cargos };
}

async function ensureMachineAd(token, rtuNumber, machineName, products, today, state) {
  const adName = `SD24-expiry-${rtuNumber}-${today}`;
  const groupName = `SD24-expiry-grp-${rtuNumber}-${today}`;
  const png = await generateDiscountAdPng({ machineName, products, today });
  const url = await uploadPng(token, png, `${adName}.png`);

  let adv = await findAdvertiseByName(token, adName);
  if (!adv) {
    const saved = await saveAdvertise(token, {
      name: adName,
      url,
      mediaType: "img",
      remark: "auto expiry discount — smartdorf24",
    });
    // re-fetch to get id
    adv = await findAdvertiseByName(token, adName);
    if (!adv && saved.id) adv = { id: saved.id, name: adName, url };
  }
  if (!adv?.id) throw new Error("could not resolve advertise id");
  // minutes is only honored on create (update silently ignores it). Recreate if wrong.
  if (adv.mediaType === "img" && Number(adv.minutes) !== 10) {
    const re = await saveAdvertise(token, {
      name: adName + "-v",
      url: adv.url || url,
      mediaType: "img",
      remark: adv.remark || "auto expiry discount — smartdorf24",
      minutes: 10,
    });
    const again = await findAdvertiseByName(token, adName + "-v");
    if (again?.id) adv = again;
    else if (re.id) adv = { id: re.id, name: adName + "-v", url, mediaType: "img", minutes: 10 };
  }

  let group = await findGroupByName(token, groupName);
  if (!group) {
    await saveGroup(token, { name: groupName, advertiseIds: [adv.id], mediaType: "img" });
    group = await findGroupByName(token, groupName);
  }
  if (!group?.id) throw new Error("could not resolve group id");

  await safeBindAppend(token, rtuNumber, group.id, state);
  state.machineAds[rtuNumber] = {
    advertiseId: String(adv.id),
    advertiseGroupItemId: String(group.id),
    adName,
    groupName,
    boundAt: new Date().toISOString(),
    day: today,
  };
  return state.machineAds[rtuNumber];
}

async function removeMachineAd(token, rtuNumber, state) {
  const info = state.machineAds[rtuNumber];
  if (!info) return;
  const expiryGroupId = info.advertiseGroupItemId ? String(info.advertiseGroupItemId) : null;
  const permanentIds = permanentGroupIds(state);
  try {
    if (expiryGroupId) {
      const bound = await listBindings(token, rtuNumber);
      const keep = [
        ...new Set(
          bound
            .map((b) => String(b.id))
            .filter((id) => id !== expiryGroupId)
            .concat(permanentIds)
        ),
      ];
      // Prefer full-set rebind (bind replaces) so live-stock + user ads stay
      if (keep.length) {
        await bindGroups(token, rtuNumber, keep);
        const after = await listBindings(token, rtuNumber);
        const afterIds = after.map((b) => String(b.id));
        const missingPerm = permanentIds.filter((id) => !afterIds.includes(id));
        if (missingPerm.length) {
          throw new Error(`lost permanent ads on ${rtuNumber}: ${missingPerm.join(",")}`);
        }
        if (afterIds.includes(expiryGroupId)) {
          // fallback unbind single
          await unbindGroup(token, expiryGroupId, rtuNumber);
        }
      } else if (bound.some((b) => String(b.id) === expiryGroupId)) {
        await unbindGroup(token, expiryGroupId, rtuNumber);
      }
      try {
        await removeGroup(token, expiryGroupId);
      } catch (e) {
        console.warn("group remove:", e.message);
      }
    }
    if (info.advertiseId) {
      try {
        await removeAdvertise(token, info.advertiseId);
      } catch (e) {
        console.warn("advertise remove:", e.message);
      }
    }
  } finally {
    delete state.machineAds[rtuNumber];
  }
}

async function main() {
  if (!DRY && !NOOP && !APPLY) {
    console.error("Specify --dry-run, --noop-test, or --apply");
    process.exit(2);
  }
  const username = process.env.IMPRESSIOT_USERNAME;
  const password = process.env.IMPRESSIOT_PASSWORD;
  if (!username || !password) {
    console.error("Missing IMPRESSIOT_USERNAME / IMPRESSIOT_PASSWORD");
    process.exit(1);
  }

  const today = berlinToday();
  const window = discountWindow(today);
  console.log(`Berlin today=${today} window=${window.join(",")} mode=${DRY ? "dry-run" : NOOP ? "noop" : "apply"}`);

  const state = loadState();
  if (APPLY && !FORCE && state.lastRunDay === today && !args.has("--rerun")) {
    // Allow apply same day if there are pending changes — only skip if explicitly already completed clean
    console.log(`Note: lastRunDay=${state.lastRunDay} (idempotent re-run allowed)`);
  }

  const token = await login(username, password);

  if (NOOP) {
    await noopTest(token);
    return;
  }

  const plans = [];
  for (const m of MACHINES) {
    const row = await fetchReplenish(token, m.rtuNumber);
    const plan = planForMachine(m.rtuNumber, row, state, window);
    plans.push({ rtuNumber: m.rtuNumber, row, plan });
  }

  // Report dry-run / plan
  let discountCount = 0;
  let restoreCount = 0;
  for (const { rtuNumber, plan } of plans) {
    console.log(`\n== ${plan.meta.name.en} (${rtuNumber})`);
    for (const d of plan.toDiscount) {
      discountCount++;
      console.log(
        `  DISCOUNT lane ${d.lane} ${d.name}: ${money(d.originalPrice)} → ${money(d.discountPrice)} € (eff ${d.effDate})${d.already ? " [fix]" : ""}`
      );
    }
    for (const r of plan.toRestore) {
      restoreCount++;
      console.log(
        `  RESTORE lane ${r.lane} ${r.name}: → ${money(r.restorePrice)} € (eff ${r.effDate || "—"})${r.missing ? " [lane gone]" : ""}`
      );
    }
    for (const s of plan.stay) {
      console.log(`  KEEP lane ${s.lane} ${s.name} (eff ${s.effDate})`);
    }
    if (!plan.toDiscount.length && !plan.toRestore.length && !plan.stay.length) {
      console.log("  (no expiry actions)");
    }
  }
  console.log(`\nSummary: discount=${discountCount} restore=${restoreCount}`);

  if (DRY) {
    console.log("Dry-run only — no writes.");
    return;
  }

  if (!APPLY) return;

  // Apply restores first, then discounts
  for (const { rtuNumber, row, plan } of plans) {
    let cargos = row.cargos;
    const priceChanges = [];

    for (const r of plan.toRestore) {
      if (r.missing) {
        delete state.active[r.key];
        continue;
      }
      priceChanges.push({
        lane: r.lane,
        newPrice: r.restorePrice,
        newCostPrice: r.active?.originalCostPrice,
      });
    }
    for (const d of plan.toDiscount) {
      priceChanges.push({
        lane: d.lane,
        newPrice: d.discountPrice,
        newCostPrice: d.discountCostPrice,
      });
    }

    if (priceChanges.length) {
      console.log(`\nApplying ${priceChanges.length} price change(s) on ${rtuNumber}…`);
      await applyPriceChanges(token, rtuNumber, cargos, priceChanges);
      // refresh cargos
      cargos = (await fetchReplenish(token, rtuNumber)).cargos;
    }

    // Update state for restores/discounts
    for (const r of plan.toRestore) {
      delete state.active[r.key];
    }
    for (const d of plan.toDiscount) {
      state.active[d.key] = {
        rtuNumber: String(rtuNumber),
        lane: String(d.lane),
        name: d.name,
        originalPrice: d.originalPrice,
        originalCostPrice: d.originalCostPrice,
        discountPrice: d.discountPrice,
        discountCostPrice: d.discountCostPrice,
        effDate: d.effDate,
        startedAt: state.active[d.key]?.startedAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }

    // Ads for this machine
    const activeOnMachine = Object.values(state.active).filter(
      (a) => String(a.rtuNumber) === String(rtuNumber)
    );
    if (SKIP_ADS) {
      console.log("Skipping ads (--skip-ads)");
    } else if (activeOnMachine.length === 0) {
      if (state.machineAds[rtuNumber]) {
        console.log(`Removing discount ad from ${rtuNumber}`);
        await removeMachineAd(token, rtuNumber, state);
      }
    } else {
      try {
        console.log(`Upserting discount ad on ${rtuNumber} (${activeOnMachine.length} products)`);
        // Remove previous day ad first if different
        const prev = state.machineAds[rtuNumber];
        if (prev && prev.day !== today) {
          await removeMachineAd(token, rtuNumber, state);
        }
        await ensureMachineAd(
          token,
          rtuNumber,
          plan.meta.name.de,
          activeOnMachine,
          today,
          state
        );
        // stamp ad ids onto active lanes
        const mad = state.machineAds[rtuNumber];
        for (const a of activeOnMachine) {
          const key = laneKey(a.rtuNumber, a.lane);
          if (state.active[key]) {
            state.active[key].advertiseId = mad.advertiseId;
            state.active[key].advertiseGroupItemId = mad.advertiseGroupItemId;
          }
        }
      } catch (e) {
        console.error(`AD ERROR on ${rtuNumber}: ${e.message}`);
        console.error("Prices were applied; ads skipped/failed for this machine.");
        // persist state without failing entire job if prices ok
      }
    }
  }

  state.lastRunAt = new Date().toISOString();
  state.lastRunDay = today;
  saveState(state);
  console.log(`\nWrote ${STATE_PATH}`);
  console.log(
    "Active discounts:",
    Object.values(state.active).map(
      (a) => `${a.rtuNumber}:${a.lane} ${a.name} ${a.originalPrice}->${a.discountPrice}`
    )
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
