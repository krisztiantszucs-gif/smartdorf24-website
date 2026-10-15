(function () {
  "use strict";

  const FALLBACK_LOCATIONS = [
    {
      id: "schiesheim",
      name: { de: "Schiesheim", en: "Schiesheim" },
      address: "Lindenstraße 35, 65623 Schiesheim",
      lat: 50.2757388,
      lng: 8.0527833,
      machines: [],
    },
    {
      id: "steinsberg",
      name: { de: "Steinsberg", en: "Steinsberg" },
      address: "Steinsberg, Rheinland-Pfalz",
      lat: 50.3233221,
      lng: 7.9441574,
      machines: [],
    },
  ];

  const state = {
    lang: localStorage.getItem("sd24_lang") || "de",
    stock: null,
    discounts: { active: {} },
    locationId: "schiesheim",
    machineId: null,
    map: null,
    markers: [],
  };

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function t(key) {
    const pack = window.SD24_I18N[state.lang] || window.SD24_I18N.de;
    return pack[key] || window.SD24_I18N.de[key] || key;
  }

  function locName(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj[state.lang] || obj.de || obj.en || "";
  }

  function applyI18n() {
    $$("[data-i18n]").forEach((el) => {
      el.textContent = t(el.getAttribute("data-i18n"));
    });
    document.documentElement.lang = state.lang;
    $$(".lang-toggle button").forEach((b) => {
      b.classList.toggle("active", b.dataset.lang === state.lang);
    });
    renderLocations();
    renderMachineTabs();
    renderMachine();
    updateMapPopups();
  }

  
  function discountFor(rtu, lane) {
    const key = String(rtu) + ":" + String(lane);
    return state.discounts?.active?.[key] || null;
  }

  function formatMoney(n) {
    try {
      return new Intl.NumberFormat(state.lang === "de" ? "de-DE" : "en-IE", {
        style: "currency",
        currency: "EUR",
      }).format(Number(n) || 0);
    } catch {
      return (Number(n) || 0).toFixed(2) + " €";
    }
  }

  function formatTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat(state.lang === "de" ? "de-DE" : "en-GB", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Berlin",
      }).format(new Date(iso));
    } catch {
      return iso;
    }
  }

  function currentLocation() {
    const locs = state.stock?.locations || FALLBACK_LOCATIONS;
    return locs.find((l) => l.id === state.locationId) || locs[0];
  }

  function currentMachine() {
    const loc = currentLocation();
    if (!loc?.machines?.length) return null;
    return loc.machines.find((m) => m.rtuNumber === state.machineId) || loc.machines[0];
  }

  function renderLocations() {
    const list = $("#loc-list");
    if (!list) return;
    const locs = state.stock?.locations || FALLBACK_LOCATIONS;
    list.innerHTML = locs
      .map((loc) => {
        const online = (loc.machines || []).filter((m) => m.online).length;
        const total = (loc.machines || []).length;
        const active = loc.id === state.locationId ? "active" : "";
        return `<button type="button" class="loc-card ${active}" data-loc="${loc.id}">
          <h3>${escapeHtml(locName(loc.name))}</h3>
          <p>${escapeHtml(loc.address || "")}</p>
          <div class="loc-meta">
            <span class="pill">${total} ${t("machines_label")}</span>
            <span class="pill ${online ? "ok" : "off"}">${online}/${total} ${t("online")}</span>
          </div>
        </button>`;
      })
      .join("");
    list.querySelectorAll("[data-loc]").forEach((btn) => {
      btn.addEventListener("click", () => selectLocation(btn.dataset.loc));
    });
  }

  function selectLocation(id, fromMap) {
    state.locationId = id;
    const loc = currentLocation();
    state.machineId = loc?.machines?.[0]?.rtuNumber || null;
    renderLocations();
    renderMachineTabs();
    renderMachine();
    if (state.map && loc && !fromMap) {
      state.map.setView([loc.lat, loc.lng], 14, { animate: true });
    }
  }

  function renderMachineTabs() {
    const tabs = $("#machine-tabs");
    if (!tabs) return;
    const loc = currentLocation();
    const machines = loc?.machines || [];
    if (!machines.length) {
      tabs.innerHTML = "";
      return;
    }
    if (!state.machineId) state.machineId = machines[0].rtuNumber;
    tabs.innerHTML = machines
      .map((m) => {
        const active = m.rtuNumber === state.machineId ? "active" : "";
        const status = m.online ? t("online") : t("offline");
        return `<button type="button" class="${active}" data-rtu="${m.rtuNumber}">
          ${escapeHtml(locName(m.name))} · ${status}
        </button>`;
      })
      .join("");
    tabs.querySelectorAll("[data-rtu]").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.machineId = btn.dataset.rtu;
        renderMachineTabs();
        renderMachine();
      });
    });
  }

  function stockBadgeClass(stock, capacity) {
    if (stock <= 0) return "out";
    if (capacity > 0 && stock / capacity <= 0.25) return "low";
    if (stock <= 2) return "low";
    return "";
  }

  function renderMachine() {
    const root = $("#vm-root");
    const updated = $("#updated-at");
    const banner = $("#sample-banner");
    if (!root) return;

    if (banner) {
      banner.classList.toggle("show", Boolean(state.stock?.sample));
      banner.textContent = t("sample_note");
    }
    if (updated) {
      const iso = state.stock?.updatedAt || currentMachine()?.fetchedAt;
      updated.textContent = `${t("last_updated")}: ${formatTime(iso)}${state.stock?.sample ? " (sample)" : ""}`;
    }

    const machine = currentMachine();
    if (!machine) {
      root.innerHTML = `<div class="empty-state">${escapeHtml(t("empty_machine"))}</div>`;
      return;
    }

    const items = Array.isArray(machine.items) ? machine.items.slice() : [];
    const byLevel = new Map();
    for (const item of items) {
      const lvl = Number(item.level) || 0;
      if (!byLevel.has(lvl)) byLevel.set(lvl, []);
      byLevel.get(lvl).push(item);
    }
    const levels = Array.from(byLevel.keys()).sort((a, b) => a - b);

    const shelves =
      levels.length === 0
        ? `<div class="empty-state">${escapeHtml(t("empty_machine"))}</div>`
        : levels
            .map((lvl) => {
              const slots = byLevel
                .get(lvl)
                .map((item) => {
                  const sold = Number(item.stock) <= 0;
                  const badge = stockBadgeClass(item.stock, item.capacity);
                  const letter = escapeHtml((item.name || "?").slice(0, 1));
                  const img = item.image
                    ? `<img src="${escapeAttr(item.image)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='grid'" /><div class="slot-fallback" style="display:none">${letter}</div>`
                    : `<div class="slot-fallback">${letter}</div>`;
                  const disc = discountFor(machine.rtuNumber, item.lane);
                  const priceHtml = disc
                    ? `<span class="price-wrap"><span class="price-old">${formatMoney(disc.originalPrice)}</span><span class="price">${formatMoney(item.price)}</span></span>`
                    : `<span class="price">${formatMoney(item.price)}</span>`;
                  const saleBadge = disc ? `<span class="badge-sale">${escapeHtml(t("sale_badge"))}</span>` : "";
                  return `<div class="slot ${sold ? "soldout" : ""}" data-soldout="${escapeAttr(t("sold_out"))}">
                    ${saleBadge}
                    ${img}
                    <div class="name" title="${escapeAttr(item.name || "")}">${escapeHtml(item.name || "")}</div>
                    <div class="meta-row">
                      ${priceHtml}
                      <span class="stock-badge ${badge}">${Number(item.stock) || 0}/${Number(item.capacity) || 0}</span>
                    </div>
                  </div>`;
                })
                .join("");
              return `<div class="shelf">
                <div class="shelf-label">${t("level")} ${lvl}</div>
                <div class="shelf-row">${slots}</div>
              </div>`;
            })
            .join("");

    const statusPill = machine.online
      ? `<span class="pill ok">${t("online")}</span>`
      : `<span class="pill off">${t("offline")}</span>`;

    root.innerHTML = `<div class="vm-wrap"><div class="vm">
      <div class="vm-top">
        <h3>${escapeHtml(locName(machine.name))}</h3>
        ${statusPill}
      </div>
      <div class="vm-glass">${shelves}</div>
      <div class="vm-tray" aria-hidden="true"></div>
    </div></div>`;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/'/g, "&#39;");
  }

  function initMap() {
    const el = $("#map");
    if (!el || typeof L === "undefined") return;
    state.map = L.map(el, { scrollWheelZoom: false });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    refreshMarkers();
    const locs = state.stock?.locations || FALLBACK_LOCATIONS;
    const bounds = L.latLngBounds(locs.map((l) => [l.lat, l.lng]));
    state.map.fitBounds(bounds.pad(0.35));
  }

  function refreshMarkers() {
    if (!state.map) return;
    state.markers.forEach((m) => m.remove());
    state.markers = [];
    const locs = state.stock?.locations || FALLBACK_LOCATIONS;
    locs.forEach((loc) => {
      const count = (loc.machines || []).length;
      const marker = L.marker([loc.lat, loc.lng]).addTo(state.map);
      marker.bindPopup(
        `<strong>${escapeHtml(locName(loc.name))}</strong><br>${escapeHtml(loc.address || "")}<br>${count} ${t("map_popup_machines")}`
      );
      marker.on("click", () => selectLocation(loc.id, true));
      state.markers.push(marker);
    });
  }

  function updateMapPopups() {
    refreshMarkers();
  }

  async function loadStock() {
    try {
      const res = await fetch("data/stock.json", { cache: "no-store" });
      if (!res.ok) throw new Error("stock fetch " + res.status);
      state.stock = await res.json();
    } catch (err) {
      console.warn("Using fallback locations:", err);
      state.stock = {
        sample: true,
        updatedAt: null,
        locations: FALLBACK_LOCATIONS,
      };
    }
    try {
      const dres = await fetch("data/discounts.json", { cache: "no-store" });
      if (dres.ok) state.discounts = await dres.json();
    } catch (err) {
      console.warn("discounts.json unavailable", err);
    }
    const loc = currentLocation();
    state.machineId = loc?.machines?.[0]?.rtuNumber || null;
    applyI18n();
    if (state.map) {
      refreshMarkers();
    } else {
      initMap();
    }
  }

  function bindUi() {
    $$(".lang-toggle button").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.lang = btn.dataset.lang;
        localStorage.setItem("sd24_lang", state.lang);
        applyI18n();
      });
    });
    const menuBtn = $("#menu-btn");
    const nav = $("#nav-links");
    if (menuBtn && nav) {
      menuBtn.addEventListener("click", () => nav.classList.toggle("open"));
      nav.querySelectorAll("a").forEach((a) =>
        a.addEventListener("click", () => nav.classList.remove("open"))
      );
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindUi();
    applyI18n();
    loadStock();
  });
})();
