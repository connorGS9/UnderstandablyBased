CREATE TABLE customers (id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) DEFAULT 'open'
);
CREATE INDEX idx_orders_customer ON orders (customer_id);
