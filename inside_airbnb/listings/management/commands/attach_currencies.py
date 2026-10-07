"""Attach Currency rows to Country rows by name match."""

from django.core.management.base import BaseCommand
from listings.data_ops.currency_data import CurrencyData
from listings.models import Country, Currency


class Command(BaseCommand):
    help = "Match Country records to Currency records and set Country.currency."

    def add_arguments(self, parser):
        parser.add_argument("--dry-run", action="store_true")

    def handle(self, *args, **opts):
        mapping = CurrencyData().country_code_map()  # {country_name: code}

        codes = {c.code for c in Currency.objects.all()}
        missing_codes = {code for code in mapping.values() if code not in codes}
        if missing_codes:
            self.stderr.write(
                self.style.WARNING(
                    f"Currencies not in DB (run loaddata currencies first): "
                    f"{', '.join(sorted(missing_codes))}"
                )
            )

        attached = skipped = unmatched = 0
        for country in Country.objects.all():
            code = mapping.get(country.name)
            if not code:
                unmatched += 1
                continue
            try:
                currency = Currency.objects.get(code=code)
            except Currency.DoesNotExist:
                skipped += 1
                continue
            if country.currency_id == currency.id:
                continue
            if not opts["dry_run"]:
                country.currency = currency
                country.save(update_fields=["currency"])
            attached += 1

        prefix = "[dry-run] " if opts["dry_run"] else ""
        self.stdout.write(
            self.style.SUCCESS(
                f"{prefix}attached={attached}  skipped={skipped}  unmatched={unmatched}"
            )
        )
