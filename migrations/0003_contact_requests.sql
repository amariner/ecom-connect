-- Solicitudes de proyecto de la landing (formulario «Iniciar proyecto»).
--
-- POR QUÉ UNA TABLA PROPIA y no `emails_outbox`, que era la tentación:
--   1. PRIVACIDAD. La bandeja de la demo (/demo/admin/emails) es PÚBLICA: es
--      material de venta. Un lead lleva nombre, email y teléfono de una persona
--      real; ahí no puede aparecer.
--   2. PERSISTENCIA. El cron de reset vacía `emails_outbox` cada 6 h. Un lead
--      perdido en un reset es una venta perdida.
--   3. ENTREGA. `emails_outbox` no se entrega con DEMO_MODE=true — que es como
--      corre ecom.logic2b.com. El aviso de un lead no es un email transaccional
--      de la tienda ficticia: es correo de la agencia y sale igual.
--
-- Sin coste: una tabla en la D1 que ya existe, dentro del plan gratuito.
CREATE TABLE contact_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  sells TEXT,
  catalog TEXT,
  needs TEXT NOT NULL,
  -- Qué CTA lo originó: cabecera | arriba | cierre. Mide qué convierte.
  source TEXT,
  -- 0 = pendiente de aviso por email; 1 = avisado.
  notified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_contact_requests_created ON contact_requests(created_at DESC);
