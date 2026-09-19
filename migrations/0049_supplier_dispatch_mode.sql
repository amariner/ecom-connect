-- La política del pedido se fija en su alta, dentro de la transacción del motor.
-- El histórico conserva NULL: no podemos reconstruir su configuración original.
ALTER TABLE orders ADD COLUMN supplier_dispatch_mode TEXT
  CHECK (supplier_dispatch_mode IS NULL OR supplier_dispatch_mode IN ('immediate','grouped'));

CREATE TRIGGER capture_demo_supplier_dispatch_mode
AFTER INSERT ON orders
WHEN NEW.supplier_dispatch_mode IS NULL
  AND substr(NEW.stripe_session_id,1,5)='demo_'
  AND NEW.request_hash IS NOT NULL
BEGIN
  UPDATE orders SET supplier_dispatch_mode=COALESCE(
    (SELECT value FROM integration_settings WHERE key='dispatch_mode' AND value='immediate'),
    'grouped'
  )
  WHERE id=NEW.id;
END;
