#!/usr/bin/env node
/**
 * Record / revoke Krisztian's approval to discount a protected (group-A) product.
 *
 *   node scripts/approve-discount.mjs --list
 *   node scripts/approve-discount.mjs 7680787:43 [--until 2026-11-12] [--kinds expiry,clearance] [--note "ok per K"]
 *   node scripts/approve-discount.mjs product:redbull --until 2026-11-12
 *   node scripts/approve-discount.mjs 7680787:43 --revoke
 *   add --no-push to only edit data/discounts.json (default: commit + push to origin/main)
 *
 * kinds defaults to "expiry". The next expiry-discount run (morning/evening slot, or a manual
 * `node scripts/expiry-discount.mjs --apply`) then applies the tier. Holds the expiry lock.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PROTECTED_PRODUCTS } from "./lib/clearance.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const STATE_PATH = join(ROOT, "data", "discounts.json");
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const LOCK = process.env.SD24_EXPIRY_LOCK || "/tmp/smartdorf24-expiry.lock";

if (process.env.SD24_EXPIRY_LOCKED !== "1" && !flag("--list")) {
  const self = fileURLToPath(import.meta.url);
  const inner = `SD24_EXPIRY_LOCKED=1 exec ${JSON.stringify(process.execPath)} ${JSON.stringify(self)} ${argv.map((a) => JSON.stringify(a)).join(" ")}`;
  const r = spawnSync("flock", ["-w", "180", LOCK, "-c", inner], { stdio: "inherit", env: process.env });
  process.exit(r.status ?? 1);
}

const git = (...a) => spawnSync("git", ["-c", "user.name=SmartDorf24 Box", "-c", "user.email=box@smartdorf24.local", ...a], { cwd: ROOT, encoding: "utf8" });
const load = () => JSON.parse(readFileSync(STATE_PATH, "utf8"));

if (flag("--list")) {
  const s = load();
  console.log("approvedDiscounts:", JSON.stringify(s.approvedDiscounts || {}, null, 2));
  console.log("pendingApprovals:", JSON.stringify(s.pendingApprovals || [], null, 2));
  process.exit(0);
}

const key = argv.find((a) => /^(\d+:\d+|product:[\w-]+)$/.test(a));
if (!key) { console.error("Give a lane key <rtu>:<lane> or product:<id> (" + PROTECTED_PRODUCTS.map((p) => p.id).join("|") + ")"); process.exit(2); }
if (key.startsWith("product:") && !PROTECTED_PRODUCTS.some((p) => `product:${p.id}` === key)) { console.error("unknown product id"); process.exit(2); }
const until = opt("--until");
if (until && !/^\d{4}-\d{2}-\d{2}$/.test(until)) { console.error("--until must be YYYY-MM-DD"); process.exit(2); }
const kinds = (opt("--kinds") || "expiry").split(",").map((x) => x.trim()).filter(Boolean);
if (kinds.some((k) => !["expiry", "clearance"].includes(k))) { console.error("--kinds: expiry,clearance"); process.exit(2); }

const PUSH = !flag("--no-push");
if (PUSH) { git("fetch", "-q", "origin", "main"); git("pull", "-q", "--ff-only", "origin", "main"); }
const state = load();
state.approvedDiscounts ||= {};
let msg;
if (flag("--revoke")) {
  delete state.approvedDiscounts[key];
  msg = `approval revoked ${key}`;
} else {
  let product;
  if (/^\d+:\d+$/.test(key)) {
    // pin the approval to the product currently in that lane (from stock/pending data if known)
    const p = (state.pendingApprovals || []).find((x) => x.key === key);
    const { protectionFor } = await import("./lib/clearance.mjs");
    product = p ? protectionFor(p.name)?.id : undefined;
  }
  state.approvedDiscounts[key] = {
    kinds, ...(until ? { until } : {}), ...(product ? { product } : {}),
    ...(opt("--note") ? { note: opt("--note") } : {}), approvedAt: new Date().toISOString(),
  };
  msg = `approval ${key} kinds=${kinds.join(",")}${until ? " until " + until : ""}`;
}
writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n", "utf8");
console.log(msg);
if (PUSH) {
  git("add", "data/discounts.json");
  const c = git("commit", "-q", "-m", `chore: discount ${msg}`);
  if (c.status !== 0) { console.error(c.stderr || c.stdout); process.exit(1); }
  for (let i = 0; i < 3; i++) {
    if (git("push", "-q", "origin", "HEAD:main").status === 0) { console.log("pushed", git("rev-parse", "--short", "HEAD").stdout.trim()); process.exit(0); }
    git("pull", "-q", "--rebase", "origin", "main");
  }
  console.error("push failed — commit is local; push manually");
  process.exit(1);
}
