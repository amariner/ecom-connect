/**
 * Volcado de la D1 a SQL restaurable. Puro: recibe filas, devuelve sentencias.
 * Lo consume GET /api/admin/backup.sql (botón «Copia de seguridad» del panel).
 * Restaurar: `wrangler d1 execute <db> --remote --file copia.sql`.
 */

export type Row = Record<string, string | number | null>;

/** Orden de volcado y de borrado inverso (hijos después de padres al insertar no importa: borramos primero). */
export const BACKUP_SCHEMA_VERSION = 37;

export const BACKUP_TABLES = [
  'products',
  'stored_value_accounts',
  'bundles',
  'bundle_groups',
  'bundle_components',
  'price_lists',
  'price_list_products',
  'price_list_companies',
  'promotion_codes',
  'promotion_code_products',
  'automatic_discounts',
  'automatic_discount_products',
  'quantity_offers',
  'quantity_offer_tiers',
  'quantity_offer_products',
  'discount_combination_policies',
  'discount_combination_source_pairs',
  'discount_combination_class_pairs',
  'product_media',
  'product_options',
  'product_option_values',
  'product_variants',
  'product_variant_option_values',
  'product_variant_media',
  'subscription_plans',
  'preorder_policies',
  'attribute_definitions',
  'product_attribute_values',
  'inventory_balances',
  'inventory_movements',
  'inventory_locations',
  'inventory_routing_policies',
  'inventory_location_balances',
  'inventory_location_movements',
  'inventory_transfers',
  'inventory_transfer_lines',
  'inventory_transfer_receipts',
  'inventory_transfer_receipt_lines',
  'inventory_transfer_movements',
  'inventory_counts',
  'inventory_count_lines',
  'inventory_count_movements',
  'inventory_reservations',
  'inventory_reservation_lines',
  'inventory_reservation_events',
  'inventory_reservation_balance_events',
  'shipping_rates',
  'order_document_templates',
  'order_tags',
  'order_bulk_batches',
  'order_bulk_batch_rows',
  'customer_profiles',
  'customer_address_access_refs',
  'customer_address_revisions',
  'customer_profile_merges',
  'customer_consent_evidence',
  'customer_data_rights_evidence',
  'customer_data_rights_plan_decisions',
  'customer_data_rights_artifact_references',
  'customer_auth_identities',
  'customer_session_families',
  'customer_sessions',
  'customer_passwordless_challenges',
  'orders',
  'customer_order_access_refs',
  'preliminary_orders',
  'preliminary_order_lines',
  'preliminary_order_payment_links',
  'preliminary_order_payments',
  'preliminary_order_events',
  'order_items',
  'subscriptions',
  'subscription_provider_events',
  'subscription_events',
  'subscription_cycles',
  'preorder_commitments',
  'preorder_commitment_events',
  'preorder_allocations',
  'order_bundle_components',
  'bundle_applications',
  'price_list_applications',
  'discount_combination_applications',
  'automatic_discount_applications',
  'quantity_offer_applications',
  'promotion_code_usages',
  'order_holds',
  'order_hold_events',
  'order_notes',
  'order_note_revisions',
  'order_tag_assignments',
  'order_tag_events',
  'order_amendments',
  'order_amendment_lines',
  'payments',
  'payment_transactions',
  'refunds',
  'refund_items',
  'refund_payment_allocations',
  'stored_value_reservations',
  'stored_value_applications',
  'stored_value_refund_allocations',
  'stored_value_ledger_entries',
  'fulfillments',
  'fulfillment_items',
  'inventory_allocation_decisions',
  'inventory_allocation_lines',
  'inventory_allocation_movements',
  'return_requests',
  'customer_return_access_refs',
  'return_request_lines',
  'return_events',
  'return_inventory_movements',
  'bundle_return_inventory_movements',
  'return_exchange_lines',
  'order_documents',
  'order_document_artifacts',
  'order_document_events',
  'order_events',
  'event_outbox_events',
  'event_outbox_deliveries',
  'emails_outbox',
  // `audit_log` NO se exporta por HTTP: es evidencia interna y la demo tiene
  // credenciales públicas. Su extracción se hace solo con Wrangler/Cloudflare.
  // `contact_requests` NO entra a propósito: son datos personales de leads
  // reales y esta copia se descarga desde el panel, que en la demo pública es
  // accesible con la contraseña que la propia demo enseña. Ver migración 0003.
] as const;

