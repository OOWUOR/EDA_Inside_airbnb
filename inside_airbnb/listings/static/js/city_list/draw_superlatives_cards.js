/* Superlatives — medal wall (2×3 clickable tiles).
 *
 * Reads: <script id="city-superlatives-data" type="application/json">{...}</script>
 * Renders into:
 *   #superlativesList   — six tiles: icon+label / value / name
 *   #superlatives-badge — min-listings threshold context
 *
 * Interaction:
 *   Clicking a tile dispatches a "superlative:select" event with
 *   `{ metric }`.  Clicking the same tile again dispatches
 *   `{ metric: null }` to reset the downstream leaderboard.
 */
(function () {
  "use strict";

  const dataEl = document.getElementById("city-superlatives-data");
  const list = document.getElementById("superlativesList");
  const badge = document.getElementById("superlatives-badge");
  if (!dataEl || !list) return;

  let data;
  try {
    data = JSON.parse(dataEl.textContent);
  } catch (err) {
    console.error("superlatives.js: invalid data", err);
    return;
  }
  if (!data) return;

  const items = data.items || [];

  console.debug("[superlatives.js] items:", items.length);

  if (badge) {
    badge.textContent = data.min_listings
      ? `${data.min_listings}+ per area`
      : "";
  }

  if (!items.length) {
    list.replaceChildren();
    const p = document.createElement("div");
    p.className = "superlatives-placeholder";
    p.textContent = "Not enough neighbourhood data.";
    list.appendChild(p);
    return;
  }

  list.replaceChildren();
  list.classList.add("superlatives-wall");

  function emit(metric, label) {
    document.dispatchEvent(
      new CustomEvent("superlative:select", {
        detail: { metric, label },
      }),
    );
  }

  function handleClick(tile) {
    const metric = tile.dataset.metric;
    if (!metric) return;

    const wasActive = tile.classList.contains("active");
    list
      .querySelectorAll(".superlative-tile")
      .forEach((t) => t.classList.remove("active"));

    if (wasActive) {
      emit(null, null); // deselect → default
    } else {
      tile.classList.add("active");
      const label =
        tile.querySelector(".superlative-tile__label")?.textContent.trim() ||
        "";
      emit(metric, label);
    }
  }

  items.forEach((item) => {
    const tile = document.createElement("div");
    tile.className = "superlative-tile";
    tile.dataset.metric = item.metric || "";
    tile.setAttribute("role", "button");
    tile.setAttribute("tabindex", "0");
    tile.innerHTML = `
      <div class="superlative-tile__head">
        <span class="superlative-tile__icon">${item.icon}</span>
        <span class="superlative-tile__label">${item.label}</span>
      </div>
      <div class="superlative-tile__value">${item.value}</div>
      <div class="superlative-tile__name" title="${item.name}">${item.name}</div>
    `;
    tile.addEventListener("click", () => handleClick(tile));
    tile.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handleClick(tile);
      }
    });
    list.appendChild(tile);
  });
})();
