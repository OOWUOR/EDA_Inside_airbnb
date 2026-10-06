/* Shared horizontal box-plot renderer.
 *
 *   window.drawBoxPlots(mount, boxes, opts)
 *
 *   mount — SVG parent element (sized by CSS)
 *   boxes — [{ dim, min, q1, median, q3, max, mean?, outliers?[] }, ...]
 *   opts  — {
 *             compact      : false,   // sparkline mode: no labels, no axis
 *             digits       : null,    // fixed decimals for tick values
 *             sort         : false,   // 'asc' | 'desc' — order rows by median
 *             axisTitle    : "",      // x-axis caption
 *             gridlines    : true,
 *             outliers     : true,
 *             mean         : false,   // draw a diamond at the mean
 *             pad          : 0.02,    // domain padding, fraction of range
 *             labelWidth   : null,    // px; measured from the data by default
 *             minRowHeight : 14,      // used only when grow === true
 *             grow         : false,   // expand past mount height instead of squashing
 *             format       : null,    // (value, digits) => string
 *             color        : "#ff385c"
 *           }
 *
 * Draws plain SVG (no Plot dependency). Styling is emitted as presentation
 * attributes so the chart is correct with zero CSS, but the original class
 * names are kept so existing stylesheets still win where they exist.
 */
