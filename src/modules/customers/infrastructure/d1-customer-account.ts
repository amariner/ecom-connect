import { customerId } from '../domain/customer-identity';

export type AccountOrderSummary = {
  public_ref: string; order_number: string; channel: string; status: string; created_at: string;
  total_cents: number; units: number; tracking_number: string | null; tracking_carrier: string | null;
  shipped_units: number;
};
export type AccountOrderItem = { name_snapshot: string; unit_price_cents: number; qty: number };
export type AccountOrderShipment = {
  expedition_number: string; tracking_number: string; tracking_carrier: string; shipped_at: string;
  lines: { name: string; qty: number }[];
};
export type AccountOrderEvent = { to_status: string; note: string | null; created_at: string };
export type AccountOrderDetail = AccountOrderSummary & {
  subtotal_cents: number; shipping_cents: number;
  address: { name: string; email: string; street: string; postal_code: string; city: string };
  items: AccountOrderItem[]; shipments: AccountOrderShipment[]; events: AccountOrderEvent[];
  cancellation: { source: string; reason: string; requested_at: string; cancelled_at: string | null } | null;
};
export type AccountAddress = {
  public_ref: string; recipient_name: string; phone: string | null; street: string; city: string;
  region: string | null; postal_code: string; country_code: string; revision: number; is_default: boolean;
};
export type AccountConsent = { action: 'granted' | 'withdrawn'; occurred_at: string; version: number } | null;

/** Un pedido solo es del comprador cuando su perfil consta como propietario. */
const OWNED_ORDER_SQL = `FROM orders o JOIN customer_order_access_refs a ON a.order_id=o.id
  WHERE o.customer_profile_id=?1`;
const SHIPPED_UNITS_SQL = `COALESCE((SELECT SUM(l.qty) FROM order_shipment_lines l
  JOIN order_shipments s ON s.id=l.shipment_id WHERE s.order_id=o.id),0) AS shipped_units`;
const ORDER_UNITS_SQL = `COALESCE((SELECT SUM(COALESCE(i.current_qty,i.qty)) FROM order_items i
  WHERE i.order_id=o.id),0) AS units`;

const CONSENT_NOTICE = { id: 'farmahouse.demo.aviso-privacidad', version: '2026-09' } as const;
export const MARKETING_CONSENT = { channel: 'email', purpose_id: 'marketing.newsletter' } as const;

