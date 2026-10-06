from django.urls import path
from . import views

urlpatterns = [
    path("", views.order_list),
    path("<int:pk>/", views.OrderDetailView.as_view()),
]