function sqlValue(value: string | number | null): string {
  if (value === null) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${value.replaceAll("'", "''")}'`;
}

/** INSERTs de una tabla (con columnas explícitas, ids incluidos para conservar FKs). */
export function dumpTable(table: string, rows: Row[]): string[] {
  if (rows.length === 0) return [];
  const orderedRows = table === 'order_documents'
    ? [...rows].sort((left, right) => Number(left.document_version) - Number(right.document_version))
    : table === 'customer_profiles'
      ? orderCustomerProfilesForRestore(rows)
      : table === 'customer_address_revisions'
        ? [...rows].sort((left, right) => String(left.address_id).localeCompare(String(right.address_id)) ||
          Number(left.revision) - Number(right.revision))
        : table === 'customer_consent_evidence'
          ? [...rows].sort((left, right) => Number(left.version) - Number(right.version) ||
            String(left.id).localeCompare(String(right.id)))
          : table === 'customer_data_rights_evidence'
            ? [...rows].sort((left, right) =>
              String(left.request_id).localeCompare(String(right.request_id)) ||
              Number(left.version) - Number(right.version) ||
              String(left.id).localeCompare(String(right.id)))
            : table === 'customer_data_rights_plan_decisions' ||
                table === 'customer_data_rights_artifact_references'
              ? [...rows].sort((left, right) =>
                String(left.evidence_id).localeCompare(String(right.evidence_id)) ||
                Number(left.position) - Number(right.position))
              : table === 'customer_sessions'
                ? [...rows].sort((left, right) =>
                  String(left.family_id).localeCompare(String(right.family_id)) ||
                  Number(left.generation) - Number(right.generation))
                : table === 'customer_passwordless_challenges'
                  ? [...rows].sort((left, right) =>
                    String(left.identity_id).localeCompare(String(right.identity_id)) ||
                    String(left.requested_at).localeCompare(String(right.requested_at)) ||
                    String(left.id).localeCompare(String(right.id)))
              : rows;
  const columns = Object.keys(orderedRows[0]!);
  // Al restaurar ubicaciones, el trigger de 0022 crea su política por defecto.
  // Sustituirla aquí permite recuperar exactamente la configuración exportada.
  const insert = table === 'inventory_routing_policies' ? 'INSERT OR REPLACE' : 'INSERT';
  return orderedRows.map(
    (row) =>
      `${insert} INTO ${table} (${columns.join(', ')}) VALUES (${columns
        .map((col) => sqlValue(row[col] ?? null))
        .join(', ')});`,
  );
}

/** Inserta primero cada destino de merge para satisfacer la FK autorreferente. */
function orderCustomerProfilesForRestore(rows: Row[]): Row[] {
  const remaining = new Map(rows.map((row) => [String(row.id), row]));
  const ordered: Row[] = [];
  const inserted = new Set<string>();
  while (remaining.size > 0) {
    const ready = [...remaining.entries()].filter(([, row]) => {
      const target = row.merged_into_profile_id;
      return target === null || target === undefined || inserted.has(String(target)) || !remaining.has(String(target));
    });
    if (ready.length === 0) {
      throw new RangeError('Los perfiles del backup contienen un ciclo de merges.');
    }
    for (const [id, row] of ready) {
      ordered.push(row);
      inserted.add(id);
      remaining.delete(id);
    }
  }
  return ordered;
}

/**
 * Los triggers de 0039 solo permiten insertar familias/sesiones en su estado
 * inicial. El backup conserva el estado final, así que el restore reconstruye
 * primero toda la cadena activa y reproduce después sus transiciones.
 */
function initialCustomerSessionFamilies(rows: Row[]): Row[] {
  return rows.map((row) => {
    const version = customerSessionFamilyVersion(row);
    if (row.status === 'active' || version === 1) return { ...row };
    return {
      ...row,
      status: 'active',
      revoked_at: null,
      revocation_reason_id: null,
      transition_idempotency_key: null,
      version: version - 1,
    };
  });
}