export function createD1CustomerAccount(db: D1Database) {
  return {
    /**
     * Asocia al perfil las compras que hizo como invitado con ese mismo correo.
     * Solo reclama pedidos sin propietario: nunca cambia el de otro perfil.
     */
    async claimGuestOrders(profileId: string, email: string, now: string): Promise<number> {
      const claimed = await db.prepare(`UPDATE orders SET customer_profile_id=?1
        WHERE customer_profile_id IS NULL AND channel='WEB' AND lower(trim(email))=?2`).bind(profileId,email).run();
      // El primer nombre conocido evita pedirle al comprador un dato que ya nos dio.
      await db.prepare(`UPDATE customer_profiles SET display_name=(
          SELECT trim(o.customer_name) FROM orders o WHERE o.customer_profile_id=?1
            AND length(trim(o.customer_name)) BETWEEN 2 AND 120 ORDER BY o.id DESC LIMIT 1
        ),updated_at=?2,version=version+1
        WHERE id=?1 AND display_name IS NULL AND EXISTS (
          SELECT 1 FROM orders o WHERE o.customer_profile_id=?1
            AND length(trim(o.customer_name)) BETWEEN 2 AND 120)`).bind(profileId,now).run();
      return Number(claimed.meta?.changes ?? 0);
    },

    async listOrders(profileId: string, page: number, limit: number): Promise<{ orders: AccountOrderSummary[]; total: number }> {
      const results = await db.batch([
        db.prepare(`SELECT COUNT(*) AS total ${OWNED_ORDER_SQL}`).bind(profileId),
        // Una página fuera de rango devuelve la última con pedidos, no una lista
        // vacía: el recuento y el desplazamiento se deciden en la misma lectura.
        db.prepare(`SELECT a.public_ref,o.order_number,o.channel,o.status,o.created_at,o.total_cents,
            o.tracking_number,o.tracking_carrier,${ORDER_UNITS_SQL},${SHIPPED_UNITS_SQL}
          ${OWNED_ORDER_SQL} ORDER BY o.id DESC LIMIT ?2
          OFFSET (SELECT MAX(0,MIN(?3,CAST((COUNT(*)-1)/?2 AS INTEGER)*?2)) ${OWNED_ORDER_SQL})`)
          .bind(profileId,limit,(page - 1) * limit),
      ]);
      return {
        total: (results[0]?.results[0] as { total: number } | undefined)?.total ?? 0,
        orders: (results[1]?.results ?? []) as AccountOrderSummary[],
      };
    },

    async readOrder(profileId: string, publicRef: string): Promise<AccountOrderDetail | null> {
      const order = await db.prepare(`SELECT o.id,a.public_ref,o.order_number,o.channel,o.status,o.created_at,
          o.subtotal_cents,o.shipping_cents,o.total_cents,o.tracking_number,o.tracking_carrier,o.address_json,
          ${ORDER_UNITS_SQL},${SHIPPED_UNITS_SQL}
        ${OWNED_ORDER_SQL} AND a.public_ref=?2`)
        .bind(profileId,publicRef).first<AccountOrderDetail & { id: number; address_json: string }>();
      if (!order) return null;
      const [items, shipments, shipmentLines, events, cancellation] = await Promise.all([
        db.prepare(`SELECT name_snapshot,unit_price_cents,COALESCE(current_qty,qty) AS qty
          FROM order_items WHERE order_id=? ORDER BY id`).bind(order.id).all<AccountOrderItem>(),
        db.prepare(`SELECT id,expedition_number,tracking_number,tracking_carrier,shipped_at
          FROM order_shipments WHERE order_id=? ORDER BY sequence`).bind(order.id)
          .all<AccountOrderShipment & { id: number }>(),
        db.prepare(`SELECT l.shipment_id,l.qty,COALESCE((SELECT MIN(i.name_snapshot) FROM order_items i
            JOIN products p ON p.id=i.product_id WHERE i.order_id=?1 AND p.supplier_sku=l.supplier_sku),l.supplier_sku) AS name
          FROM order_shipment_lines l JOIN order_shipments s ON s.id=l.shipment_id
          WHERE s.order_id=?1 ORDER BY l.supplier_sku`).bind(order.id)
          .all<{ shipment_id: number; qty: number; name: string }>(),
        db.prepare(`SELECT to_status,note,created_at FROM order_events WHERE order_id=? ORDER BY id`)
          .bind(order.id).all<AccountOrderEvent>(),
        // Una solicitud sin terminar no es una cancelación: el pedido manda.
        db.prepare(`SELECT c.source,c.reason,c.requested_at,c.cancelled_at FROM order_cancellations c
          JOIN orders o ON o.id=c.order_id AND o.status='cancelled' WHERE c.order_id=?`)
          .bind(order.id).first<AccountOrderDetail['cancellation']>(),
      ]);
      const address = readAddressSnapshot(order.address_json);
      return {
        public_ref: order.public_ref, order_number: order.order_number, channel: order.channel,
        status: order.status, created_at: order.created_at, units: order.units,
        subtotal_cents: order.subtotal_cents, shipping_cents: order.shipping_cents, total_cents: order.total_cents,
        tracking_number: order.tracking_number, tracking_carrier: order.tracking_carrier,
        shipped_units: order.shipped_units, address, items: items.results,
        shipments: shipments.results.map((shipment) => ({
          expedition_number: shipment.expedition_number, tracking_number: shipment.tracking_number,
          tracking_carrier: shipment.tracking_carrier, shipped_at: shipment.shipped_at,
          lines: shipmentLines.results.filter((line) => line.shipment_id === shipment.id)
            .map(({ name, qty }) => ({ name, qty })),
        })),
        events: events.results, cancellation: cancellation ?? null,
      };
    },

    /** El identificador interno solo sale del módulo para las acciones del propio dueño. */
    async findOwnedOrderId(profileId: string, publicRef: string): Promise<number | null> {
      const row = await db.prepare(`SELECT o.id ${OWNED_ORDER_SQL} AND a.public_ref=?2`)
        .bind(profileId,publicRef).first<{ id: number }>();
      return row?.id ?? null;
    },

    async listAddresses(profileId: string): Promise<AccountAddress[]> {
      const rows = await db.prepare(`SELECT r.recipient_name,r.phone,r.street,r.city,r.region,r.postal_code,
          r.country_code,r.revision,a.public_ref,
          CASE WHEN d.address_id IS NULL THEN 0 ELSE 1 END AS is_default
        FROM customer_address_revisions r
        JOIN customer_address_access_refs a ON a.address_id=r.address_id
        LEFT JOIN customer_default_addresses d ON d.address_id=r.address_id AND d.customer_profile_id=r.customer_profile_id
        WHERE r.customer_profile_id=? AND r.valid_to IS NULL
        ORDER BY is_default DESC,r.valid_from DESC,r.address_id`)
        .bind(profileId).all<Omit<AccountAddress,'is_default'> & { is_default: number }>();
      return rows.results.map((row) => ({ ...row, is_default: row.is_default === 1 }));
    },

    async findAddressId(profileId: string, publicRef: string): Promise<string | null> {
      const row = await db.prepare(`SELECT r.address_id FROM customer_address_revisions r
        JOIN customer_address_access_refs a ON a.address_id=r.address_id
        WHERE r.customer_profile_id=? AND a.public_ref=? AND r.valid_to IS NULL`)
        .bind(profileId,publicRef).first<{ address_id: string }>();
      return row?.address_id ?? null;
    },

    /**
     * Alta o corrección de una dirección. Cada cambio es una revisión nueva: la
     * anterior se cierra en la misma sentencia y los pedidos ya hechos conservan
     * la dirección con la que se enviaron.
     */
    async saveAddress(input: {
      profileId: string; addressId: string | null; idempotencyKey: string; fingerprint: string; now: string;
      address: Omit<AccountAddress,'public_ref' | 'revision' | 'is_default'>;
    }): Promise<string> {
      const addressId = input.addressId ?? customerId('address');
      const revision = input.addressId
        ? Number(await db.prepare(`SELECT revision FROM customer_address_revisions
            WHERE address_id=? AND valid_to IS NULL`).bind(addressId).first<number>('revision') ?? 0) + 1
        : 1;
      const { recipient_name, phone, street, city, region, postal_code, country_code } = input.address;
      try {
        await db.prepare(`INSERT INTO customer_address_revisions(
            address_id,customer_profile_id,revision,recipient_name,phone,street,city,region,postal_code,
            country_code,valid_from,write_idempotency_key,write_payload_fingerprint
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .bind(addressId,input.profileId,revision,recipient_name,phone,street,city,region,postal_code,
            country_code,input.now,input.idempotencyKey,input.fingerprint).run();
      } catch (error) {
        // Un reenvío del mismo formulario no crea una segunda revisión.
        const replay = await db.prepare(`SELECT address_id,write_payload_fingerprint FROM customer_address_revisions
          WHERE write_idempotency_key=? AND customer_profile_id=?`)
          .bind(input.idempotencyKey,input.profileId).first<{ address_id: string; write_payload_fingerprint: string }>();
        if (!replay || replay.write_payload_fingerprint !== input.fingerprint) throw error;
        return replay.address_id;
      }
      return addressId;
    },

    /** Archiva la dirección sin borrarla: las revisiones sostienen los pedidos antiguos. */
    async archiveAddress(profileId: string, addressId: string, now: string): Promise<boolean> {
      const result = await db.prepare(`UPDATE customer_address_revisions SET valid_to=?3
        WHERE address_id=?2 AND customer_profile_id=?1 AND valid_to IS NULL`)
        .bind(profileId,addressId,now).run();
      return Number(result.meta?.changes ?? 0) > 0;
    },

    async setDefaultAddress(profileId: string, addressId: string, now: string): Promise<void> {
      await db.prepare(`INSERT INTO customer_default_addresses(customer_profile_id,address_id,updated_at)
        VALUES (?,?,?) ON CONFLICT(customer_profile_id) DO UPDATE SET
          address_id=excluded.address_id,updated_at=excluded.updated_at`)
        .bind(profileId,addressId,now).run();
    },

    async readDefaultAddress(profileId: string): Promise<AccountAddress | null> {
      const row = await db.prepare(`SELECT r.recipient_name,r.phone,r.street,r.city,r.region,r.postal_code,
          r.country_code,r.revision,a.public_ref
        FROM customer_default_addresses d
        JOIN customer_address_revisions r ON r.address_id=d.address_id AND r.valid_to IS NULL
        JOIN customer_address_access_refs a ON a.address_id=r.address_id
        WHERE d.customer_profile_id=?`).bind(profileId).first<Omit<AccountAddress,'is_default'>>();
      return row ? { ...row, is_default: true } : null;
    },

    async updateProfile(profileId: string, input: { display_name: string | null; phone: string | null }, now: string): Promise<void> {
      await db.prepare(`UPDATE customer_profiles SET display_name=?,phone=?,updated_at=?,version=version+1
        WHERE id=? AND status='active'`).bind(input.display_name,input.phone,now,profileId).run();
    },

    async readConsent(profileId: string): Promise<AccountConsent> {
      const row = await db.prepare(`SELECT action,occurred_at,version FROM customer_consent_evidence
        WHERE customer_profile_id=? AND channel=? AND purpose_id=? ORDER BY version DESC LIMIT 1`)
        .bind(profileId,MARKETING_CONSENT.channel,MARKETING_CONSENT.purpose_id).first<NonNullable<AccountConsent>>();
      return row ?? null;
    },

    /**
     * Cada cambio de consentimiento es un hecho nuevo y verificable: guarda el
     * aviso aceptado, su versión y, al retirarlo, el permiso que revoca.
     */
    async recordConsent(profileId: string, action: 'granted' | 'withdrawn', now: string): Promise<void> {
      const current = await db.prepare(`SELECT id,action,version FROM customer_consent_evidence
        WHERE customer_profile_id=? AND channel=? AND purpose_id=? ORDER BY version DESC LIMIT 1`)
        .bind(profileId,MARKETING_CONSENT.channel,MARKETING_CONSENT.purpose_id)
        .first<{ id: string; action: string; version: number }>();
      if (current?.action === action) return;
      if (action === 'withdrawn' && !current) return;
      await db.prepare(`INSERT INTO customer_consent_evidence(
          id,customer_profile_id,channel,purpose_id,action,notice_id,notice_version,source_kind,region,
          occurred_at,recorded_at,withdraws_evidence_id,version,idempotency_key
        ) VALUES (?,?,?,?,?,?,?,'storefront','ES',?,?,?,?,?)`)
        .bind(customerId('consent'),profileId,MARKETING_CONSENT.channel,
          MARKETING_CONSENT.purpose_id,action,CONSENT_NOTICE.id,CONSENT_NOTICE.version,now,now,
          action === 'withdrawn' ? current?.id ?? null : null,(current?.version ?? 0) + 1,
          `consent:${crypto.randomUUID()}`).run();
    },

    /**
     * Retira los datos de contacto que el cliente mantiene: nombre, teléfono,
     * direcciones y permisos. Los pedidos conservan su snapshot porque son la
     * prueba de una compra, no un dato editable del perfil.
     */
    async forgetPersonalData(profileId: string, now: string): Promise<{ addresses: number }> {
      const result = await db.batch([
        db.prepare(`UPDATE customer_profiles SET display_name=NULL,phone=NULL,updated_at=?,version=version+1
          WHERE id=? AND status='active'`).bind(now,profileId),
        db.prepare(`UPDATE customer_address_revisions SET valid_to=?2
          WHERE customer_profile_id=?1 AND valid_to IS NULL`).bind(profileId,now),
      ]);
      return { addresses: Number(result[1]?.meta?.changes ?? 0) };
    },
  };
}

/** El snapshot del pedido es texto libre heredado: se lee con cautela. */
export function readAddressSnapshot(value: string): AccountOrderDetail['address'] {
  const empty = { name: '', email: '', street: '', postal_code: '', city: '' };
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object') return empty;
    const record = parsed as Record<string,unknown>;
    const text = (key: string): string => typeof record[key] === 'string' ? record[key] : '';
    return { name: text('name'), email: text('email'), street: text('street'),
      postal_code: text('postal_code'), city: text('city') };
  } catch {
    return empty;
  }
}
export type D1CustomerAccount = ReturnType<typeof createD1CustomerAccount>;
