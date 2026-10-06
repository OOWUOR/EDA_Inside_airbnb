/* Neighbourhood leaderboard — reacts to superlative tile clicks.
 *
 * Reads: <script id="city-superlatives-data" type="application/json">{...}</script>
 * Listens: "superlative:select" { detail: { metric, label } }
 * Renders into:
 *   #neighbourhoodsList   — top-5 ranked bars
 *   #neighbourhoods-badge — the active metric
 *
 * Every row carries six metrics; switching metric re-sorts and
 * re-renders without a round trip.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-superlatives-data");
  const list = document.getElementById("neighbourhoodsList");
  const badge = document.getElementById("neighbourhoods-badge");
  if (!dataEl || !list) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("neighbourhoods.js: invalid data", err);
    return;
  }
  if (!data) return;

  const hoods = data.neighbourhoods || [];
  console.debug("[neighbourhoods.js] areas:", hoods.length);

  /* ------------------------------------------------------------------ */
  /* Metric configuration                                                */
  /* ------------------------------------------------------------------ */
  const METRICS = {
    // Default: sorted by listing count, badge reads "top 5"
    count: {
      key: "count",
      dir: "desc",
      badge: "# Listings",
      fmt: (v) => v.toLocaleString(),
    },
    price_asc: {
      key: "avg_price_usd",
      dir: "asc",
      badge: "cheapest",
      fmt: (v) => (v != null ? `$${Math.round(v)}` : "—"),
    },
    price_desc: {
      key: "avg_price_usd",
      dir: "desc",
      badge: "priciest",
      fmt: (v) => (v != null ? `$${Math.round(v)}` : "—"),
    },
    rating: {
      key: "avg_rating",
      dir: "desc",
      badge: "best rated",
      fmt: (v) => (v != null ? v.toFixed(2) : "—"),
    },
    occupancy: {
      key: "avg_occ_pct",
      dir: "desc",
      badge: "busiest",
      fmt: (v) => (v != null ? `${v.toFixed(0)}%` : "—"),
    },
    nights: {
      key: "avg_nights",
      dir: "desc",
      badge: "longest stay",
      fmt: (v) => (v != null ? `${v.toFixed(1)}n` : "—"),
    },
    commercial: {
      key: "multi_share",
      dir: "desc",
      badge: "commercial",
      fmt: (v) => (v != null ? `${v.toFixed(0)}%` : "—"),
    },
  };

  const state = { metric: "count" };

  /* ------------------------------------------------------------------ */
  /* Render                                                              */
  /* ------------------------------------------------------------------ */
  function draw() {
    const cfg = METRICS[state.metric] || METRICS.count;

    if (badge) badge.textContent = cfg.badge;

    // Keep only rows with a real value for the active metric
    let rows = hoods.filter((h) => h[cfg.key] != null);

    if (!rows.length) {
      list.replaceChildren();
      const p = document.createElement("div");
      p.className = "neighbourhoods-placeholder";
      p.textContent = `No data for “${cfg.badge}”.`;
      list.appendChild(p);
      return;
    }

    // Sort
    rows.sort((a, b) =>
      cfg.dir === "asc" ? a[cfg.key] - b[cfg.key] : b[cfg.key] - a[cfg.key],
    );

    // Top 20
    rows = rows.slice(0, 20);

    // Bar scaling — always value / max.
    // Bars encode the raw metric; the sort direction (asc for "cheapest")
    // is what conveys ranking.  Never invert.
    const vals = rows.map((r) => r[cfg.key]);
    const maxV = Math.max(...vals);
    const scale = (v) => (maxV > 0 ? v / maxV : 0);

    list.replaceChildren();

    rows.forEach((h) => {
      const el = document.createElement("div");
      el.className = "neighbourhood";
      const width = Math.max(4, scale(h[cfg.key]) * 100); // min visible bar
      el.innerHTML = `
        <span class="neighbourhood__name" title="${h.name}">${h.name}</span>
        <span class="neighbourhood__count">${cfg.fmt(h[cfg.key])}</span>
        <span class="neighbourhood__bar"><span style="width:${width}%"></span></span>
      `;
      list.appendChild(el);
    });
  }

  /* ------------------------------------------------------------------ */
  /* React to superlative tile clicks                                    */
  /* ------------------------------------------------------------------ */
  document.addEventListener("superlative:select", (e) => {
    state.metric = e.detail?.metric || "count";
    console.debug("[neighbourhoods.js] metric:", state.metric);
    draw();
  });

  /* ------------------------------------------------------------------ */
  /* First paint                                                         */
  /* ------------------------------------------------------------------ */
  draw();
})();
