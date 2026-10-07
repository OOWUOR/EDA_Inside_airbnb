"""Warm every aggregate cache for a set of cities.

Run this after ``sync_datasets`` so the first request for any city is
instant.  Idempotent — safe to re-run; only cache writes happen.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from listings.data_ops.datasets import precompute_cities
from listings.models import City


class Command(BaseCommand):
    help = "Precompute every per-city aggregate so the dashboard is instant."

    def add_arguments(self, parser):
        parser.add_argument(
            "--city", action="append", metavar="SLUG", help="City slug (repeatable)."
        )
        parser.add_argument(
            "--country", metavar="SLUG", help="Restrict to a country slug."
        )
        parser.add_argument(
            "--continent", metavar="SLUG", help="Restrict to a continent slug."
        )
        parser.add_argument(
            "--all", action="store_true", help="Precompute every city in the database."
        )

    def handle(self, *args, **opts):
        qs = City.objects.select_related("country__currency", "country__continent")

        if opts["city"]:
            qs = qs.filter(city_slug__in=opts["city"])
        elif opts["country"]:
            qs = qs.filter(country__slug=opts["country"])
        elif opts["continent"]:
            qs = qs.filter(country__continent__slug=opts["continent"])
        elif not opts["all"]:
            raise CommandError("Pick one of: --city, --country, --continent, --all")

        cities = list(qs)
        if not cities:
            raise CommandError("No cities matched the given filters.")

        self.stdout.write(f"Cities to warm: {len(cities)}")
        self.stdout.write("")

        def on_step(city, result, i, total):
            ok = sum(1 for v in result.values() if v == "ok")
            err = len(result) - ok
            tag = (
                self.style.SUCCESS("ok")
                if err == 0
                else self.style.WARNING(f"{err} failed")
            )
            self.stdout.write(
                f"  [{i:>3}/{total}] {city.city_slug:<32s} "
                f"{ok}/{len(result)} ok  ({tag})"
            )

        results = precompute_cities(cities, callback=on_step)

        total_ok = sum(1 for r in results.values() for v in r.values() if v == "ok")
        total_err = sum(1 for r in results.values() for v in r.values() if v != "ok")

        self.stdout.write("")
        self.stdout.write(
            self.style.SUCCESS(
                f"Done. {total_ok} cache entries warm, {total_err} failed."
            )
        )
