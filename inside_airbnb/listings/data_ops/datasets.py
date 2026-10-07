"""Read cached Inside Airbnb datasets and compute per-city stats.

Disk layout (populated by ``python manage.py sync_datasets``):

    <DATASET_CACHE_DIR>/<city_slug>/listings.csv.gz
    <DATASET_CACHE_DIR>/<city_slug>/reviews.csv.gz
    <DATASET_CACHE_DIR>/<city_slug>/calendar.csv.gz
    <DATASET_CACHE_DIR>/<city_slug>/neighbourhoods.geojson

Each file has a sidecar ``.url`` recording the source URL, so a changed
remote URL triggers a fresh download on the next sync.

Aggregates are cached against the source file's mtime.  A companion
management command, ``precompute_cities``, warms every cache entry ahead
of the first request so page loads are effectively instant.
"""

from __future__ import annotations

import gzip
import html as _html
import json
import logging
import re
from datetime import date
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from django.conf import settings
from django.core.cache import cache

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DEFAULT_MAX_ROWS = 200
CACHE_SECONDS = 60 * 60 * 6  # 6 hours — dataset previews
CITY_STATS_CACHE_SECONDS = 60 * 60 * 6  # 6 hours — headline stats
CHART_CACHE_SECONDS = 60 * 60 * 6  # 6 hours — chart aggregates

# Bump whenever the *shape* of a computed response changes so stale
# cached values are not returned for the new code.
# Adjust accordingly
CHART_CACHE_VERSION = 1

# kind -> (City model field, cache filename)
KINDS = {
    "listings": ("listings_csv_gz", "listings.csv.gz"),
    "reviews": ("reviews_csv_gz", "reviews.csv.gz"),
    "calendar": ("calendar_csv_gz", "calendar.csv.gz"),
    "neighbourhoods": ("neighbourhoods_geojson", "neighbourhoods.geojson"),
}


# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------


def cache_dir() -> Path:
    base = Path(
        getattr(settings, "DATASET_CACHE_DIR", settings.BASE_DIR / "dataset_cache")
    )
    base.mkdir(parents=True, exist_ok=True)
    return base


def _path_for(city, filename: str) -> Path:
    return cache_dir() / city.city_slug / filename


# ---------------------------------------------------------------------------
# Readers
# ---------------------------------------------------------------------------


def _read_gzip_csv_head(path: Path, max_rows: int) -> list[dict[str, Any]]:
    """Parse just the first max_rows of a local .csv.gz."""
    if not path.exists() or path.stat().st_size == 0:
        return []
    with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
        df = pd.read_csv(fh, nrows=max_rows, low_memory=False, on_bad_lines="skip")
    df = df.where(pd.notna(df), None)
    return df.to_dict(orient="records")


def _read_geojson(path: Path) -> dict[str, Any]:
    """Load a local .geojson file in full."""
    if not path.exists() or path.stat().st_size == 0:
        return {}
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# Preview loading (feeds the JSON <pre> blocks + map)
# ---------------------------------------------------------------------------


def _load_kind(city, kind: str, *, max_rows: int) -> Any:
    """Return preview data, a status dict, or None if the city has no URL."""
    field, filename = KINDS[kind]
    if not getattr(city, field, None):
        return None

    key = f"city_dataset:{city.city_slug}:{kind}:{max_rows}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    path = _path_for(city, filename)
    if not path.exists():
        data = {
            "status": "pending",
            "message": (
                "Not downloaded yet. Run:\n"
                f"  python manage.py sync_datasets --city {city.city_slug}"
            ),
        }
    else:
        try:
            if kind == "neighbourhoods":
                data = _read_geojson(path)
            else:
                data = _read_gzip_csv_head(path, max_rows)
        except Exception as exc:
            logger.exception("Failed reading %s for %s", path, city.city_slug)
            data = {"status": "error", "message": f"{type(exc).__name__}: {exc}"}

    ttl = 60 if isinstance(data, dict) and "status" in data else CACHE_SECONDS
    cache.set(key, data, ttl)
    return data


def load_city_datasets(city, *, max_rows: int = DEFAULT_MAX_ROWS) -> dict[str, Any]:
    """Return previews for the dataset kinds."""
    return {
        "listings": _load_kind(city, "listings", max_rows=max_rows),
        "reviews": _load_kind(city, "reviews", max_rows=max_rows),
        "calendar": _load_kind(city, "calendar", max_rows=max_rows),
        "neighbourhoods": _load_kind(city, "neighbourhoods", max_rows=max_rows),
    }


def datasets_as_json(datasets: dict[str, Any]) -> dict[str, str | None]:
    """Pretty-print each dataset as a JSON string for the template."""

    def dump(v):
        if v is None:
            return None
        try:
            return json.dumps(v, indent=2, default=str, ensure_ascii=False)
        except TypeError as exc:
            return f"// Could not serialise: {exc}"

    return {name: dump(data) for name, data in datasets.items()}


# ---------------------------------------------------------------------------
# Per-listing parsers
# ---------------------------------------------------------------------------

_PRICE_RE = re.compile(r"[^\d.]")
_NIGHTS_RE = re.compile(r"(\d+)\s*nights?\b", re.IGNORECASE)


def _parse_price_series(series: pd.Series, *, min_valid: float = 1.0) -> pd.Series:
    """Convert a listings.price column ('$120.00', '1,234.56', '') to float.

    Values below *min_valid* are dropped — they're sentinels, unit-glitches,
    or mis-parses (e.g. Swiss rows where "120.00" became "0.12").  A real
    nightly rate is never below 1 unit of its local currency.
    """
    prices = (
        series.astype(str)
        .str.replace(_PRICE_RE, "", regex=True)  # drop $, commas, quotes
        .replace({"": None})
        .astype(float)
    )
    return prices.where(prices >= min_valid)


def _parse_percent_series(series: pd.Series) -> pd.Series:
    """Convert a '%'-suffixed string column ('95%', '87.5%') to float 0–100."""
    return (
        series.astype(str)
        .str.replace("%", "", regex=False)
        .str.strip()
        .replace({"": None, "nan": None, "None": None, "null": None})
        .astype(float)
    )


