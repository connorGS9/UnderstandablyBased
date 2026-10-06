package com.acme.shop.service;

import com.acme.shop.model.Product;
import com.acme.shop.repo.ProductRepository;
import org.springframework.stereotype.Service;
import java.util.List;

@Service
public class ProductServiceImpl implements ProductService {
  private final ProductRepository products;

  public ProductServiceImpl(ProductRepository products) {
    this.products = products;
  }

  @Override
  public List<Product> findAll() {
    return products.findAll();
  }

  @Override
  public Product restock(Long id, int qty) {
    Product p = products.findById(id).orElseThrow();
    p.addStock(qty);
    return products.save(p);
  }
}
