from django.views import View
from .models import Order


def order_list(request):
    return list(Order.objects.filter(paid=True))


class OrderDetailView(View):
    def get(self, request, pk):
        return Order.objects.get(pk=pk)
