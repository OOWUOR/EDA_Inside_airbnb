# Register your models here.
from django.contrib import admin

from .models import City, Continent, Country, Currency


@admin.register(Continent)
class ContinentAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "display_order")
    list_editable = ("display_order",)
    search_fields = ("name",)
    prepopulated_fields = {"slug": ("name",)}


@admin.register(Country)
class CountryAdmin(admin.ModelAdmin):
    list_display = ("name", "slug", "continent", "display_order", "currency")
    list_filter = ("continent",)
    list_editable = ("display_order",)
    search_fields = ("name",)
    autocomplete_fields = ("continent", "currency")
    prepopulated_fields = {"slug": ("name",)}


@admin.register(City)
class CityAdmin(admin.ModelAdmin):
    list_display = (
        "city",
        "country",
        "continent_name",
        "region",
        "is_country_archive",
        "city_slug",
    )
    list_filter = ("is_country_archive", "country__continent", "country")
    search_fields = ("city", "city_slug", "region", "country__name")
    autocomplete_fields = ("country",)
    prepopulated_fields = {"city_slug": ("city",)}
    readonly_fields = ("city_slug",) if False else ()

    @admin.display(description="Continent", ordering="country__continent__name")
    def continent_name(self, obj: City) -> str:
        return obj.country.continent.name


@admin.register(Currency)
class CurrencyAdmin(admin.ModelAdmin):
    list_display = ("code", "value_usd")
    list_editable = ("value_usd",)
    search_fields = ("code",)
