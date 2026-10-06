/* D3 neighbourhood map with dynamic choropleth.
 *
 * Reads:
 *   <script id="neighbourhood-geojson"      type="application/json">{...}</script>
 *   <script id="city-superlatives-data"     type="application/json">{...}</script>
 *
 * Renders into:
 *   #neighbourhood-map      — SVG polygon choropleth
 *   #map-legend             — horizontal legend (sibling div, not SVG)
 *   #neighbourhood-tooltip  — floating tooltip
 *
 * Reacts to:
 *   "superlative:select" { detail: { metric } }   from superlatives.js
 *
 * Default metric is "count" (listings).  Every metric's palette is
 * ascending (low = near-white, high = near-rose) except "price_asc",
 * which is inverted so the cheapest neighbourhoods are deepest rose.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("neighbourhood-geojson");
  const superEl = document.getElementById("city-superlatives-data");
  const container = document.getElementById("neighbourhood-map");
  const tooltip = document.getElementById("neighbourhood-tooltip");
  const legendEl = document.getElementById("map-legend");

  if (!dataEl || !container || typeof d3 === "undefined") return;

  let geojson;
  try {
    geojson = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("map.js: invalid GeoJSON", err);
    return;
  }

  const features = (geojson && geojson.features) || [];
  if (!features.length) {
    container.innerHTML =
      '<p class="empty" style="padding:1rem;">No features in this file.</p>';
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Neighbourhood metrics lookup                                        */
  /* ------------------------------------------------------------------ */
  function norm(s) {
    return String(s || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // strip combining accents
      .toLowerCase()
      .replace(/[–—−]/g, "-")
      .replace(/\s+/g, " ")
      .trim();
  }

  const hoodMetrics = new Map();
  if (superEl) {
    try {
      const data = JSON.parse(superEl.textContent);
      (data.neighbourhoods || []).forEach((h) => {
        hoodMetrics.set(norm(h.name), h);
      });
    } catch (err) {
      console.warn("map.js: could not parse superlatives data", err);
    }
  }
  console.debug("[map.js] neighbourhood metrics:", hoodMetrics.size);

  function lookupHood(feature) {
    const props = feature.properties || {};
    const raw =
      props.neighbourhood ||
      props.name ||
      props.NAME ||
      props.Neighbourhood ||
      null;
    if (!raw) return null;
    return hoodMetrics.get(norm(raw)) || null;
  }

  /* ------------------------------------------------------------------ */
  /* Metric config                                                       */
  /* ------------------------------------------------------------------ */
  const METRICS = {
    count: {
      key: "count",
      label: "listings",
      invert: false,
      fmt: (v) => v.toLocaleString(),
    },
    price_asc: {
      key: "avg_price_usd",
      label: "avg price",
      invert: true,
      fmt: (v) => `$${Math.round(v)}`,
    },
    price_desc: {
      key: "avg_price_usd",
      label: "avg price",
      invert: false,
      fmt: (v) => `$${Math.round(v)}`,
    },
    rating: {
      key: "avg_rating",
      label: "rating",
      invert: false,
      fmt: (v) => v.toFixed(2),
    },
    occupancy: {
      key: "avg_occ_pct",
      label: "occupancy",
      invert: false,
      fmt: (v) => `${v.toFixed(0)}%`,
    },
    nights: {
      key: "avg_nights",
      label: "avg nights",
      invert: false,
      fmt: (v) => `${v.toFixed(1)}n`,
    },
    commercial: {
      key: "multi_share",
      label: "commercial",
      invert: false,
      fmt: (v) => `${v.toFixed(0)}%`,
    },
  };

  let activeMetric = "count";
  const activeCfg = () => METRICS[activeMetric] || METRICS.count;

  /* ------------------------------------------------------------------ */
  /* Colour scale                                                        */
  /* ------------------------------------------------------------------ */
  const STOPS = [
    [0.0, [255, 245, 247]], // #fff5f7  near-white
    [0.5, [255, 139, 160]], // #ff8ba0  mid rose
    [1.0, [200, 30, 68]], // #c81e44  deep rose
  ];

  function lerpColor(t) {
    t = Math.max(0, Math.min(1, t));
    for (let i = 0; i < STOPS.length - 1; i++) {
      const [t0, c0] = STOPS[i];
      const [t1, c1] = STOPS[i + 1];
      if (t <= t1) {
        const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return (
          `rgb(${Math.round(c0[0] + (c1[0] - c0[0]) * k)},` +
          `${Math.round(c0[1] + (c1[1] - c0[1]) * k)},` +
          `${Math.round(c0[2] + (c1[2] - c0[2]) * k)})`
        );
      }
    }
    const last = STOPS[STOPS.length - 1][1];
    return `rgb(${last.join(",")})`;
  }

  function colorFor(value, min, max, invert) {
    if (value == null || !isFinite(value)) return "#e5e7eb";
    const range = max - min;
    if (range <= 0) return lerpColor(0.5);
    let t = (value - min) / range;
    if (invert) t = 1 - t;
    return lerpColor(t);
  }

  function gradientCss(invert) {
    if (invert) {
      return (
        "linear-gradient(90deg," +
        "rgb(200,30,68), rgb(255,139,160), rgb(255,245,247))"
      );
    }
    return (
      "linear-gradient(90deg," +
      "rgb(255,245,247), rgb(255,139,160), rgb(200,30,68))"
    );
  }

  /* ------------------------------------------------------------------ */
  /* Projection helpers                                                  */
  /* ------------------------------------------------------------------ */
  function firstCoord(feature) {
    const g = feature.geometry || {};
    if (g.type === "Polygon") return g.coordinates[0]?.[0];
    if (g.type === "MultiPolygon") return g.coordinates[0]?.[0]?.[0];
    if (g.type === "LineString") return g.coordinates[0];
    if (g.type === "MultiLineString") return g.coordinates[0]?.[0];
    return null;
  }

  const sample = firstCoord(features[0]);
  const isWGS84 =
    sample && Math.abs(sample[0]) <= 180 && Math.abs(sample[1]) <= 90;

  function label(props) {
    if (!props) return { name: "Unnamed", group: null };
    const name =
      props.neighbourhood ||
      props.name ||
      props.NAME ||
      props.Neighbourhood ||
      props.NEIGHBOURHOOD;
    const group =
      props.neighbourhood_group ||
      props.group ||
      props.Neighbourhood_Group ||
      null;
    if (name) return { name, group };
    for (const [k, v] of Object.entries(props)) {
      if (typeof v === "string" && v.trim()) return { name: v, group: k };
    }
    return { name: "Unnamed", group: null };
  }

  /* ------------------------------------------------------------------ */
  /* SVG skeleton                                                        */
  /* ------------------------------------------------------------------ */
  let featureSelection = null;

  function draw() {
    container.innerHTML = "";

    const w = container.clientWidth || 400;
    const h = container.clientHeight || 400;
    const pad = 8;

    const svg = d3
      .select(container)
      .append("svg")
      .attr("viewBox", `0 0 ${w} ${h}`)
      .attr("preserveAspectRatio", "xMidYMid meet");

    let projection;
    if (isWGS84) {
      projection = d3.geoMercator().fitExtent(
        [
          [pad, pad],
          [w - pad, h - pad],
        ],
        geojson,
      );
    } else {
      projection = d3
        .geoIdentity()
        .reflectY(true)
        .fitExtent(
          [
            [pad, pad],
            [w - pad, h - pad],
          ],
          geojson,
        );
    }
    const path = d3.geoPath(projection);
    const single = features.length === 1;

    featureSelection = svg
      .append("g")
      .selectAll("path")
      .data(features)
      .join("path")
      .attr("class", single ? "neighbourhood single" : "neighbourhood")
      .attr("d", path)
      .on("mouseenter", function () {
        d3.select(this).raise();
      })
      .on("mousemove", function (event, d) {
        if (!tooltip) return;

        const { name, group } = label(d.properties);
        const hood = lookupHood(d);
        const cfg = activeCfg();
        const v = hood ? hood[cfg.key] : null;
        const value = typeof v === "number" && isFinite(v) ? cfg.fmt(v) : null;

        tooltip.innerHTML = value
          ? `<strong>${name}</strong><small>${cfg.label}: ${value}</small>`
          : group
            ? `<strong>${name}</strong><small>${group}</small>`
            : `<strong>${name}</strong>`;

        tooltip.style.opacity = "1";
        tooltip.style.left = event.clientX + 14 + "px";
        tooltip.style.top = event.clientY - 10 + "px";
      })
      .on("mouseleave", function () {
        if (tooltip) tooltip.style.opacity = "0";
      });

    recolor();
  }

  /* ------------------------------------------------------------------ */
  /* Recolor + legend                                                    */
  /* ------------------------------------------------------------------ */
  function recolor() {
    if (!featureSelection) return;

    const cfg = activeCfg();
    const values = [];
    features.forEach((f) => {
      const hood = lookupHood(f);
      if (!hood) return;
      const v = hood[cfg.key];
      if (typeof v === "number" && isFinite(v)) values.push(v);
    });

    const min = values.length ? Math.min(...values) : 0;
    const max = values.length ? Math.max(...values) : 1;

    featureSelection.style("fill", (d) => {
      const hood = lookupHood(d);
      const v = hood ? hood[cfg.key] : null;
      return colorFor(v, min, max, cfg.invert);
    });

    updateLegend(cfg, min, max, values.length);
  }

  function updateLegend(cfg, min, max, count) {
    if (!legendEl) return;

    const minTxt = count ? cfg.fmt(min) : "—";
    const maxTxt = count ? cfg.fmt(max) : "—";

    legendEl.innerHTML = `
      <span class="map-legend-title">${cfg.label}</span>
      <span class="map-legend-min">${minTxt}</span>
      <span class="map-legend-bar" style="background:${gradientCss(cfg.invert)};"></span>
      <span class="map-legend-max">${maxTxt}</span>
    `;
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */
  document.addEventListener("superlative:select", (e) => {
    activeMetric = e.detail?.metric || "count";
    console.debug("[map.js] metric:", activeMetric);
    recolor();
  });

  draw();

  /* Re-render on container resize — the whole SVG is redrawn so the
     projection and legend both fit the new dimensions. */
  let rafId = null;
  new ResizeObserver(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(draw);
  }).observe(container);
})();
