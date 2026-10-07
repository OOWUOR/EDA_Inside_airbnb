"""Rewrite cached neighbourhood GeoJSON files to polygonal geometry.

Walks the dataset cache and runs ``ensure_polygonal_geojson`` on every
``neighbourhoods.geojson`` it finds.  Safe to re-run — the utility is a
no-op on files that are already polygonal.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand
from listings.data_ops.datasets import cache_dir
from listings.data_ops.geojson_utils import ensure_polygonal_geojson


class Command(BaseCommand):
    help = "Coerce MultiLineString features in cached GeoJSON to polygons."

    def add_arguments(self, parser):
        parser.add_argument(
            "--city", metavar="SLUG", help="Only process this city slug."
        )

    def handle(self, *args, **opts):
        root = cache_dir()
        pattern = (
            f"{opts['city']}/neighbourhoods.geojson"
            if opts["city"]
            else "*/neighbourhoods.geojson"
        )

        files = list(root.glob(pattern))
        if not files:
            self.stdout.write(
                self.style.WARNING("No neighbourhood.geojson files found.")
            )
            return

        self.stdout.write(f"Scanning {len(files)} file(s)…\n")

        converted = 0
        unchanged = 0
        failed = 0

        for path in files:
            slug = path.parent.name
            try:
                if ensure_polygonal_geojson(path):
                    converted += 1
                    self.stdout.write(self.style.SUCCESS(f"  [converted] {slug}"))
                else:
                    unchanged += 1
                    self.stdout.write(f"  [skip]      {slug} (already polygonal)")
            except Exception as exc:
                failed += 1
                self.stderr.write(
                    self.style.ERROR(
                        f"  [fail]      {slug}  {type(exc).__name__}: {exc}"
                    )
                )

        self.stdout.write("")
        self.stdout.write(
            self.style.SUCCESS(
                f"Done. converted={converted}  unchanged={unchanged}  failed={failed}"
            )
        )
