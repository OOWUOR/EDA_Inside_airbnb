"""Normalise Inside Airbnb GeoJSON files to polygonal geometry.

Some cities publish neighbourhood boundaries as ``MultiLineString`` features
whose segments are *shared walls between neighbourhoods*, not closed rings.
``polygonize`` on those produces the outer envelope of the whole city as one
giant polygon, which then covers every neighbourhood underneath it when rendered.

This module:

1. Tries direct ring extraction — if the feature's lines are already closed
   rings, wrap them as a Polygon without invoking polygonize.
2. Falls back to polygonize only when needed.
3. Drops the outer envelope (any polygon whose area is dramatically larger
   than the median of the feature set) so the map shows neighbourhoods.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from statistics import median

from shapely.geometry import (GeometryCollection, LineString, MultiLineString,
                              MultiPolygon, Polygon, mapping, shape)

logger = logging.getLogger(__name__)

# Outer envelope is discarded if it's this many times larger than the
# median polygon area in the file.
ENVELOPE_AREA_RATIO = 8.0


def _collect_lines(geom) -> list[LineString]:
    if geom.is_empty:
        return []
    if isinstance(geom, LineString):
        return [geom]
    if isinstance(geom, MultiLineString):
        return list(geom.geoms)
    if isinstance(geom, GeometryCollection):
        out: list[LineString] = []
        for g in geom.geoms:
            out.extend(_collect_lines(g))
        return out
    return []


def _rings_from_lines(lines: list[LineString]) -> list[list[tuple[float, float]]]:
    """Return every closed, valid, simple ring from *lines*."""
    rings: list[list[tuple[float, float]]] = []
    for line in lines:
        coords = list(line.coords)
        if len(coords) < 4:
            continue
        if coords[0] != coords[-1]:
            continue
        try:
            poly = Polygon(coords)
        except Exception:
            continue
        if not poly.is_valid or poly.area == 0:
            continue
        rings.append(coords)
    return rings


def _coerce_geometry(geom):
    """Return a polygonal geometry for *geom*, or *geom* unchanged."""
    if geom.is_empty:
        return geom
    if geom.geom_type in ("Polygon", "MultiPolygon"):
        return geom

    lines = _collect_lines(geom)
    if not lines:
        return geom

    # Path A: the feature already contains closed rings.
    rings = _rings_from_lines(lines)
    if rings:
        polys = [Polygon(r) for r in rings]
        return polys[0] if len(polys) == 1 else MultiPolygon(polys)

    # Path B: segments only — try polygonize as a last resort.
    from shapely.ops import polygonize

    polys = [p for p in polygonize(lines) if p.is_valid and p.area > 0]
    if not polys:
        return geom
    return polys[0] if len(polys) == 1 else MultiPolygon(polys)


def _discard_envelope(geojson: dict) -> int:
    """Drop features whose polygon is dramatically larger than the median.

    Returns the number of features removed.  Only kicks in when there are
    enough features to compute a meaningful median.
    """
    features = geojson.get("features") or []
    if len(features) < 5:
        return 0

    areas: list[float] = []
    for f in features:
        g = f.get("geometry")
        if not g:
            areas.append(0.0)
            continue
        try:
            areas.append(shape(g).area)
        except Exception:
            areas.append(0.0)

    med = median(a for a in areas if a > 0)
    if med <= 0:
        return 0

    cutoff = med * ENVELOPE_AREA_RATIO
    kept: list[dict] = []
    removed = 0
    for f, a in zip(features, areas):
        if a > cutoff:
            removed += 1
            continue
        kept.append(f)

    if removed:
        geojson["features"] = kept
    return removed


def ensure_polygonal_geojson(path: Path) -> bool:
    """Rewrite *path* so every feature is Polygon / MultiPolygon.

    Returns True if the file was modified.
    """
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return False

    with path.open("r", encoding="utf-8") as fh:
        gj = json.load(fh)

    features = gj.get("features") or []
    if not features:
        return False

    changed = False
    for feature in features:
        geom_dict = feature.get("geometry")
        if not geom_dict:
            continue
        try:
            geom = shape(geom_dict)
        except Exception:
            logger.warning("Unparseable geometry in %s", path)
            continue

        new_geom = _coerce_geometry(geom)
        if new_geom is geom:
            continue
        if new_geom.geom_type == geom.geom_type and new_geom.equals(geom):
            continue
        feature["geometry"] = mapping(new_geom)
        changed = True

    # Drop the outer envelope if it dominates.
    removed = _discard_envelope(gj)
    if removed:
        logger.info("Discarded %d envelope feature(s) in %s", removed, path)
        changed = True

    if changed:
        with path.open("w", encoding="utf-8") as fh:
            json.dump(gj, fh, ensure_ascii=False)

    return changed
