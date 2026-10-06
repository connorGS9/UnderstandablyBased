package com.acme.shop.service;

import com.acme.shop.model.Product;
import java.util.List;

public interface ProductService {
  List<Product> findAll();
  Product restock(Long id, int qty);
}
