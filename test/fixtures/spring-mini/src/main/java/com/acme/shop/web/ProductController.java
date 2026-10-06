package com.acme.shop.web;

import com.acme.shop.service.ProductService;
import com.acme.shop.model.Product;
import org.springframework.web.bind.annotation.*;
import java.util.List;

@RestController
@RequestMapping("/api/products")
public class ProductController {
  private final ProductService productService;

  public ProductController(ProductService productService) {
    this.productService = productService;
  }

  @GetMapping
  public List<Product> list() {
    return productService.findAll();
  }

  @PostMapping("/{id}/restock")
  public Product restock(@PathVariable Long id, @RequestParam int qty) {
    return productService.restock(id, qty);
  }
}