def _extract_nights(raw: Any) -> int | None:
    """Pull the night count out of a listings.price_quote_raw JSON string.

    Preferred source is the description on the nightly_subtotal line item
    ("2 nights x €116.81").  Falls back to checkout − checkin.
    """
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return None

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return None

    quote = payload.get("quote") or {}

    # Preferred: description on the nightly_subtotal line item.
    for item in quote.get("raw_price_line_items") or []:
        if item.get("item_type") == "nightly_subtotal":
            desc = item.get("description") or ""
            m = _NIGHTS_RE.search(desc)
            if m:
                return int(m.group(1))

    # Fallback: checkout minus checkin.
    try:
        ci = quote.get("requested_checkin_date")
        co = quote.get("requested_checkout_date")
        if ci and co:
            nights = (date.fromisoformat(co) - date.fromisoformat(ci)).days
            if nights > 0:
                return nights
    except (TypeError, ValueError):
        pass

    return None


# ---------------------------------------------------------------------------
# Review cleaner
# ---------------------------------------------------------------------------

_BR_RE = re.compile(r"<\s*br\s*/?\s*>", re.IGNORECASE)
_P_CLOSE_RE = re.compile(r"</p\s*>", re.IGNORECASE)
_TAG_RE = re.compile(r"<[^>]+>")
_RUNS_OF_SPACE_RE = re.compile(r"[ \t]+")
_BLANK_LINES_RE = re.compile(r"\n{3,}")


def _clean_review(raw: Any) -> str:
    """Normalise an Airbnb review body.

    Airbnb stores reviews as HTML strings with ``<br/>`` separators.
    Convert those to real newlines, strip any remaining markup, and
    decode HTML entities so the text renders as plain prose.
    """
    if raw is None:
        return ""
    if isinstance(raw, float) and pd.isna(raw):
        return ""

    text = str(raw)

    # 1. Tags that imply a line break → real newline
    text = _BR_RE.sub("\n", text)
    text = _P_CLOSE_RE.sub("\n", text)

    # 2. Strip any other tag
    text = _TAG_RE.sub("", text)

    # 3. Decode entities (&amp; → &, &nbsp; → space, &quot; → ", ...)
    text = _html.unescape(text)

    # 4. Collapse runs of spaces (but preserve newlines)
    text = _RUNS_OF_SPACE_RE.sub(" ", text)

    # 5. Trim excessive blank lines
    text = _BLANK_LINES_RE.sub("\n\n", text)

    return text.strip()


# ---------------------------------------------------------------------------
# Stat categorisers (used by the verdict row in the template)
# ---------------------------------------------------------------------------


def _categorize_nights(avg_nights: float) -> str:
    if avg_nights < 2.5:
        return "Weekend stays"
    if avg_nights < 4.5:
        return "Short trips"
    if avg_nights < 7.5:
        return "Week-long"
    return "Extended stays"


def _categorize_occupancy(pct: float) -> str:
    if pct < 40:
        return "Slack"
    if pct < 60:
        return "Healthy"
    if pct < 75:
        return "Tight"
    return "Overheated"


def _categorize_multi_host(pct: float) -> str:
    if pct < 20:
        return "Mostly casual"
    if pct < 30:
        return "Casual"
    if pct < 50:
        return "Mixed"
    if pct < 60:
        return "Established"
    return "Commercial"


# ---------------------------------------------------------------------------
# Chart helpers
# ---------------------------------------------------------------------------


def _value_counts(series: pd.Series, *, top: int | None = None) -> dict:
    s = series.astype(str).str.strip().replace({"": None, "nan": None}).dropna()
    if not len(s):
        return {"labels": [], "values": []}
    vc = s.value_counts()
    if top is not None and len(vc) > top:
        head = vc.iloc[:top]
        other = int(vc.iloc[top:].sum())
        head = pd.concat([head, pd.Series({"Other": other})])
        vc = head
    return {"labels": vc.index.tolist(), "values": [int(v) for v in vc.values]}


def _bucket_accommodates(series: pd.Series) -> dict:
    n = pd.to_numeric(series, errors="coerce").dropna().astype(int)
    if not len(n):
        return {"labels": [], "values": []}
    n = n.clip(upper=7)
    vc = n.value_counts().sort_index()
    labels = [str(i) if i < 7 else "7+" for i in vc.index]
    return {"labels": labels, "values": [int(v) for v in vc.values]}


def _bucket_bedrooms(series: pd.Series) -> dict:
    n = pd.to_numeric(series, errors="coerce").dropna().astype(int)
    if not len(n):
        return {"labels": [], "values": []}
    n = n.clip(lower=0, upper=5)
    vc = n.value_counts().sort_index()
    labels = ["Studio" if i == 0 else (str(i) if i < 5 else "5+") for i in vc.index]
    return {"labels": labels, "values": [int(v) for v in vc.values]}


def _box_stats(
    series: pd.Series,
    *,
    digits: int = 2,
    whisker_iqr: float = 1.5,
) -> dict[str, float] | None:
    """Five-number summary for a box plot.

    * ``digits`` rounds every statistic uniformly — 0 for prices, 2 for
      scores, 1 for nights / percentages.
    * ``whisker_iqr`` is Tukey's multiplier.  1.5 is standard; anything
      outside ``[q1 − k·IQR, q3 + k·IQR]`` is treated as an outlier and
      excluded from the whisker extent.
    """
    v = pd.to_numeric(series, errors="coerce").dropna()
    if not len(v):
        return None

    q1 = float(v.quantile(0.25))
    med = float(v.quantile(0.50))
    q3 = float(v.quantile(0.75))
    iqr = q3 - q1

    lo_mask = v >= (q1 - whisker_iqr * iqr)
    hi_mask = v <= (q3 + whisker_iqr * iqr)
    lo = float(v[lo_mask].min()) if lo_mask.any() else q1
    hi = float(v[hi_mask].max()) if hi_mask.any() else q3

    def r(x):
        return round(x, digits)

    return {"min": r(lo), "q1": r(q1), "median": r(med), "q3": r(q3), "max": r(hi)}


def _distribution(
    series: pd.Series,
    *,
    bins: int = 20,
    upper_q: float = 0.99,
    log: bool = False,
    prefix: str = "",
    suffix: str = "",
) -> dict:
    """Histogram for a numeric column.

    * ``upper_q`` clips the extreme right tail (a single $50k/night listing
      would otherwise squash the rest into one pixel).
    * ``log=True`` bins log₁₀ of the values — for money metrics that span
      several orders of magnitude.  The median is returned in **original
      units**, not log units.
    * ``prefix`` / ``suffix`` decorate the axis labels (e.g. ``"$"`` / ``"y"``).
    """
    v = pd.to_numeric(series, errors="coerce").dropna()

    if log:
        v = v[v > 0]
        if not len(v):
            return {"labels": [], "values": [], "median": None}
        v = np.log10(v)

    if not len(v):
        return {"labels": [], "values": [], "median": None}

    upper = float(v.quantile(upper_q))
    v = v[v <= upper]
    if not len(v):
        return {"labels": [], "values": [], "median": None}

    counts, edges = np.histogram(v, bins=bins)

    if log:
        labels = [f"{prefix}{10**e:,.0f}{suffix}" for e in edges]
        median_value = float(10 ** v.median())  # back to original units
    else:
        labels = [f"{prefix}{e:,.0f}{suffix}" for e in edges]
        median_value = float(v.median())

    return {"labels": labels, "values": counts.tolist(), "median": median_value}


