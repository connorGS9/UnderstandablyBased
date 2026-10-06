from django.db import models


class Customer(models.Model):
    email = models.EmailField(unique=True)


class Order(models.Model):
    customer = models.ForeignKey(Customer, on_delete=models.CASCADE)
    paid = models.BooleanField(default=False, db_index=True)
