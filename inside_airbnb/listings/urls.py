from django.urls import path

from .views import CityListView

urlpatterns = [
    # Maps the root to cities
    path("cities/", CityListView.as_view(), name="city-lists"),
]
