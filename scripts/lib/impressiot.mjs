import { createHash } from "node:crypto";

export const BASE = "https://usa.impressiot.com";

export const MACHINES = [
  { rtuNumber: "7680787", serial: "SN20251212D7680787usa", locationId: "schiesheim", name: { de: "Schiesheim Rechts", en: "Schiesheim Right" } },
  { rtuNumber: "7680782", serial: "SN20251212D7680782usa", locationId: "schiesheim", name: { de: "Schiesheim Links", en: "Schiesheim Left" } },
  { rtuNumber: "7680800", serial: "SN20251212D7680800usa", locationId: "steinsberg", name: { de: "Steinsberg Rechts", en: "Steinsberg Right" } },
  { rtuNumber: "7680783", serial: "SN20251212D7680783usa", locationId: "steinsberg", name: { de: "Steinsberg Links", en: "Steinsberg Left" } },
];

export function md5(text) {
  return createHash("md5").update(text, "utf8").digest("hex");
}

export function hashCode(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (h << 5) - h + str.charCodeAt(i);
    h |= 0;
  }
  return h;
}

export async function login(username, password) {
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
  return String(json.data.token);
}

export async function api(token, method, path, { body, params, formData } = {}) {
  let url = BASE + path;
  if (params) {
    const qs = new URLSearchParams(params);
    url += (url.includes("?") ? "&" : "?") + qs.toString();
  }
  const headers = { Authorization: token, Accept: "application/json" };
  const opts = { method, headers };
  if (formData) {
    opts.body = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const json = await res.json().catch(() => ({}));
  return { http: res.status, json };
}

export async function fetchReplenish(token, rtuNumber) {
  const { http, json } = await api(token, "GET", "/rtu/replenishItem", {
    params: { rtuNumber },
  });
  if (http !== 200 || json.code !== 200) {
    throw new Error(`replenishItem ${rtuNumber}: HTTP ${http} code=${json.code} msg=${json.msg}`);
  }
  const row = json.data?.list?.[0];
  if (!row) throw new Error(`replenishItem ${rtuNumber}: empty list`);
  return row;
}

export function berlinToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Berlin",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

/** Current hour 0–23 in Europe/Berlin. */
export function berlinHour(date = new Date()) {
  const h = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Berlin",
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(h);
}

export function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function discountWindow(today = berlinToday()) {
  return [0, 1, 2, 3, 4].map((n) => addDaysYmd(today, n));
}

// Tiered (Berlin calendar days from today; hour for the evening cut-over):
//   effDate == today                              => 70%
//   effDate == tomorrow AND Berlin hour >= 18     => 70%  (starts 18:00 the evening before)
//   +1 (before 18:00) .. +2                       => 50%
//   +3 .. +4                                      => 20%
// else 0.
export function tierFor(effYmd, today = berlinToday(), hour = berlinHour()) {
  if (!effYmd) return 0;
  const d = Math.round((Date.parse(effYmd + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  if (d < 0 || d > 4) return 0;
  if (d === 0) return 70;
  if (d === 1 && Number(hour) >= 18) return 70;
  if (d <= 2) return 50;
  return 20;
}

export function tierPrice(original, pct) {
  const p = roundTo005(Number(original) * (1 - pct / 100));
  return Math.max(0.1, Math.round(p * 100) / 100);
}

/** Nearest 0.05 EUR; exact midpoints (.x25 / .x75) round DOWN. Machine rejects 1–2¢ steps. */
export function roundTo005(n) {
  const cents = Number(n) * 100;
  const q = cents / 5;
  const base = Math.floor(q + 1e-9);
  const frac = q - base;
  const steps = frac > 0.5 + 1e-9 ? base + 1 : base; // tie (frac≈0.5) → down
  return Math.round(steps * 5) / 100;
}

export function halfPrice(original) {
  const half = roundTo005(Number(original) * 0.5);
  return Math.max(0.1, Math.round(half * 100) / 100);
}

export function laneKey(rtuNumber, lane) {
  return `${rtuNumber}:${lane}`;
}
