package com.acme.shop.model;

import jakarta.persistence.*;

@Entity
@Table(name = "products", indexes = { @Index(name = "idx_products_sku", columnList = "sku", unique = true) })
public class Product {
  @Id @GeneratedValue private Long id;
  @Column(nullable = false) private String sku;
  private int stock;
  @ManyToOne @JoinColumn(name = "category_id") private Category category;

  public void addStock(int qty) {
    if (qty <= 0) throw new IllegalArgumentException("qty");
    this.stock += qty;
  }
}