function customerSessionFamilyVersion(row: Row): number {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new RangeError('Una familia del backup debe tener versión final >= 1.');
  }
  return version;
}

function initialCustomerSessions(rows: Row[]): Row[] {
  return rows.map((row) => ({
    ...row,
    status: 'active',
    replaced_by_session_id: null,
    revoked_at: null,
    revocation_reason_id: null,
    transition_idempotency_key: null,
    version: 1,
  }));
}

function customerSessionTransitionSql(rows: Row[]): string[] {
  return [...rows]
    .sort((left, right) => String(left.family_id).localeCompare(String(right.family_id)) ||
      Number(left.generation) - Number(right.generation))
    .filter((row) => row.status !== 'active')
    .map((row) => `UPDATE customer_sessions SET status = ${sqlValue(row.status ?? null)}, ` +
      `replaced_by_session_id = ${sqlValue(row.replaced_by_session_id ?? null)}, ` +
      `revoked_at = ${sqlValue(row.revoked_at ?? null)}, ` +
      `revocation_reason_id = ${sqlValue(row.revocation_reason_id ?? null)}, ` +
      `transition_idempotency_key = ${sqlValue(row.transition_idempotency_key ?? null)}, ` +
      `version = ${sqlValue(row.version ?? null)} ` +
      `WHERE id = ${sqlValue(row.id ?? null)} AND status = 'active' AND version = 1;`);
}

function customerSessionFamilyTransitionSql(rows: Row[]): string[] {
  return rows
    .filter((row) => row.status !== 'active' && customerSessionFamilyVersion(row) >= 2)
    .map((row) => `UPDATE customer_session_families SET status = ${sqlValue(row.status ?? null)}, ` +
      `revoked_at = ${sqlValue(row.revoked_at ?? null)}, ` +
      `revocation_reason_id = ${sqlValue(row.revocation_reason_id ?? null)}, ` +
      `transition_idempotency_key = ${sqlValue(row.transition_idempotency_key ?? null)}, ` +
      `version = ${sqlValue(row.version ?? null)} ` +
      `WHERE id = ${sqlValue(row.id ?? null)} AND status = 'active' ` +
      `AND version = ${customerSessionFamilyVersion(row) - 1};`);
}

/** Dump completo: limpieza (hijos primero) + INSERTs en orden de FK. */
export function buildBackupSql(tablesRows: Record<string, Row[]>, generatedAt: string): string {
  const lines = [
    `-- Copia de seguridad Logic2B Ecommerce — ${generatedAt}`,
    `-- logic2b-backup-schema: ${BACKUP_SCHEMA_VERSION}`,
    '-- Requiere una base con la migración 0044_customer_return_requests aplicada; las tablas/columnas explícitas abortan un restore incompatible.',
    `-- Restaurar con: wrangler d1 execute <database> --remote --file <este fichero>`,
    'PRAGMA defer_foreign_keys = true;',
  ];
  for (const table of [...BACKUP_TABLES].reverse()) {
    lines.push(`DELETE FROM ${table};`);
  }
  const sessionFamilies = tablesRows.customer_session_families ?? [];
  const sessions = tablesRows.customer_sessions ?? [];
  for (const table of BACKUP_TABLES) {
    // El trigger de 0041 crea referencias nuevas al restaurar `orders`.
    // Sustituirlas aquí recupera exactamente los selectores y versiones del
    // origen en lugar de duplicarlos o rotarlos silenciosamente.
    if (table === 'customer_order_access_refs' || table === 'customer_return_access_refs') {
      lines.push(`DELETE FROM ${table};`);
    }
    if (table === 'customer_session_families') {
      lines.push(...dumpTable(table, initialCustomerSessionFamilies(sessionFamilies)));
      continue;
    }
    if (table === 'customer_sessions') {
      lines.push(...dumpTable(table, initialCustomerSessions(sessions)));
      continue;
    }
    if (table === 'customer_passwordless_challenges') {
      lines.push(...customerSessionTransitionSql(sessions));
      lines.push(...customerSessionFamilyTransitionSql(sessionFamilies));
    }
    lines.push(...dumpTable(table, tablesRows[table] ?? []));
  }
  return lines.join('\n') + '\n';
}
