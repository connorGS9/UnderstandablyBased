package com.acme.shop.model;

import jakarta.persistence.*;

@Entity
@Table(name = "categories")
public class Category {
  @Id @GeneratedValue private Long id;
  private String name;
}
