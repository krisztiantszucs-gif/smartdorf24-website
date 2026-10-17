#!/usr/bin/env node
// Manual: node scripts/swap-combined.mjs [--force] [--dry-run] [--video path]
import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { login, berlinToday } from "./lib/impressiot.mjs";
import { swapCombined } from "./lib/combined.mjs";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, "data", "discounts.json");
const a = process.argv.slice(2);
const locIx = a.indexOf("--loc");
const onlyLoc = locIx >= 0 ? a[locIx + 1] : null;
const state = JSON.parse(readFileSync(STATE, "utf8"));
const token = await login(process.env.IMPRESSIOT_USERNAME, process.env.IMPRESSIOT_PASSWORD);
const r = await swapCombined(token, state, { root: ROOT, outDir: join(ROOT, ".ads-out"), today: berlinToday(),
  force: a.includes("--force"), dryRun: a.includes("--dry-run"), onlyLoc });
if (!a.includes("--dry-run")) writeFileSync(STATE, JSON.stringify(state, null, 2) + "\n");
console.log(JSON.stringify(r.results || r, null, 1));