# ---------------------------------------------------------------------------
# Per-city headline stats + analytics
# ---------------------------------------------------------------------------


def compute_city_stats(city) -> dict[str, Any]:
    """Return headline numbers for a city, read from the local listings.csv.gz.

    One file read powers:

      * the six-card snapshot (listings, avg price, currency, nights,
        occupancy, multi-host) with their mini box plots
      * the three analytics readouts (12-month reviews, hottest
        neighbourhood, median booking lead time)
      * the booking lead-time histogram (bottom-right cell)

    Cached against the file's mtime, so a fresh ``sync_datasets`` run
    invalidates automatically.
    """
    _, filename = KINDS["listings"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0
    cache_key = f"city_stats:{city.city_slug}:{mtime}"
    cached = cache.get(cache_key)
    if cached is not None:
        return cached

    currency = getattr(city.country, "currency", None)

    stats: dict[str, Any] = {
        # snapshot
        "n_listings": None,
        "avg_price_usd": None,
        "avg_price_local": None,
        "avg_night_stays": None,
        "currency_code": currency.code if currency else None,
        "occupancy_rate": None,
        "multi_listing_share": None,
        "nights_label": None,
        "occupancy_label": None,
        "multi_listing_label": None,
        # analytics readouts
        "reviews_12m": None,
        "top_neighbourhood": {"name": None, "count": None},
        "median_lead_days": None,
        # bottom-right cell
        "lead_time_hist": {"labels": [], "values": [], "median": None},
        # mini box plots (snapshot cards)
        "box_nights": None,
        "box_occupancy": None,
        "box_multi_host": None,
    }

    if mtime:
        try:
            wanted = {
                # snapshot
                "id",
                "price",
                "price_quote_raw",
                "estimated_occupancy_l365d",
                "calculated_host_listings_count",
                # analytics readouts
                "number_of_reviews_ltm",
                "neighbourhood_cleansed",
                "last_scraped",
                "price_quote_checkin_date",
            }
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                df = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            stats["n_listings"] = len(df)

            # --- avg price (in USD + local) ---------------------------
            if currency and "price" in df.columns:
                rate = float(currency.value_usd)
                if rate > 0:
                    prices = _parse_price_series(df["price"]).dropna()
                    if len(prices):
                        stats["avg_price_usd"] = float((prices / rate).mean())
                        stats["avg_price_local"] = float(prices.mean())

            # --- avg nights stayed (+ box) ----------------------------
            if "price_quote_raw" in df.columns:
                nights = df["price_quote_raw"].map(_extract_nights).dropna()
                if len(nights):
                    avg = float(nights.mean())
                    stats["avg_night_stays"] = avg
                    stats["nights_label"] = _categorize_nights(avg)
                    stats["box_nights"] = _box_stats(nights, digits=1)

            # --- occupancy rate (+ box) -------------------------------
            if "estimated_occupancy_l365d" in df.columns:
                occ = pd.to_numeric(
                    df["estimated_occupancy_l365d"], errors="coerce"
                ).dropna()
                if len(occ):
                    pct = float(occ.mean() / 365 * 100)
                    stats["occupancy_rate"] = pct
                    stats["occupancy_label"] = _categorize_occupancy(pct)
                    stats["box_occupancy"] = _box_stats(occ / 365 * 100, digits=1)

            # --- multi-listing host share (+ box) ---------------------
            if "calculated_host_listings_count" in df.columns:
                cnt = pd.to_numeric(
                    df["calculated_host_listings_count"], errors="coerce"
                ).dropna()
                if len(cnt):
                    share = float((cnt > 1).mean() * 100)
                    stats["multi_listing_share"] = share
                    stats["multi_listing_label"] = _categorize_multi_host(share)
                    stats["box_multi_host"] = _box_stats(cnt, digits=1)

            # --- reviews · 12m (Airbnb's own column) ------------------
            if "number_of_reviews_ltm" in df.columns:
                n = pd.to_numeric(df["number_of_reviews_ltm"], errors="coerce").dropna()
                if len(n):
                    stats["reviews_12m"] = int(n.sum())

            # --- hottest neighbourhood --------------------------------
            if "neighbourhood_cleansed" in df.columns:
                vc = df["neighbourhood_cleansed"].dropna().value_counts()
                if len(vc):
                    stats["top_neighbourhood"] = {
                        "name": str(vc.index[0]),
                        "count": int(vc.iloc[0]),
                    }

            # --- median booking lead time + histogram -----------------
            if {"last_scraped", "price_quote_checkin_date"} <= set(df.columns):
                scraped = pd.to_datetime(df["last_scraped"], errors="coerce")
                checkin = pd.to_datetime(
                    df["price_quote_checkin_date"], errors="coerce"
                )
                lead = (checkin - scraped).dt.days.dropna()
                lead = lead[lead >= 0]
                if len(lead):
                    stats["median_lead_days"] = int(lead.median())
                    stats["lead_time_hist"] = _distribution(
                        lead, bins=12, upper_q=0.98, suffix="d"
                    )

        except Exception:
            logger.exception("Failed computing stats for %s", city.city_slug)

    cache.set(cache_key, stats, CITY_STATS_CACHE_SECONDS)
    return stats


# ---------------------------------------------------------------------------
# Per-city chart aggregates (Listings accordion)
# ---------------------------------------------------------------------------


def compute_city_charts(city) -> dict[str, Any]:
    """Pre-aggregated series for the Listings accordion."""
    _, filename = KINDS["listings"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0
    key = f"city_charts:v{CHART_CACHE_VERSION}:{city.city_slug}:{mtime}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    currency = getattr(city.country, "currency", None)

    empty_dist = {"labels": [], "values": [], "median": None}

    result: dict[str, Any] = {
        "distributions": {
            "price": dict(empty_dist, title="Nightly price · USD"),
            "revenue": dict(empty_dist, title="Estimated revenue · 365 d"),
            "reviews": dict(empty_dist, title="Reviews per listing"),
            "occupancy": dict(empty_dist, title="Occupancy · days / 365"),
            "host_listings": dict(empty_dist, title="Listings per host"),
        },
        "room_type": {"labels": [], "values": []},
        "property_type": {"labels": [], "values": []},
        "max_occupants": {"labels": [], "values": []},
    }

    if mtime:
        try:
            wanted = {
                "price",
                "estimated_revenue_l365d",
                "number_of_reviews",
                "estimated_occupancy_l365d",
                "host_listings_count",
                "room_type",
                "property_type",
                "accommodates",
            }
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                df = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            # ── distributions ───────────────────────────────────────
            if currency and "price" in df.columns:
                rate = float(currency.value_usd)
                if rate > 0:
                    usd = _parse_price_series(df["price"]).dropna() / rate
                    result["distributions"]["price"] = {
                        **_distribution(usd, prefix="$"),
                        "title": "Nightly price · USD",
                    }

            if "estimated_revenue_l365d" in df.columns:
                rev = pd.to_numeric(
                    df["estimated_revenue_l365d"], errors="coerce"
                ).dropna()
                result["distributions"]["revenue"] = {
                    **_distribution(rev, log=True, prefix="$"),
                    "title": "Estimated revenue · 365 d",
                }

            if "number_of_reviews" in df.columns:
                revs = pd.to_numeric(df["number_of_reviews"], errors="coerce").dropna()
                result["distributions"]["reviews"] = {
                    **_distribution(revs),
                    "title": "Reviews per listing",
                }

            if "estimated_occupancy_l365d" in df.columns:
                occ = pd.to_numeric(
                    df["estimated_occupancy_l365d"], errors="coerce"
                ).dropna()
                result["distributions"]["occupancy"] = {
                    **_distribution(occ),
                    "title": "Occupancy · days / 365",
                }

            if "host_listings_count" in df.columns:
                hlc = pd.to_numeric(df["host_listings_count"], errors="coerce").dropna()
                result["distributions"]["host_listings"] = {
                    **_distribution(hlc, log=True),  # no $ — it's a count
                    "title": "Listings per host",
                }

            # ── room type ──────────────────────────────────────────
            if "room_type" in df.columns:
                result["room_type"] = _value_counts(df["room_type"])

            # ── property type ──────────────────────────────────────
            if "property_type" in df.columns:
                result["property_type"] = _value_counts(
                    df["property_type"].str.replace(
                        "Private room in bed and breakfast",
                        "Private room in bnb",
                    ),
                    top=8,
                )

            # ── max occupants (merged bedrooms + accommodates) ─────
            if "accommodates" in df.columns:
                result["max_occupants"] = _bucket_accommodates(df["accommodates"])

        except Exception:
            logger.exception("charts failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Per-city host leaderboard (Hosts accordion)
# ---------------------------------------------------------------------------


def _host_metric_fallback(df: pd.DataFrame) -> dict[str, Any]:
    """Pick the best-populated host-related distribution to display.

    The acceptance-rate column is systematically empty across cities, so
    it's skipped entirely.  Ladder:

      1. hosts_time_as_user_years — host tenure
      2. host_listings_count      — portfolio size (log-scaled)
      3. unavailable
    """
    total = len(df)
    if not total:
        return {"status": "unavailable", "title": "Host metric", "note": "no data"}

    def coverage(col: str) -> float:
        if col not in df.columns:
            return 0.0
        return float(df[col].notna().sum()) / total

    # 1 — host tenure (years since joining Airbnb)
    if coverage("hosts_time_as_user_years") >= 0.50:
        y = pd.to_numeric(df["hosts_time_as_user_years"], errors="coerce").dropna()
        y = y[(y >= 0) & (y <= 30)]
        if len(y) >= 50:
            d = _distribution(y, bins=15, upper_q=0.99, suffix="y")
            d.update(
                {
                    "status": "ok",
                    "title": "Host tenure",
                    "subtitle": "years since joining Airbnb",
                    "mean": round(float(y.mean()), 1),
                    "non_null": len(y),
                    "total": total,
                    "note": f"μ {round(float(y.mean()), 1)}y  ·  {len(y):,} hosts",
                }
            )
            return d

    # 2 — portfolio size (listings per host, log-scaled)
    if coverage("host_listings_count") >= 0.50:
        n = pd.to_numeric(df["host_listings_count"], errors="coerce").dropna()
        n = n[n >= 1]
        if len(n) >= 50:
            d = _distribution(n, bins=15, upper_q=0.99, log=True)
            d.update(
                {
                    "status": "ok",
                    "title": "Portfolio size",
                    "subtitle": "listings per host (log scale)",
                    "mean": round(float(n.mean()), 1),
                    "non_null": len(n),
                    "total": total,
                    "note": f"μ {round(float(n.mean()), 1)}  ·  {len(n):,} hosts",
                }
            )
            return d

    # 3 — nothing usable
    return {
        "status": "unavailable",
        "title": "Host metric",
        "subtitle": "no host data available for this city",
        "note": "unavailable",
    }


def compute_city_hosts(city, *, top_n: int = 50) -> dict[str, Any]:
    """Per-host leaderboard plus two host-behaviour distributions.

    Reads the listings file (leaderboard + secondary host metric + portfolio
    split) and, if the calendar file is cached, computes a host-blocked-days
    histogram from calendar + occupancy.
    """
    _, filename = KINDS["listings"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0

    # Include calendar mtime so a fresh calendar sync invalidates the cache
    _, cal_filename = KINDS["calendar"]
    cal_path = _path_for(city, cal_filename)
    cal_mtime = int(cal_path.stat().st_mtime) if cal_path.exists() else 0

    key = f"city_hosts:v{CHART_CACHE_VERSION}:{city.city_slug}:{mtime}:{cal_mtime}:{top_n}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    currency = getattr(city.country, "currency", None)

    empty_dist = {"labels": [], "values": [], "median": None}

    result: dict[str, Any] = {
        "summary": {"total_hosts": 0, "superhost_count": 0},
        "rows": [],
        # "acceptance" is kept as the cache key for template/JS compatibility.
        # It now carries whichever fallback metric was chosen.
        "acceptance": {
            "status": "unavailable",
            "title": "Host metric",
            "note": "",
        },
        # portfolio split — bottom-right cell
        "portfolio_split": {"labels": [], "values": []},
        "blocked": dict(
            empty_dist,
            status="pending",
            message=(
                "Calendar data not downloaded. Run:\n"
                f"  python manage.py sync_datasets --city {city.city_slug} --kind calendar"
            ),
        ),
    }

    # ── Listings file: leaderboard + fallback host metric ────────────
    if mtime:
        try:
            wanted = {
                "id",
                "host_id",
                "host_name",
                "host_picture_url",
                "host_is_superhost",
                "review_scores_rating",
                "price",
                "estimated_revenue_l365d",
                "hosts_time_as_user_years",
                "host_listings_count",
            }
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                df = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            if "host_id" not in df.columns:
                raise ValueError("listings file has no host_id column")

            # ── column normalisation ──────────────────────────────
            df["_price_num"] = (
                _parse_price_series(df["price"])
                if "price" in df.columns
                else pd.Series([pd.NA] * len(df))
            )
            df["_is_super"] = (
                df["host_is_superhost"].astype(str).str.lower().isin(["t", "true"])
                if "host_is_superhost" in df.columns
                else False
            )
            df["_rating"] = (
                pd.to_numeric(df["review_scores_rating"], errors="coerce")
                if "review_scores_rating" in df.columns
                else pd.Series([pd.NA] * len(df))
            )
            df["_revenue"] = (
                pd.to_numeric(df["estimated_revenue_l365d"], errors="coerce")
                if "estimated_revenue_l365d" in df.columns
                else pd.Series([pd.NA] * len(df))
            )

            # ── summary ──────────────────────────────────────────
            total_hosts = int(df["host_id"].nunique())
            superhost_count = int(
                df.groupby("host_id", dropna=True)["_is_super"].first().sum()
            )

            # ── per-host aggregation ─────────────────────────────
            agg = (
                df.groupby("host_id", dropna=True)
                .agg(
                    host_name=("host_name", "first"),
                    host_picture_url=("host_picture_url", "first"),
                    listing_count=("id", "count"),
                    avg_rating=("_rating", "mean"),
                    avg_price=("_price_num", "mean"),
                    total_revenue=("_revenue", "sum"),
                    is_superhost=("_is_super", "first"),
                )
                .reset_index()
                .sort_values("listing_count", ascending=False)
                .head(top_n)
            )

            rate = float(currency.value_usd) if currency else 1.0
            if rate <= 0:
                rate = 1.0

            rows: list[dict[str, Any]] = []
            for _, r in agg.iterrows():
                rows.append(
                    {
                        "host_name": (
                            str(r["host_name"]) if pd.notna(r["host_name"]) else "Host"
                        ),
                        "host_picture_url": (
                            str(r["host_picture_url"])
                            if pd.notna(r["host_picture_url"])
                            else None
                        ),
                        "is_superhost": bool(r["is_superhost"]),
                        "listing_count": int(r["listing_count"]),
                        "avg_rating": (
                            round(float(r["avg_rating"]), 2)
                            if pd.notna(r["avg_rating"])
                            else None
                        ),
                        "avg_price": (
                            round(float(r["avg_price"]) / rate, 2)
                            if pd.notna(r["avg_price"])
                            else None
                        ),
                        "total_revenue": (
                            float(r["total_revenue"])
                            if pd.notna(r["total_revenue"])
                            else None
                        ),
                    }
                )

            result["summary"] = {
                "total_hosts": total_hosts,
                "superhost_count": superhost_count,
            }
            result["rows"] = rows

            # ── fallback host metric (tenure → portfolio → unavailable) ──
            result["acceptance"] = _host_metric_fallback(df)

            # ── portfolio split (listings per host) ──────────────
            if "host_listings_count" in df.columns:
                per_host = (
                    df.groupby("host_id", dropna=True)["host_listings_count"]
                    .first()
                    .dropna()
                )
                if len(per_host):
                    buckets = pd.cut(
                        per_host,
                        bins=[0, 1, 5, 20, float("inf")],
                        labels=["1", "2–5", "6–20", "21+"],
                        include_lowest=True,
                    )
                    vc = (
                        buckets.value_counts().reindex(buckets.cat.categories).fillna(0)
                    )
                    result["portfolio_split"] = {
                        "labels": vc.index.tolist(),
                        "values": [int(v) for v in vc.values],
                    }

        except Exception:
            logger.exception("host leaderboard failed for %s", city.city_slug)

    # ── Calendar file: host-blocked-days histogram ────────────────────
    if cal_mtime and mtime:
        try:
            with gzip.open(cal_path, "rt", encoding="utf-8", errors="replace") as fh:
                cal = pd.read_csv(
                    fh,
                    usecols=lambda c: c in {"listing_id", "available"},
                    low_memory=False,
                    on_bad_lines="skip",
                )

            if {"listing_id", "available"} <= set(cal.columns):
                unavailable = (
                    cal.assign(_unavail=(cal["available"] == "f").astype(int))
                    .groupby("listing_id", dropna=True)["_unavail"]
                    .sum()
                    .rename("unavailable_days")
                    .reset_index()
                )

                with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                    lst = pd.read_csv(
                        fh,
                        usecols=lambda c: c in {"id", "estimated_occupancy_l365d"},
                        low_memory=False,
                        on_bad_lines="skip",
                    )

                if "estimated_occupancy_l365d" in lst.columns:
                    merged = unavailable.merge(
                        lst, left_on="listing_id", right_on="id", how="inner"
                    )
                    booked = pd.to_numeric(
                        merged["estimated_occupancy_l365d"], errors="coerce"
                    ).fillna(0)
                    blocked = (merged["unavailable_days"] - booked).clip(lower=0)
                    blocked = blocked.dropna()

                    if len(blocked):
                        result["blocked"] = _distribution(
                            blocked, bins=20, upper_q=0.99
                        )
                        result["blocked"]["status"] = "ok"
                        result["blocked"]["mean"] = round(float(blocked.mean()), 1)
                        result["blocked"]["sample"] = len(blocked)

        except Exception:
            logger.exception("blocked-days failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Per-city reviews aggregates (Reviews accordion)
# ---------------------------------------------------------------------------


def compute_city_reviews(city) -> dict[str, Any]:
    """Aggregate reviews data + review-score box plots for the Reviews accordion.

    One read of reviews.csv.gz produces:
      * per-year monthly counts (for the year-filtered line chart)
      * the top 20 longest reviews per year

    One read of listings.csv.gz produces:
      * the seven review-score box plots + the avg rating card
    """
    _, filename = KINDS["reviews"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0
    key = f"city_reviews:v{CHART_CACHE_VERSION}:{city.city_slug}:{mtime}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    MONTHS = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
    ]

    result: dict[str, Any] = {
        "years": [],
        "year_counts": {},
        "monthly_by_year": {},
        "review_boxes": [],
        "cards": {
            "total_reviews": 0,
            "avg_rating": None,
            "avg_length": 0,
            "median_length": 0,
        },
        "top_reviews_by_year": {},
    }

    # ── Reviews file: time series + top 20 by year ────────────────────
    if mtime:
        try:
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                df = pd.read_csv(
                    fh,
                    usecols=["date", "comments"],
                    low_memory=False,
                    on_bad_lines="skip",
                )

            df["date"] = pd.to_datetime(df["date"], errors="coerce")
            df = df.dropna(subset=["date"])
            df["year"] = df["date"].dt.year.astype(str)
            df["month"] = df["date"].dt.month

            # Clean once; both the ranking and the card stats use the
            # cleaned text so lengths shown to the user are honest.
            df["_clean"] = df["comments"].map(_clean_review)
            df["len"] = df["_clean"].str.len()

            years = sorted(df["year"].unique(), reverse=True)
            result["years"] = years

            for year in years:
                dfy = df[df["year"] == year]
                result["year_counts"][year] = len(dfy)

                monthly = (
                    dfy.groupby("month").size().reindex(range(1, 13), fill_value=0)
                )
                result["monthly_by_year"][year] = {
                    "labels": MONTHS,
                    "values": [int(v) for v in monthly.values],
                }

                # top 20 longest reviews for this year (by cleaned length)
                top = dfy.nlargest(20, "len")
                rows: list[dict[str, Any]] = []
                for _, r in top.iterrows():
                    text = str(r["_clean"])[:1000]
                    if not text.strip():
                        continue
                    rows.append(
                        {
                            "text": text,
                            "length": int(r["len"]),
                            "date": r["date"].strftime("%Y-%m-%d"),
                        }
                    )
                result["top_reviews_by_year"][year] = rows

            # cards
            result["cards"]["total_reviews"] = len(df)
            lengths = df["len"]
            if len(lengths):
                result["cards"]["avg_length"] = int(lengths.mean())
                result["cards"]["median_length"] = int(lengths.median())

        except Exception:
            logger.exception("reviews aggregation failed for %s", city.city_slug)

    # ── Listings file: review score box plots + avg rating card ──────
    _, listings_file = KINDS["listings"]
    listings_path = _path_for(city, listings_file)

    if listings_path.exists():
        try:
            review_spec = [
                ("rating", "Overall"),
                ("accuracy", "Accuracy"),
                ("cleanliness", "Cleanliness"),
                ("checkin", "Check-in"),
                ("communication", "Comms"),
                ("location", "Location"),
                ("value", "Value"),
            ]
            wanted = {f"review_scores_{k}" for k, _ in review_spec}

            with gzip.open(
                listings_path, "rt", encoding="utf-8", errors="replace"
            ) as fh:
                ldf = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            boxes: list[dict[str, Any]] = []
            for key_name, label in review_spec:
                col = f"review_scores_{key_name}"
                if col not in ldf.columns:
                    continue
                s = pd.to_numeric(ldf[col], errors="coerce").dropna()
                stats = _box_stats(s, digits=2)
                if stats:
                    boxes.append({"dim": label, **stats})
                    if key_name == "rating":
                        result["cards"]["avg_rating"] = stats["median"]

            result["review_boxes"] = boxes

        except Exception:
            logger.exception("review boxes failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Per-city availability aggregates (Availability accordion)
# ---------------------------------------------------------------------------


def compute_city_availability(city) -> dict[str, Any]:
    """KPI cards (listings) + forward-calendar aggregates (calendar).

    Returns:
      * ``cards``               — mean availability_30/60/90/365 + has_avail %
      * ``weekday``             — availability fraction per day of week
      * ``min_nights_by_month`` — median minimum_nights per upcoming month
      * ``heatmap``             — one {date, available} row per calendar date
      * ``calendar_status``     — "ok" if calendar was read, else "pending"
    """
    _, listings_file = KINDS["listings"]
    listings_path = _path_for(city, listings_file)
    listing_mtime = int(listings_path.stat().st_mtime) if listings_path.exists() else 0

    _, cal_file = KINDS["calendar"]
    cal_path = _path_for(city, cal_file)
    cal_mtime = int(cal_path.stat().st_mtime) if cal_path.exists() else 0

    key = (
        f"city_availability:v{CHART_CACHE_VERSION}:"
        f"{city.city_slug}:{listing_mtime}:{cal_mtime}"
    )
    cached = cache.get(key)
    if cached is not None:
        return cached

    result: dict[str, Any] = {
        "cards": {
            "availability_30": None,
            "availability_60": None,
            "availability_90": None,
            "availability_365": None,
            "has_availability_pct": None,
        },
        "weekday": {"labels": [], "values": []},
        "min_nights_by_month": {"labels": [], "values": []},
        "heatmap": [],
        "calendar_status": "pending",
    }

    # ── Listings file: KPI cards ─────────────────────────────────────
    if listing_mtime:
        try:
            wanted = {
                "availability_30",
                "availability_60",
                "availability_90",
                "availability_365",
                "has_availability",
            }
            with gzip.open(
                listings_path, "rt", encoding="utf-8", errors="replace"
            ) as fh:
                df = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            for k in (
                "availability_30",
                "availability_60",
                "availability_90",
                "availability_365",
            ):
                if k in df.columns:
                    v = pd.to_numeric(df[k], errors="coerce").dropna()
                    if len(v):
                        result["cards"][k] = round(float(v.mean()), 1)

            if "has_availability" in df.columns:
                h = df["has_availability"].astype(str).str.lower()
                valid = h.isin(["t", "true", "f", "false"])
                if valid.any():
                    pct = h[valid].isin(["t", "true"]).mean() * 100
                    result["cards"]["has_availability_pct"] = round(float(pct), 1)

        except Exception:
            logger.exception("availability cards failed for %s", city.city_slug)

    # ── Calendar file: weekday / min-nights / heatmap ─────────────────
    if cal_mtime:
        try:
            wanted = {"date", "available", "minimum_nights"}
            with gzip.open(cal_path, "rt", encoding="utf-8", errors="replace") as fh:
                cal = pd.read_csv(
                    fh,
                    usecols=lambda c: c in wanted,
                    low_memory=False,
                    on_bad_lines="skip",
                )

            cal["date"] = pd.to_datetime(cal["date"], errors="coerce")
            cal = cal.dropna(subset=["date"])

            if len(cal):
                cal["_avail"] = (
                    cal["available"].astype(str).str.lower() == "t"
                ).astype(int)
                cal["_dow"] = cal["date"].dt.dayofweek

                # ── weekday rhythm ─────────────────────────────────
                dow = (
                    cal.groupby("_dow")["_avail"].mean().reindex(range(7), fill_value=0)
                )
                DOW_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
                result["weekday"] = {
                    "labels": DOW_LABELS,
                    "values": [round(float(v), 3) for v in dow.values],
                }

                # ── min nights by month (median) ───────────────────
                if "minimum_nights" in cal.columns:
                    cal["_min"] = pd.to_numeric(cal["minimum_nights"], errors="coerce")
                    cal["_ym"] = cal["date"].dt.to_period("M")
                    monthly = (
                        cal.groupby("_ym")["_min"]
                        .median()
                        .dropna()
                        .sort_index()
                        .head(12)
                    )
                    if len(monthly):
                        result["min_nights_by_month"] = {
                            "labels": [p.strftime("%b '%y") for p in monthly.index],
                            "values": [round(float(v), 1) for v in monthly.values],
                        }

                # ── heatmap ────────────────────────────────────────
                heat = cal.groupby("date")["_avail"].mean().sort_index()
                result["heatmap"] = [
                    {
                        "date": d.strftime("%Y-%m-%d"),
                        "available": round(float(v), 3),
                    }
                    for d, v in heat.items()
                ]

                result["calendar_status"] = "ok"

        except Exception:
            logger.exception("availability calendar failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Per-city superlatives (bottom-row editorial strip)
# ---------------------------------------------------------------------------


def compute_city_superlatives(city, *, min_listings: int = 15) -> dict[str, Any]:
    """Editorial superlatives plus a full neighbourhood metric table.

    ``items`` (superlatives) are filtered to neighbourhoods with at least
    *min_listings* listings, so tiny areas can't win categories.

    ``neighbourhoods`` (used by the leaderboard *and* the map choropleth)
    is unfiltered — every neighbourhood in the listings file is emitted
    with all six metrics so the map has something to shade everywhere.
    """
    _, filename = KINDS["listings"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0
    key = (
        f"city_superlatives:v{CHART_CACHE_VERSION}:"
        f"{city.city_slug}:{mtime}:{min_listings}"
    )
    cached = cache.get(key)
    if cached is not None:
        return cached

    currency = getattr(city.country, "currency", None)

    result: dict[str, Any] = {
        "items": [],
        "neighbourhoods": [],
        "min_listings": min_listings,
    }

    if not mtime:
        cache.set(key, result, CHART_CACHE_SECONDS)
        return result

    try:
        wanted = {
            "neighbourhood_cleansed",
            "price",
            "review_scores_rating",
            "estimated_occupancy_l365d",
            "price_quote_raw",
            "calculated_host_listings_count",
        }
        with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
            df = pd.read_csv(
                fh,
                usecols=lambda c: c in wanted,
                low_memory=False,
                on_bad_lines="skip",
            )

        if "neighbourhood_cleansed" not in df.columns:
            cache.set(key, result, CHART_CACHE_SECONDS)
            return result

        # ── normalise ────────────────────────────────────────────────
        df["_hood"] = df["neighbourhood_cleansed"].astype(str).str.strip()
        df = df[df["_hood"].notna() & (df["_hood"] != "") & (df["_hood"] != "nan")]

        df["_price"] = (
            _parse_price_series(df["price"])
            if "price" in df.columns
            else pd.Series([pd.NA] * len(df))
        )
        df["_rating"] = (
            pd.to_numeric(df["review_scores_rating"], errors="coerce")
            if "review_scores_rating" in df.columns
            else pd.Series([pd.NA] * len(df))
        )
        df["_occ"] = (
            pd.to_numeric(df["estimated_occupancy_l365d"], errors="coerce")
            if "estimated_occupancy_l365d" in df.columns
            else pd.Series([pd.NA] * len(df))
        )
        df["_nights"] = (
            df["price_quote_raw"].map(_extract_nights).astype(float)
            if "price_quote_raw" in df.columns
            else pd.Series([pd.NA] * len(df))
        )
        df["_multi"] = (
            pd.to_numeric(df["calculated_host_listings_count"], errors="coerce")
            if "calculated_host_listings_count" in df.columns
            else pd.Series([pd.NA] * len(df))
        )

        # ── per-neighbourhood aggregation (unfiltered) ───────────────
        agg = df.groupby("_hood").agg(
            n=("_hood", "size"),
            avg_price=("_price", "mean"),
            avg_rating=("_rating", "mean"),
            avg_occ=("_occ", "mean"),
            avg_nights=("_nights", "mean"),
            multi_share=("_multi", lambda s: (s > 1).mean() * 100),
        )

        if not len(agg):
            cache.set(key, result, CHART_CACHE_SECONDS)
            return result

        rate = float(currency.value_usd) if currency else 1.0
        if rate <= 0:
            rate = 1.0

        def _num(v, digits=2):
            return round(float(v), digits) if pd.notna(v) else None

        # ── FULL neighbourhood table (map + leaderboard) ─────────────
        # Emitted for every neighbourhood regardless of size so the
        # choropleth has a value to shade everywhere.
        result["neighbourhoods"] = [
            {
                "name": str(idx),
                "count": int(row["n"]),
                "avg_price_usd": (
                    round(float(row["avg_price"] / rate), 2)
                    if pd.notna(row["avg_price"])
                    else None
                ),
                "avg_rating": _num(row["avg_rating"], 2),
                "avg_occ_pct": _num(row["avg_occ"] / 365 * 100, 1),
                "avg_nights": _num(row["avg_nights"], 1),
                "multi_share": _num(row["multi_share"], 1),
            }
            for idx, row in agg.iterrows()
        ]

        # ── superlatives operate on the threshold-filtered subset ────
        big = agg[agg["n"] >= min_listings]
        if not len(big):
            cache.set(key, result, CHART_CACHE_SECONDS)
            return result

        def fmt_price(v: float) -> str:
            return f"${v:,.0f}" if pd.notna(v) else "—"

        def fmt_rating(v: float) -> str:
            return f"{v:.2f}" if pd.notna(v) else "—"

        def fmt_pct(v: float) -> str:
            return f"{v:.0f}%" if pd.notna(v) else "—"

        def fmt_nights(v: float) -> str:
            return f"{v:.1f}n" if pd.notna(v) else "—"

        items: list[dict[str, Any]] = []

        # 💲⬇️  Cheapest
        if big["avg_price"].notna().any():
            idx = (big["avg_price"] / rate).idxmin()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "💲⬇️",
                    "label": "Cheapest",
                    "metric": "price_asc",
                    "name": str(idx),
                    "value": fmt_price(row["avg_price"] / rate),
                }
            )

        # 💰  Priciest
        if big["avg_price"].notna().any():
            idx = (big["avg_price"] / rate).idxmax()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "💰",
                    "label": "Priciest",
                    "metric": "price_desc",
                    "name": str(idx),
                    "value": fmt_price(row["avg_price"] / rate),
                }
            )

        # ⭐ Best rated
        if big["avg_rating"].notna().any():
            idx = big["avg_rating"].idxmax()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "⭐",
                    "label": "Best rated",
                    "metric": "rating",
                    "name": str(idx),
                    "value": fmt_rating(row["avg_rating"]),
                }
            )

        # 🔥 Busiest (occupancy as % of the year)
        if big["avg_occ"].notna().any():
            idx = big["avg_occ"].idxmax()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "🔥",
                    "label": "Busiest",
                    "metric": "occupancy",
                    "name": str(idx),
                    "value": fmt_pct(row["avg_occ"] / 365 * 100),
                }
            )

        # 🌙 Longest stay
        if big["avg_nights"].notna().any():
            idx = big["avg_nights"].idxmax()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "🌙",
                    "label": "Longest stay",
                    "metric": "nights",
                    "name": str(idx),
                    "value": fmt_nights(row["avg_nights"]),
                }
            )

        # ⚡ Most commercial
        if big["multi_share"].notna().any():
            idx = big["multi_share"].idxmax()
            row = big.loc[idx]
            items.append(
                {
                    "icon": "⚡",
                    "label": "Most commercial",
                    "metric": "commercial",
                    "name": str(idx),
                    "value": fmt_pct(row["multi_share"]),
                }
            )

        result["items"] = items

    except Exception:
        logger.exception("superlatives failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Per-city amenities (bottom-row middle cell)
# ---------------------------------------------------------------------------

_AMENITY_SPLIT_TOKENS = (" – ", " — ", " - ", ", ")


def _parse_amenities_cell(raw: Any) -> list[str]:
    """The amenities column is a stringified Python/JSON list.

    Returns the clean amenity tokens with any trailing modifiers stripped:
        "Free washer – In unit"                    → "Free washer"
        "Fast wifi – 203 Mbps"                     → "Fast wifi"
        "Shared indoor pool - available all year"  → "Shared indoor pool"
    """
    if raw is None or (isinstance(raw, float) and pd.isna(raw)):
        return []

    try:
        payload = json.loads(raw)
    except (TypeError, ValueError):
        return []

    if not isinstance(payload, list):
        return []

    out: list[str] = []
    for item in payload:
        s = str(item).strip()
        if not s:
            continue
        for sep in _AMENITY_SPLIT_TOKENS:
            if sep in s:
                s = s.split(sep, 1)[0].strip()
                break
        if s and len(s) <= 60:
            out.append(s)
    return out


def compute_city_amenities(city, *, top_n: int = 15) -> dict[str, Any]:
    """Top amenities by coverage across the city's listings."""
    _, filename = KINDS["listings"]
    path = _path_for(city, filename)

    mtime = int(path.stat().st_mtime) if path.exists() else 0
    key = f"city_amenities:v{CHART_CACHE_VERSION}:{city.city_slug}:{mtime}:{top_n}"
    cached = cache.get(key)
    if cached is not None:
        return cached

    result: dict[str, Any] = {
        "items": [],  # [{label, count, pct}]
        "total": 0,
    }

    if mtime:
        try:
            with gzip.open(path, "rt", encoding="utf-8", errors="replace") as fh:
                df = pd.read_csv(
                    fh,
                    usecols=lambda c: c == "amenities",
                    low_memory=False,
                    on_bad_lines="skip",
                )

            if "amenities" in df.columns:
                total = len(df)
                result["total"] = total

                from collections import Counter

                counter: Counter = Counter()
                for raw in df["amenities"]:
                    tokens = _parse_amenities_cell(raw)
                    # dedupe within a single listing so the same amenity
                    # is not counted twice for one row
                    for t in set(tokens):
                        counter[t] += 1

                top = counter.most_common(top_n)
                result["items"] = [
                    {
                        "label": label,
                        "count": int(count),
                        "pct": round(count / total * 100, 1) if total else 0,
                    }
                    for label, count in top
                ]

        except Exception:
            logger.exception("amenities failed for %s", city.city_slug)

    cache.set(key, result, CHART_CACHE_SECONDS)
    return result


# ---------------------------------------------------------------------------
# Precomputation — warm every cache entry ahead of the first request
# ---------------------------------------------------------------------------

_PRECOMPUTE_STEPS: tuple[tuple[str, Any], ...] = (
    ("stats", compute_city_stats),
    ("charts", compute_city_charts),
    ("reviews", compute_city_reviews),
    ("hosts", compute_city_hosts),
    ("availability", compute_city_availability),
    ("superlatives", compute_city_superlatives),
    ("amenities", compute_city_amenities),
)


def precompute_city(city) -> dict[str, str]:
    """Warm every aggregate for one city.

    Returns a mapping ``{kind: "ok" | "error: <msg>"}`` so callers can log
    per-kind outcomes.
    """
    results: dict[str, str] = {}
    for name, fn in _PRECOMPUTE_STEPS:
        try:
            fn(city)
            results[name] = "ok"
        except Exception as exc:
            logger.exception("precompute %s failed for %s", name, city.city_slug)
            results[name] = f"error: {exc}"
    return results


def precompute_cities(
    cities,
    *,
    callback: Any = None,
) -> dict[str, dict[str, str]]:
    """Warm every cache entry for a batch of cities.

    ``callback`` is optional; when supplied it's called as
    ``callback(city, result_dict, index, total)`` after each city.
    """
    cities = list(cities)
    total = len(cities)
    all_results: dict[str, dict[str, str]] = {}

    for i, city in enumerate(cities, start=1):
        result = precompute_city(city)
        all_results[city.city_slug] = result
        if callback:
            try:
                callback(city, result, i, total)
            except Exception:
                logger.exception("precompute callback failed for %s", city.city_slug)

    return all_results
