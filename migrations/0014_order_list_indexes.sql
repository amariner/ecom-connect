-- R3.1: additive indexes for stable, cursor-based order administration queries.

CREATE INDEX idx_orders_status_created_id
  ON orders(status, created_at DESC, id DESC);

CREATE INDEX idx_orders_total_id
  ON orders(total_cents DESC, id DESC);

CREATE INDEX idx_orders_status_total_id
  ON orders(status, total_cents DESC, id DESC);

CREATE VIRTUAL TABLE orders_search USING fts5(
  order_number,
  customer_name,
  email,
  tokenize = 'unicode61 remove_diacritics 2'
);

INSERT INTO orders_search(rowid, order_number, customer_name, email)
SELECT id, order_number, customer_name, email FROM orders;

CREATE TRIGGER orders_search_insert
AFTER INSERT ON orders
BEGIN
  INSERT INTO orders_search(rowid, order_number, customer_name, email)
  VALUES (NEW.id, NEW.order_number, NEW.customer_name, NEW.email);
END;

CREATE TRIGGER orders_search_delete
AFTER DELETE ON orders
BEGIN
  DELETE FROM orders_search WHERE rowid = OLD.id;
END;

CREATE TRIGGER orders_search_update
AFTER UPDATE OF order_number, customer_name, email ON orders
BEGIN
  DELETE FROM orders_search WHERE rowid = OLD.id;
  INSERT INTO orders_search(rowid, order_number, customer_name, email)
  VALUES (NEW.id, NEW.order_number, NEW.customer_name, NEW.email);
END;