(function () {
  "use strict";

  const NS = "http://www.w3.org/2000/svg";

  const THEME = {
    accent: "#ff385c",
    fill: "rgba(255,56,92,0.16)",
    grid: "#e9ecef",
    axis: "#dee2e6",
    tick: "#6c757d",
    label: "#343a40",
    font: "system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif",
  };

  /* ------------------------------------------------------------- helpers */

  function mk(parent, tag, attrs, text) {
    const el = document.createElementNS(NS, tag);
    if (attrs) {
      for (const k in attrs) {
        const v = attrs[k];
        if (v !== null && v !== undefined && v === v) el.setAttribute(k, v);
      }
    }
    if (text !== undefined && text !== null) el.textContent = text;
    parent.appendChild(el);
    return el;
  }

  function clear(el) {
    if (el.replaceChildren) el.replaceChildren();
    else while (el.firstChild) el.removeChild(el.firstChild);
  }

  const num = (v) =>
    v === null || v === undefined || v === "" ? NaN : Number(v);

  let _ctx;
  function textWidth(str, size) {
    if (_ctx === undefined) {
      try {
        _ctx = document.createElement("canvas").getContext("2d") || null;
      } catch (e) {
        _ctx = null;
      }
    }
    if (_ctx) {
      _ctx.font = size + "px " + THEME.font;
      return _ctx.measureText(str).width;
    }
    return str.length * size * 0.55;
  }

  function fitText(str, maxW, size) {
    if (!str || maxW <= 0) return "";
    if (textWidth(str, size) <= maxW) return str;
    const ell = "\u2026";
    let lo = 0,
      hi = str.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (textWidth(str.slice(0, mid) + ell, size) <= maxW) lo = mid;
      else hi = mid - 1;
    }
    return lo > 0 ? str.slice(0, lo) + ell : ell;
  }

  /* 1-2-5 "nice" tick generator; arithmetic on the index avoids FP drift. */
  function niceTicks(min, max, target) {
    if (!isFinite(min) || !isFinite(max) || !(max > min)) return [min];
    const raw = (max - min) / Math.max(1, target);
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    const norm = raw / mag;
    const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
    const out = [];
    const i0 = Math.ceil(min / step - 1e-9);
    const i1 = Math.floor(max / step + 1e-9);
    for (let i = i0; i <= i1; i++) out.push(i * step);
    return out;
  }

  function stepDigits(step) {
    if (!(step > 0)) return 0;
    return Math.min(6, Math.max(0, Math.ceil(-Math.log10(step) - 1e-9)));
  }

  function autoDigits(v) {
    const a = Math.abs(v);
    if (!(a > 0)) return 0;
    if (a >= 100) return 0;
    if (a >= 1) return 2;
    return Math.min(6, Math.ceil(-Math.log10(a)) + 2);
  }

  function fmtFixed(v, d) {
    let s = v.toFixed(d);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1); // kill "-0.0"
    return s;
  }

  /* -------------------------------------------------------------- render */

  function render(mount, boxes, opts) {
    const o = opts || {};
    const compact = !!o.compact;

    clear(mount);

    /* ---- 1. normalise input ----------------------------------------- */

    const data = [];
    if (Array.isArray(boxes)) {
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (!b) continue;

        const q1 = num(b.q1),
          q3 = num(b.q3),
          med = num(b.median);
        if (!isFinite(q1) || !isFinite(q3) || !isFinite(med)) continue;

        const lo = Math.min(q1, q3);
        const hi = Math.max(q1, q3);
        const mn = num(b.min),
          mx = num(b.max),
          mean = num(b.mean);

        const outs = [];
        if (Array.isArray(b.outliers)) {
          for (let j = 0; j < b.outliers.length; j++) {
            const v = num(b.outliers[j]);
            if (isFinite(v)) outs.push(v);
          }
        }

        data.push({
          dim: b.dim == null ? "" : String(b.dim),
          min: isFinite(mn) ? Math.min(mn, lo) : lo, // never invert the geometry
          q1: lo,
          median: Math.min(hi, Math.max(lo, med)), // median must sit in the box
          q3: hi,
          max: isFinite(mx) ? Math.max(mx, hi) : hi,
          mean: isFinite(mean) ? mean : null,
          outliers: outs,
        });
      }
    }

    if (!data.length) {
      const span = document.createElement("span");
      span.setAttribute(
        "style",
        "font-size:.7rem;color:#adb5bd;font-style:italic;",
      );
      span.textContent = "No data";
      mount.appendChild(span);
      return;
    }

    if (o.sort === "asc" || o.sort === "desc") {
      const dir = o.sort === "asc" ? 1 : -1;
      data.sort((a, b) => dir * (a.median - b.median));
    }

    /* ---- 2. canvas & vertical rhythm --------------------------------- */

    const svg = mk(mount, "svg", {
      width: "100%",
      height: "100%",
      style: "display:block;font-family:" + THEME.font + ";",
      class: "boxplot",
      role: "img",
    });

    const n = data.length;
    const compactRows = compact;
    const minRowH = compactRows ? 6 : Math.max(10, num(o.minRowHeight) || 14);
    const padT = compactRows ? 2 : 6;
    const tickSize = compactRows ? 9 : 10;

    let w = svg.clientWidth || mount.clientWidth || 0;
    let h = svg.clientHeight || mount.clientHeight || 0;
    if (w < 48) return;

    const hasAxis = !compactRows;
    const padB = hasAxis ? 4 + tickSize + (o.axisTitle ? 18 : 8) : 2;

    if (!(h > 0)) h = padT + n * minRowH + padB;

    let rowH = (h - padT - padB) / n;
    let grew = false;
    if (o.grow && rowH < minRowH) {
      rowH = minRowH;
      h = padT + n * rowH + padB;
      grew = true;
    }
    if (!(rowH > 0)) return;
    if (grew) svg.setAttribute("height", h + "px");

    /* ---- 3. label gutter (measured, not guessed) --------------------- */

    const padL = compactRows ? 4 : 8;
    const padR = compactRows ? 4 : 8;
    const labelSize = compactRows ? 0 : w < 340 ? 10 : 11;

    let labelW = 0;
    if (!compactRows) {
      const cap = Math.min(180, Math.max(40, w * 0.34));
      if (o.labelWidth != null) {
        labelW = Math.max(0, Math.min(num(o.labelWidth) || 0, cap));
      } else {
        let widest = 0;
        for (let i = 0; i < data.length; i++) {
          const tw = textWidth(data[i].dim, labelSize);
          if (tw > widest) widest = tw;
        }
        labelW = Math.min(cap, Math.max(32, widest + 8));
      }
    }

    const plotL = padL + labelW;
    const plotR = w - padR;
    const plotT = padT;
    const plotB = h - padB;
    if (plotR - plotL < 24 || plotB - plotT < 6) return;

    /* ---- 4. scale, ticks, formatting --------------------------------- */

    const showOutliers = o.outliers !== false;

    let xMin = Infinity,
      xMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const d = data[i];
      if (d.min < xMin) xMin = d.min;
      if (d.max > xMax) xMax = d.max;
      if (showOutliers) {
        for (let j = 0; j < d.outliers.length; j++) {
          const v = d.outliers[j];
          if (v < xMin) xMin = v;
          if (v > xMax) xMax = v;
        }
      }
    }

    const degenerate = !(xMax > xMin);
    const padFrac = o.pad === undefined ? 0.02 : Math.max(0, num(o.pad) || 0);
    if (!degenerate && padFrac) {
      const p = (xMax - xMin) * padFrac;
      xMin -= p;
      xMax += p;
    }
    const span = xMax - xMin;

    const centre = (plotL + plotR) / 2;
    const xOf = degenerate
      ? () => centre
      : (v) => plotL + ((v - xMin) / span) * (plotR - plotL);

    let ticks = [];
    if (hasAxis) {
      if (degenerate) {
        ticks = [xMin];
      } else {
        const target = Math.max(
          2,
          Math.min(7, Math.round((plotR - plotL) / 85)),
        );
        ticks = niceTicks(xMin, xMax, target).filter(
          (v) => v >= xMin - 1e-9 && v <= xMax + 1e-9,
        );
        if (ticks.length < 2) ticks = [xMin, xMax];
      }
    }

    const tickStep = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) : 0;
    const digits =
      o.digits != null
        ? Number(o.digits)
        : tickStep > 0
          ? stepDigits(tickStep)
          : autoDigits(xMin);

    const tipDigits =
      o.digits != null ? Number(o.digits) : Math.min(4, Math.max(2, digits));
    const tipFmt =
      typeof o.format === "function"
        ? (v) => String(o.format(v, tipDigits))
        : (v) => fmtFixed(v, tipDigits);
    const axisFmt =
      typeof o.format === "function"
        ? (v) => String(o.format(v, digits))
        : (v) => fmtFixed(v, digits);

    /* ---- 5. accessible summary --------------------------------------- */

    let loMed = Infinity,
      hiMed = -Infinity;
    for (let i = 0; i < n; i++) {
      if (data[i].median < loMed) loMed = data[i].median;
      if (data[i].median > hiMed) hiMed = data[i].median;
    }
    svg.setAttribute(
      "aria-label",
      "Box plot of " +
        n +
        (n === 1 ? " group" : " groups") +
        ", median " +
        axisFmt(loMed) +
        " to " +
        axisFmt(hiMed) +
        ".",
    );

    /* ---- 6. gridlines (behind everything) ---------------------------- */

    if (hasAxis && o.gridlines !== false && ticks.length) {
      const gGrid = mk(svg, "g", {
        class: "box-grid",
        "shape-rendering": "crispEdges",
      });
      for (let i = 0; i < ticks.length; i++) {
        const xr = Math.round(xOf(ticks[i])) + 0.5;
        mk(gGrid, "line", {
          x1: xr,
          y1: plotT,
          x2: xr,
          y2: plotB,
          stroke: THEME.grid,
          "stroke-width": 1,
        });
      }
    }

    /* ---- 7. rows ----------------------------------------------------- */

    const accent = o.color || THEME.accent;
    const maxBoxH = compactRows ? 9 : 22;
    const boxH = Math.max(1.5, Math.min(maxBoxH, rowH * 0.55, rowH - 1));
    const capH = Math.min(boxH, Math.max(3, boxH * 0.6));
    const medW = Math.max(1.4, Math.min(3, boxH * 0.24));
    const dotR = Math.max(1.4, Math.min(3.2, boxH * 0.16));
    const rx = Math.min(2, boxH / 3);

    const gRows = mk(svg, "g", { class: "box-rows" });

    for (let i = 0; i < n; i++) {
      const d = data[i];
      const cy = plotT + i * rowH + rowH / 2;
      const y1 = cy - boxH / 2;
      const y2 = cy + boxH / 2;
      const g = mk(gRows, "g", { class: "box-row" });

      const tip =
        (d.dim ? d.dim + " — " : "") +
        "min " +
        tipFmt(d.min) +
        ", Q1 " +
        tipFmt(d.q1) +
        ", median " +
        tipFmt(d.median) +
        ", Q3 " +
        tipFmt(d.q3) +
        ", max " +
        tipFmt(d.max);
      mk(g, "title", {}, tip);

      const xMinPx = xOf(d.min);
      const xMaxPx = xOf(d.max);
      const xQ1 = xOf(d.q1);
      const xQ3 = xOf(d.q3);
      const xMed = xOf(d.median);

      // Whiskers as two segments — a single min→max line would show through
      // the translucent box.
      mk(g, "line", {
        x1: xMinPx,
        y1: cy,
        x2: xQ1,
        y2: cy,
        stroke: accent,
        "stroke-width": 1,
        class: "box-rule",
      });
      mk(g, "line", {
        x1: xQ3,
        y1: cy,
        x2: xMaxPx,
        y2: cy,
        stroke: accent,
        "stroke-width": 1,
        class: "box-rule",
      });

      // End caps
      mk(g, "line", {
        x1: xMinPx,
        y1: cy - capH / 2,
        x2: xMinPx,
        y2: cy + capH / 2,
        stroke: accent,
        "stroke-width": 1,
        class: "box-cap",
      });
      mk(g, "line", {
        x1: xMaxPx,
        y1: cy - capH / 2,
        x2: xMaxPx,
        y2: cy + capH / 2,
        stroke: accent,
        "stroke-width": 1,
        class: "box-cap",
      });

      // Interquartile box
      mk(g, "rect", {
        x: xQ1,
        y: y1,
        width: Math.max(1, xQ3 - xQ1),
        height: boxH,
        rx: rx,
        ry: rx,
        fill: THEME.fill,
        stroke: accent,
        "stroke-width": 1,
        class: "box-fill",
      });

      // Median — heavier than every other stroke so it reads first
      mk(g, "line", {
        x1: xMed,
        y1: y1,
        x2: xMed,
        y2: y2,
        stroke: accent,
        "stroke-width": medW,
        class: "box-med",
      });

      // Optional mean marker (diamond, visually distinct from the median bar)
      if (o.mean && d.mean !== null) {
        const mx = xOf(d.mean);
        const r = Math.max(2, boxH * 0.22);
        mk(g, "polygon", {
          points:
            mx +
            "," +
            (cy - r) +
            " " +
            (mx + r) +
            "," +
            cy +
            " " +
            mx +
            "," +
            (cy + r) +
            " " +
            (mx - r) +
            "," +
            cy,
          fill: "#fff",
          stroke: accent,
          "stroke-width": 1.2,
          class: "box-mean",
        });
      }

      // Outliers
      if (showOutliers) {
        for (let j = 0; j < d.outliers.length; j++) {
          mk(g, "circle", {
            cx: xOf(d.outliers[j]),
            cy: cy,
            r: dotR,
            fill: "#fff",
            stroke: accent,
            "stroke-width": 1.2,
            class: "box-outlier",
          });
        }
      }

      // Row label — measured, truncated, full text on hover
      if (!compactRows && labelW > 0) {
        const full = d.dim;
        const shown = fitText(full, labelW - 8, labelSize);
        const t = mk(
          g,
          "text",
          {
            x: plotL - 6,
            y: cy + labelSize * 0.35,
            "text-anchor": "end",
            "font-size": labelSize,
            fill: THEME.label,
            class: "box-label",
          },
          shown,
        );
        if (shown !== full) mk(t, "title", {}, full);
      }
    }

    /* ---- 8. axis ----------------------------------------------------- */

    if (hasAxis) {
      const gAxis = mk(svg, "g", {
        class: "box-axis-group",
        "shape-rendering": "crispEdges",
      });

      mk(gAxis, "line", {
        x1: plotL,
        y1: plotB + 0.5,
        x2: plotR,
        y2: plotB + 0.5,
        stroke: THEME.axis,
        "stroke-width": 1,
        class: "box-axis",
      });

      const labelY = plotB + 4 + tickSize;

      for (let i = 0; i < ticks.length; i++) {
        const xr = Math.round(xOf(ticks[i])) + 0.5;

        mk(gAxis, "line", {
          x1: xr,
          y1: plotB + 1,
          x2: xr,
          y2: plotB + 4,
          stroke: THEME.axis,
          "stroke-width": 1,
          class: "box-axis",
        });

        // Keep the end labels inside the plot area
        const anchor =
          xr < plotL + 16 ? "start" : xr > plotR - 16 ? "end" : "middle";

        mk(
          gAxis,
          "text",
          {
            x: xr,
            y: labelY,
            "text-anchor": anchor,
            "font-size": tickSize,
            fill: THEME.tick,
            class: "box-tick",
          },
          axisFmt(ticks[i]),
        );
      }

      if (o.axisTitle) {
        mk(
          gAxis,
          "text",
          {
            x: (plotL + plotR) / 2,
            y: labelY + 15,
            "text-anchor": "middle",
            "font-size": tickSize,
            fill: THEME.tick,
            class: "box-axis-title",
          },
          String(o.axisTitle),
        );
      }
    }
  }

  /* ------------------------------------------------------ resize plumbing */

  function attachResize(mount) {
    if (typeof ResizeObserver === "undefined" || mount.__bpRO) return;

    let lastW = mount.clientWidth;
    let lastH = mount.clientHeight;
    let queued = false;

    const ro = new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      const flush = () => {
        queued = false;
        const w = mount.clientWidth;
        const h = mount.clientHeight;
        if (w === lastW && h === lastH) return;
        lastW = w;
        lastH = h;
        const a = mount.__bpArgs;
        if (a) render(mount, a.boxes, a.opts);
      };
      if (typeof requestAnimationFrame === "function")
        requestAnimationFrame(flush);
      else flush();
    });

    ro.observe(mount);
    mount.__bpRO = ro;
  }

  /* ------------------------------------------------------------ public API */

  function drawBoxPlots(mount, boxes, opts) {
    if (!mount) return;
    mount.__bpArgs = { boxes: boxes, opts: opts || {} };
    render(mount, boxes, opts || {});
    attachResize(mount);
  }

  window.drawBoxPlots = drawBoxPlots;
})();
