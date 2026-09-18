import { CAPABILITY_IDS, type CapabilityId } from './capability-definitions';
import type { ResolvedCapabilityManifest } from './manifest';

export const MODULE_IDS = [
  'platform-configuration',
  'platform-security',
  'platform-operations',
  'catalog',
  'pricing',
  'inventory',
  'cart',
  'checkout',
  'payments',
  'subscriptions',
  'orders',
  'fulfillment',
  'customers',
  'notifications',
  'integrations',
  'storefront',
  'marketing',
] as const;

export type ModuleId = (typeof MODULE_IDS)[number];
export type ModuleVersion = `${number}.${number}.${number}`;

export type ModuleNavigationItem = Readonly<{
  id: string;
  href: `/${string}`;
  label: string;
  order: number;
  capabilityId: CapabilityId;
}>;

export type ModuleRoute = Readonly<{
  match: 'exact' | 'prefix';
  path: `/${string}`;
  capabilityId: CapabilityId;
}>;

export type ModuleDescriptor = Readonly<{
  id: ModuleId;
  version: ModuleVersion;
  capabilities: readonly CapabilityId[];
  dependencies: readonly ModuleId[];
  permissions: readonly string[];
  /** Hechos que EMITE, con el sobre de `shared-kernel`. Un tipo tiene un solo emisor. */
  events: readonly string[];
  /** Hechos ajenos a los que REACCIONA. No crea dependencia: los une el composition root. */
  subscriptions: readonly string[];
  jobs: readonly string[];
  healthchecks: readonly string[];
  wikiLinks: readonly string[];
  navigation: readonly ModuleNavigationItem[];
  routes: readonly ModuleRoute[];
}>;

const ARCHITECTURE_WIKI = 'docs/plataforma/wiki/arquitectura-modular-ecommerce.md';
const R3_OPERATION_WIKI = 'docs/plataforma/wiki/operacion-pedidos-inventario-devoluciones.md';
const PRICE_RULES_WIKI = 'docs/plataforma/wiki/reglas-precio-trazables.md';
const PROMOTION_CODES_WIKI = 'docs/plataforma/wiki/codigos-promocionales-seguros.md';
const AUTOMATIC_DISCOUNTS_WIKI = 'docs/plataforma/wiki/descuentos-automaticos-trazables.md';
const QUANTITY_OFFERS_WIKI = 'docs/plataforma/wiki/ofertas-cantidad-x-y.md';
const DISCOUNT_COMBINATIONS_WIKI = 'docs/plataforma/wiki/combinacion-descuentos-explicita.md';
const PRICE_LISTS_WIKI = 'docs/plataforma/wiki/listas-precios-contextuales.md';
const BUNDLES_WIKI = 'docs/plataforma/wiki/bundles-componentes.md';
const STORED_VALUE_WIKI = 'docs/plataforma/wiki/tarjetas-regalo-credito-tienda.md';
const PREORDERS_WIKI = 'docs/plataforma/wiki/preventa-backorder-explicita.md';
const SUBSCRIPTIONS_WIKI = 'docs/plataforma/wiki/suscripciones-por-adaptador.md';
const PRELIMINARY_ORDERS_WIKI = 'docs/plataforma/wiki/presupuestos-depositos.md';
const R4_MODELS_WIKI = 'docs/plataforma/wiki/modelos-venta-r4.md';
const CUSTOMER_PROFILE_ADR = 'docs/plataforma/adr/0039-perfil-cliente-identidad-opaca.md';
const CUSTOMER_CONSENT_ADR = 'docs/plataforma/adr/0040-consentimiento-evidencia-versionada.md';
const CUSTOMER_DATA_RIGHTS_ADR = 'docs/plataforma/adr/0041-derechos-datos-plan-verificable.md';
const CUSTOMER_PASSWORDLESS_ADR = 'docs/plataforma/adr/0042-autenticacion-passwordless-revocable.md';
const CUSTOMER_PASSWORDLESS_SURFACE_ADR = 'docs/plataforma/adr/0043-superficie-passwordless-email-segura.md';
const CUSTOMER_RESOURCE_OWNERSHIP_ADR = 'docs/plataforma/adr/0044-ownership-recursos-autoservicio.md';
const CUSTOMER_SEGMENTATION_ADR = 'docs/plataforma/adr/0045-segmentos-calculados-observables.md';
const CUSTOMER_PASSWORDLESS_RUNBOOK = 'docs/plataforma/OPERACION_PASSWORDLESS.md';

/**
 * Catálogo canónico de módulos. Los arrays vacíos son declaraciones explícitas:
 * R1.5, R1.10 y R1.11 solo llenan events, healthchecks y jobs que el motor
 * emite o ejecuta HOY; no se inventan contratos futuros.
 */
export const MODULE_DESCRIPTORS = [
  {
    id: 'platform-configuration', version: '1.0.0', capabilities: ['PLT-001', 'PLT-004'], dependencies: [],
    permissions: [], events: [], subscriptions: [], jobs: ['platform-configuration.demo-order-refresh'], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI], navigation: [], routes: [],
  },
  {
    id: 'platform-security', version: '1.0.0', capabilities: ['SEC-001', 'SEC-003', 'SEC-004', 'SEC-012'],
    dependencies: ['platform-configuration'], permissions: ['admin.session'], events: [], subscriptions: [], jobs: [], healthchecks: [],
    wikiLinks: [ARCHITECTURE_WIKI], navigation: [],
    routes: [{ match: 'exact', path: '/demo/admin/login', capabilityId: 'SEC-001' }],
  },
  {
    id: 'platform-operations', version: '1.0.0', capabilities: ['INT-004'], dependencies: ['platform-security'],
    permissions: ['platform.backup.read'], events: [], subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI],
    navigation: [], routes: [{ match: 'exact', path: '/api/admin/backup.sql', capabilityId: 'INT-004' }],
  },
  {
    id: 'catalog', version: '1.3.0', capabilities: ['CAT-001', 'CAT-002', 'CAT-003', 'CAT-007', 'CAT-008'], dependencies: ['platform-configuration'],
    permissions: ['catalog.read', 'catalog.write'], events: [], subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI],
    navigation: [{ id: 'productos', href: '/demo/admin/productos', label: 'Productos', order: 20, capabilityId: 'CAT-001' }],
    routes: [
      { match: 'exact', path: '/demo/admin/productos', capabilityId: 'CAT-001' },
      { match: 'prefix', path: '/demo/admin/productos/', capabilityId: 'CAT-003' },
      { match: 'prefix', path: '/api/admin/catalog-options/', capabilityId: 'CAT-003' },
      { match: 'prefix', path: '/api/admin/catalog-option-values/', capabilityId: 'CAT-003' },
      { match: 'prefix', path: '/api/admin/catalog-variants/', capabilityId: 'CAT-003' },
      { match: 'prefix', path: '/api/admin/catalog-attributes/', capabilityId: 'CAT-007' },
      { match: 'prefix', path: '/api/admin/catalog-media/', capabilityId: 'CAT-008' },
      { match: 'prefix', path: '/api/admin/products/', capabilityId: 'CAT-001' },
    ],
  },
  {
    id: 'pricing', version: '2.0.0', capabilities: ['PRC-001', 'PRC-002', 'PRC-003', 'PRC-004', 'PRC-005', 'PRC-006', 'PRC-007', 'PRC-008', 'PRC-009', 'PRC-010', 'PRC-011', 'PRC-012', 'PRC-014', 'MKT-001', 'MKT-002'],
    dependencies: ['platform-configuration', 'catalog'], permissions: [], events: [], subscriptions: [], jobs: [], healthchecks: [],
    wikiLinks: [ARCHITECTURE_WIKI, R4_MODELS_WIKI, PRICE_RULES_WIKI, PROMOTION_CODES_WIKI, AUTOMATIC_DISCOUNTS_WIKI, QUANTITY_OFFERS_WIKI, DISCOUNT_COMBINATIONS_WIKI, PRICE_LISTS_WIKI, BUNDLES_WIKI, STORED_VALUE_WIKI, PREORDERS_WIKI], navigation: [],
    routes: [
      { match: 'prefix', path: '/api/admin/promotion-codes', capabilityId: 'PRC-004' },
      { match: 'prefix', path: '/api/admin/automatic-discounts', capabilityId: 'PRC-005' },
      { match: 'prefix', path: '/api/admin/quantity-offers', capabilityId: 'PRC-006' },
      { match: 'prefix', path: '/api/admin/discount-combinations', capabilityId: 'PRC-008' },
      { match: 'prefix', path: '/api/admin/price-lists', capabilityId: 'PRC-009' },
      { match: 'prefix', path: '/api/admin/bundles', capabilityId: 'PRC-012' },
      { match: 'prefix', path: '/api/admin/stored-value', capabilityId: 'PRC-010' },
      { match: 'prefix', path: '/api/admin/preorders', capabilityId: 'PRC-014' },
    ],
  },
  {
    id: 'inventory', version: '1.5.1', capabilities: ['INV-001', 'INV-004', 'INV-005', 'INV-007', 'INV-008', 'INV-011'], dependencies: ['catalog'], permissions: ['inventory.locations.read', 'inventory.locations.write', 'inventory.transfers.read', 'inventory.transfers.write', 'inventory.counts.read', 'inventory.counts.write', 'inventory.counts.approve', 'inventory.routing.read', 'inventory.routing.write'],
    events: [], subscriptions: [], jobs: ['inventory.expire-reservations'], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI, R3_OPERATION_WIKI],
    navigation: [
      { id: 'ubicaciones', href: '/demo/admin/ubicaciones', label: 'Ubicaciones', order: 25, capabilityId: 'INV-005' },
      { id: 'transferencias', href: '/demo/admin/transferencias', label: 'Transferencias', order: 27, capabilityId: 'INV-007' },
      { id: 'conteos', href: '/demo/admin/conteos', label: 'Conteos', order: 28, capabilityId: 'INV-008' },
      { id: 'asignacion', href: '/demo/admin/asignacion', label: 'Asignación', order: 29, capabilityId: 'INV-011' },
    ],
    routes: [
      { match: 'exact', path: '/demo/admin/ubicaciones', capabilityId: 'INV-005' },
      { match: 'prefix', path: '/api/admin/inventory-locations', capabilityId: 'INV-005' },
      { match: 'exact', path: '/demo/admin/transferencias', capabilityId: 'INV-007' },
      { match: 'prefix', path: '/api/admin/inventory-transfers', capabilityId: 'INV-007' },
      { match: 'exact', path: '/demo/admin/conteos', capabilityId: 'INV-008' },
      { match: 'prefix', path: '/api/admin/inventory-counts', capabilityId: 'INV-008' },
      { match: 'exact', path: '/demo/admin/asignacion', capabilityId: 'INV-011' },
      { match: 'prefix', path: '/api/admin/inventory-routing', capabilityId: 'INV-011' },
    ],
  },
  {
    id: 'cart', version: '1.0.0', capabilities: ['CHK-001'], dependencies: ['catalog'], permissions: [], events: [], subscriptions: [],
    jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI], navigation: [], routes: [],
  },
  {
    id: 'customers', version: '1.14.0', capabilities: ['CUS-001', 'CUS-002', 'CUS-003', 'CUS-004', 'CUS-005', 'CUS-006', 'CUS-007', 'CUS-008', 'CUS-009'], dependencies: ['platform-configuration'],
    permissions: ['customer:orders:read', 'customer:returns:read', 'customer:returns:create', 'customer:addresses:read', 'customer:addresses:write'], events: [], subscriptions: [], jobs: [], healthchecks: [],
    wikiLinks: [ARCHITECTURE_WIKI, CUSTOMER_PROFILE_ADR, CUSTOMER_CONSENT_ADR, CUSTOMER_DATA_RIGHTS_ADR, CUSTOMER_PASSWORDLESS_ADR, CUSTOMER_PASSWORDLESS_SURFACE_ADR, CUSTOMER_RESOURCE_OWNERSHIP_ADR, CUSTOMER_SEGMENTATION_ADR, CUSTOMER_PASSWORDLESS_RUNBOOK], navigation: [],
    routes: [
      { match: 'exact', path: '/cuenta/acceso', capabilityId: 'CUS-003' },
      { match: 'exact', path: '/cuenta/acceso/confirmar', capabilityId: 'CUS-003' },
      { match: 'exact', path: '/cuenta/sesiones', capabilityId: 'CUS-003' },
      { match: 'prefix', path: '/cuenta/pedidos', capabilityId: 'CUS-004' },
      { match: 'prefix', path: '/api/customer/orders/', capabilityId: 'CUS-004' },
      { match: 'exact', path: '/cuenta/devoluciones', capabilityId: 'CUS-005' },
      { match: 'prefix', path: '/cuenta/devoluciones/', capabilityId: 'CUS-005' },
      { match: 'exact', path: '/api/customer/returns', capabilityId: 'CUS-005' },
      { match: 'prefix', path: '/api/customer/returns/', capabilityId: 'CUS-005' },
      { match: 'prefix', path: '/cuenta/direcciones', capabilityId: 'CUS-006' },
      { match: 'prefix', path: '/api/customer/addresses', capabilityId: 'CUS-006' },
    ],
  },
  {
    id: 'orders', version: '1.10.0', capabilities: ['ORD-001', 'ORD-002', 'ORD-004', 'ORD-005', 'ORD-007', 'ORD-008', 'ORD-010', 'ORD-011', 'ORD-012', 'AUT-001', 'AUT-011'],
    dependencies: ['catalog', 'pricing', 'customers', 'inventory'], permissions: ['orders.read', 'orders.transition', 'orders.collaborate', 'orders.amend', 'orders.refund', 'orders.hold', 'orders.bulk', 'orders.documents.read', 'orders.documents.write', 'orders.preliminary.read', 'orders.preliminary.write'],
    events: ['orders.order_placed', 'orders.order_paid', 'orders.order_shipped', 'orders.order_delivered', 'orders.order_cancelled', 'orders.order_refunded', 'orders.order_partially_refunded', 'orders.order_amendment_requested', 'orders.order_amendment_applied', 'orders.order_amendment_expired', 'orders.order_hold_created', 'orders.order_hold_assigned', 'orders.order_hold_resolved'],
    subscriptions: [],
    jobs: ['orders.execute-bulk-action'], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI, R3_OPERATION_WIKI, R4_MODELS_WIKI, PRELIMINARY_ORDERS_WIKI],
    navigation: [
      { id: 'pedidos', href: '/demo/admin', label: 'Pedidos', order: 10, capabilityId: 'ORD-001' },
      { id: 'documentos', href: '/demo/admin/documentos', label: 'Documentos', order: 18, capabilityId: 'ORD-012' },
    ],
    routes: [
      { match: 'exact', path: '/demo/admin', capabilityId: 'ORD-001' },
      { match: 'prefix', path: '/demo/admin/pedidos/', capabilityId: 'ORD-001' },
      { match: 'prefix', path: '/api/admin/refunds/', capabilityId: 'ORD-007' },
      { match: 'prefix', path: '/api/admin/order-notes', capabilityId: 'ORD-004' },
      { match: 'prefix', path: '/api/admin/order-tags', capabilityId: 'ORD-004' },
      { match: 'prefix', path: '/api/admin/order-amendments', capabilityId: 'ORD-005' },
      { match: 'prefix', path: '/api/admin/preliminary-orders', capabilityId: 'ORD-008' },
      { match: 'prefix', path: '/api/admin/order-holds', capabilityId: 'ORD-010' },
      { match: 'prefix', path: '/api/admin/order-bulk-actions', capabilityId: 'ORD-011' },
      { match: 'exact', path: '/demo/admin/documentos', capabilityId: 'ORD-012' },
      { match: 'prefix', path: '/api/admin/order-documents', capabilityId: 'ORD-012' },
      { match: 'prefix', path: '/api/admin/orders/', capabilityId: 'ORD-002' },
    ],
  },
  {
    id: 'fulfillment', version: '1.3.1', capabilities: ['FUL-001', 'FUL-002', 'FUL-003', 'FUL-004', 'FUL-005', 'FUL-011'],
    dependencies: ['orders', 'inventory'], permissions: ['fulfillment.read', 'fulfillment.write', 'fulfillment.export', 'fulfillment.returns.read', 'fulfillment.returns.write'],
    events: ['fulfillment.fulfillment_shipped', 'fulfillment.fulfillment_delivered', 'fulfillment.return_resolved'],
    subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI, R3_OPERATION_WIKI],
    navigation: [
      { id: 'envios', href: '/demo/admin/envios', label: 'Envíos', order: 30, capabilityId: 'FUL-001' },
      { id: 'devoluciones', href: '/demo/admin/devoluciones', label: 'Devoluciones', order: 32, capabilityId: 'FUL-011' },
    ],
    routes: [
      { match: 'exact', path: '/demo/admin/envios', capabilityId: 'FUL-001' },
      { match: 'prefix', path: '/api/admin/shipping-rates/', capabilityId: 'FUL-001' },
      { match: 'exact', path: '/api/admin/orders/export.csv', capabilityId: 'FUL-003' },
      { match: 'prefix', path: '/api/admin/fulfillments', capabilityId: 'FUL-004' },
      { match: 'exact', path: '/demo/admin/devoluciones', capabilityId: 'FUL-011' },
      { match: 'prefix', path: '/api/admin/returns', capabilityId: 'FUL-011' },
    ],
  },
  {
    id: 'notifications', version: '1.1.0', capabilities: ['MAR-003', 'AUT-002', 'INT-002'],
    dependencies: ['platform-configuration'], permissions: ['notifications.read'], events: [],
    // Reacciona a hechos de `orders` SIN depender de `orders`: esa es la razón
    // de ser del sobre. Quien los une es el composition root.
    subscriptions: ['orders.order_paid', 'orders.order_shipped', 'orders.order_refunded', 'orders.order_partially_refunded', 'fulfillment.fulfillment_shipped'], jobs: ['notifications.event-outbox-sweep'], healthchecks: ['notifications.resend-email'],
    wikiLinks: [ARCHITECTURE_WIKI],
    navigation: [{ id: 'emails', href: '/demo/admin/emails', label: 'Emails', order: 40, capabilityId: 'MAR-003' }],
    routes: [{ match: 'exact', path: '/demo/admin/emails', capabilityId: 'MAR-003' }],
  },
  {
    id: 'payments', version: '1.1.0', capabilities: ['CHK-004', 'INT-001'], dependencies: ['platform-configuration'],
    permissions: [], events: [], subscriptions: [], jobs: [], healthchecks: ['payments.stripe-checkout'], wikiLinks: [ARCHITECTURE_WIKI], navigation: [],
    routes: [{ match: 'exact', path: '/api/webhooks/stripe', capabilityId: 'CHK-004' }],
  },
  {
    id: 'subscriptions', version: '1.1.0', capabilities: ['PRC-013'],
    dependencies: ['platform-configuration', 'catalog', 'pricing', 'payments', 'orders'],
    permissions: ['subscriptions.read', 'subscriptions.write'],
    events: [
      'subscriptions.subscription_created', 'subscriptions.subscription_activated',
      'subscriptions.payment_succeeded', 'subscriptions.payment_failed',
      'subscriptions.subscription_paused', 'subscriptions.subscription_resumed',
      'subscriptions.plan_changed', 'subscriptions.cancellation_scheduled',
      'subscriptions.subscription_cancelled',
    ],
    subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI, R4_MODELS_WIKI, SUBSCRIPTIONS_WIKI],
    navigation: [],
    routes: [{ match: 'prefix', path: '/api/admin/subscriptions', capabilityId: 'PRC-013' }],
  },
  {
    id: 'checkout', version: '1.3.0', capabilities: ['CHK-002', 'CHK-003', 'CHK-011'],
    dependencies: ['cart', 'catalog', 'pricing', 'inventory', 'fulfillment', 'customers', 'payments', 'orders'],
    permissions: [], events: [], subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI, R4_MODELS_WIKI, PRELIMINARY_ORDERS_WIKI], navigation: [],
    routes: [
      { match: 'exact', path: '/api/cart/quote', capabilityId: 'CHK-002' },
      { match: 'exact', path: '/api/checkout/session', capabilityId: 'CHK-003' },
      { match: 'prefix', path: '/api/admin/preliminary-order-payment-links', capabilityId: 'CHK-011' },
    ],
  },
  {
    id: 'integrations', version: '1.0.0', capabilities: ['INT-003'],
    dependencies: ['payments', 'fulfillment', 'notifications'], permissions: [], events: [], subscriptions: [], jobs: [], healthchecks: ['integrations.logistics-csv'],
    wikiLinks: [ARCHITECTURE_WIKI], navigation: [], routes: [],
  },
  {
    id: 'storefront', version: '1.0.0', capabilities: ['STO-001', 'STO-002', 'STO-008'],
    dependencies: ['platform-configuration', 'platform-security', 'catalog', 'pricing'], permissions: [], events: [], subscriptions: [],
    jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI], navigation: [], routes: [],
  },
  {
    id: 'marketing', version: '1.0.0', capabilities: ['MAR-001'], dependencies: ['customers', 'notifications'],
    permissions: [], events: [], subscriptions: [], jobs: [], healthchecks: [], wikiLinks: [ARCHITECTURE_WIKI], navigation: [], routes: [],
  },
] as const satisfies readonly ModuleDescriptor[];

export type AdminNavigationId = (typeof MODULE_DESCRIPTORS)[number]['navigation'][number]['id'];

export type ModuleRegistryIssue = Readonly<{
  code: 'invalid-descriptor' | 'duplicate-module' | 'unknown-dependency' | 'dependency-cycle' |
    'duplicate-capability' | 'missing-capability' | 'duplicate-navigation' | 'duplicate-route' |
    'duplicate-event' | 'foreign-event' | 'unknown-subscription' | 'duplicate-job' |
    'foreign-job' | 'duplicate-healthcheck';
  path: string;
  message: string;
}>;

export type ModuleRegistry = Readonly<{
  descriptors: readonly ModuleDescriptor[];
  byId: Readonly<Record<ModuleId, ModuleDescriptor>>;
  capabilityOwners: Readonly<Record<CapabilityId, ModuleId>>;
  /** Emisor único de cada tipo de evento, igual que `capabilityOwners`. */
  eventOwners: Readonly<Record<string, ModuleId>>;
  /** Propietario único de cada job ejecutable. */
  jobOwners: Readonly<Record<string, ModuleId>>;
  /** Propietario único de cada healthcheck ejecutable. */
  healthcheckOwners: Readonly<Record<string, ModuleId>>;
  navigation: readonly ModuleNavigationItem[];
  routes: readonly ModuleRoute[];
}>;

export type OperationalModule = Readonly<{
  descriptor: ModuleDescriptor;
  state: 'active' | 'degraded';
  activeCapabilities: readonly CapabilityId[];
  degradedCapabilities: readonly CapabilityId[];
}>;

const moduleIdSet = new Set<string>(MODULE_IDS);
const capabilityIdSet = new Set<string>(CAPABILITY_IDS);
const descriptorFields = ['id', 'version', 'capabilities', 'dependencies', 'permissions', 'events', 'subscriptions', 'jobs', 'healthchecks', 'wikiLinks', 'navigation', 'routes'];

/** Mismo patrón que el sobre: `modulo.hecho`, con el prefijo del módulo emisor. */
const EVENT_TYPE_PATTERN = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const JOB_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
const HEALTHCHECK_ID_PATTERN = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;

function eventPrefixOf(moduleId: string): string {
  return moduleId.replaceAll('-', '_');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function dependencyCycleIssues(descriptors: readonly ModuleDescriptor[]): ModuleRegistryIssue[] {
  const issues: ModuleRegistryIssue[] = [];
  const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
  const state = new Map<ModuleId, 'visiting' | 'done'>();
  const stack: ModuleId[] = [];
  const visit = (id: ModuleId): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      issues.push({ code: 'dependency-cycle', path: `modules.${id}`, message: `Ciclo: ${[...stack.slice(start), id].join(' -> ')}.` });
      return;
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) if (byId.has(dependency)) visit(dependency);
    stack.pop();
    state.set(id, 'done');
  };
  for (const id of byId.keys()) visit(id);
  return issues;
}

export function validateModuleRegistry(input: unknown): readonly ModuleRegistryIssue[] {
  const issues: ModuleRegistryIssue[] = [];
  if (!Array.isArray(input)) return [{ code: 'invalid-descriptor', path: 'modules', message: 'El registro debe ser un array.' }];

  const descriptors: ModuleDescriptor[] = [];
  const seenModules = new Set<string>();
  const capabilityOwners = new Map<string, string>();
  const eventOwners = new Map<string, string>();
  const jobOwners = new Map<string, string>();
  const healthcheckOwners = new Map<string, string>();
  const subscriptions: { path: string; type: string }[] = [];
  const navigationIds = new Set<string>();
  const navigationHrefs = new Set<string>();
  const routePaths = new Set<string>();

  input.forEach((raw, index) => {
    const path = `modules.${index}`;
    if (!isRecord(raw)) {
      issues.push({ code: 'invalid-descriptor', path, message: 'Descriptor inválido.' });
      return;
    }
    if (Object.keys(raw).some((key) => !descriptorFields.includes(key))) {
      issues.push({ code: 'invalid-descriptor', path, message: 'El descriptor contiene campos desconocidos.' });
    }
    const id = raw.id;
    if (typeof id !== 'string' || !moduleIdSet.has(id)) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.id`, message: 'Id de módulo desconocido.' });
      return;
    }
    if (seenModules.has(id)) issues.push({ code: 'duplicate-module', path: `${path}.id`, message: `Módulo duplicado: ${id}.` });
    seenModules.add(id);
    if (typeof raw.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
      issues.push({ code: 'invalid-descriptor', path: `${path}.version`, message: 'La versión debe ser semver estable.' });
    }
    for (const field of ['capabilities', 'dependencies', 'permissions', 'events', 'subscriptions', 'jobs', 'healthchecks', 'wikiLinks', 'navigation', 'routes']) {
      if (!Array.isArray(raw[field])) issues.push({ code: 'invalid-descriptor', path: `${path}.${field}`, message: `${field} debe ser un array.` });
    }
    for (const field of ['permissions', 'events', 'subscriptions', 'jobs', 'healthchecks', 'wikiLinks'] as const) {
      if (Array.isArray(raw[field]) && raw[field].some((value) => typeof value !== 'string' || value.length === 0)) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.${field}`, message: `${field} solo admite cadenas no vacías.` });
      }
    }
    if (!Array.isArray(raw.capabilities) || !Array.isArray(raw.dependencies) || !Array.isArray(raw.navigation) || !Array.isArray(raw.routes)) return;
    for (const capability of raw.capabilities) {
      if (typeof capability !== 'string' || !capabilityIdSet.has(capability)) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.capabilities`, message: `Capacidad desconocida: ${String(capability)}.` });
      } else if (capabilityOwners.has(capability)) {
        issues.push({ code: 'duplicate-capability', path: `${path}.capabilities`, message: `${capability} ya pertenece a ${capabilityOwners.get(capability)}.` });
      } else capabilityOwners.set(capability, id);
    }
    for (const dependency of raw.dependencies) {
      if (typeof dependency !== 'string' || !moduleIdSet.has(dependency)) {
        issues.push({ code: 'unknown-dependency', path: `${path}.dependencies`, message: `Dependencia desconocida: ${String(dependency)}.` });
      }
    }
    if (Array.isArray(raw.events)) {
      for (const event of raw.events) {
        if (typeof event !== 'string' || !EVENT_TYPE_PATTERN.test(event)) {
          issues.push({ code: 'invalid-descriptor', path: `${path}.events`, message: `Tipo de evento inválido: ${String(event)}.` });
        } else if (!event.startsWith(`${eventPrefixOf(id)}.`)) {
          issues.push({ code: 'foreign-event', path: `${path}.events`, message: `${event} no pertenece al espacio de ${id}.` });
        } else if (eventOwners.has(event)) {
          issues.push({ code: 'duplicate-event', path: `${path}.events`, message: `${event} ya lo emite ${eventOwners.get(event)}.` });
        } else eventOwners.set(event, id);
      }
    }
    if (Array.isArray(raw.subscriptions)) {
      for (const event of raw.subscriptions) {
        if (typeof event === 'string') subscriptions.push({ path: `${path}.subscriptions`, type: event });
      }
    }
    if (Array.isArray(raw.jobs)) {
      for (const job of raw.jobs) {
        if (typeof job !== 'string' || !JOB_ID_PATTERN.test(job)) {
          issues.push({ code: 'invalid-descriptor', path: `${path}.jobs`, message: `Job inválido: ${String(job)}.` });
          continue;
        }
        if (!job.startsWith(`${id}.`)) {
          issues.push({ code: 'foreign-job', path: `${path}.jobs`, message: `${job} no pertenece al espacio de ${id}.` });
        }
        if (jobOwners.has(job)) {
          issues.push({ code: 'duplicate-job', path: `${path}.jobs`, message: `${job} ya pertenece a ${jobOwners.get(job)}.` });
        } else jobOwners.set(job, id);
      }
    }
    if (Array.isArray(raw.healthchecks)) {
      for (const healthcheck of raw.healthchecks) {
        if (typeof healthcheck !== 'string' || !HEALTHCHECK_ID_PATTERN.test(healthcheck)) {
          issues.push({ code: 'invalid-descriptor', path: `${path}.healthchecks`, message: `Healthcheck inválido: ${String(healthcheck)}.` });
        } else if (healthcheckOwners.has(healthcheck)) {
          issues.push({ code: 'duplicate-healthcheck', path: `${path}.healthchecks`, message: `${healthcheck} ya pertenece a ${healthcheckOwners.get(healthcheck)}.` });
        } else healthcheckOwners.set(healthcheck, id);
      }
    }
    for (const [navIndex, navigation] of raw.navigation.entries()) {
      if (!isRecord(navigation) || typeof navigation.id !== 'string' || typeof navigation.href !== 'string' ||
          !navigation.href.startsWith('/') || typeof navigation.label !== 'string' ||
          typeof navigation.order !== 'number' || !Number.isFinite(navigation.order) ||
          typeof navigation.capabilityId !== 'string' ||
          !raw.capabilities.includes(navigation.capabilityId)) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.navigation.${navIndex}`, message: 'Entrada de navegación inválida o ajena al módulo.' });
        continue;
      }
      if (navigationIds.has(navigation.id) || navigationHrefs.has(navigation.href)) {
        issues.push({ code: 'duplicate-navigation', path: `${path}.navigation.${navIndex}`, message: `Id o href de navegación duplicado: ${navigation.id} · ${navigation.href}.` });
      }
      navigationIds.add(navigation.id);
      navigationHrefs.add(navigation.href);
    }
    for (const [routeIndex, route] of raw.routes.entries()) {
      if (!isRecord(route) || (route.match !== 'exact' && route.match !== 'prefix') || typeof route.path !== 'string' ||
          !route.path.startsWith('/') || typeof route.capabilityId !== 'string' || !raw.capabilities.includes(route.capabilityId)) {
        issues.push({ code: 'invalid-descriptor', path: `${path}.routes.${routeIndex}`, message: 'Ruta inválida o ajena al módulo.' });
        continue;
      }
      if (routePaths.has(route.path)) issues.push({ code: 'duplicate-route', path: `${path}.routes.${routeIndex}`, message: `Ruta duplicada: ${route.path}.` });
      routePaths.add(route.path);
    }
    descriptors.push(raw as unknown as ModuleDescriptor);
  });

  for (const id of MODULE_IDS) {
    if (!seenModules.has(id)) issues.push({ code: 'invalid-descriptor', path: `modules.${id}`, message: `Falta el módulo ${id}.` });
  }
  for (const capability of CAPABILITY_IDS) {
    if (!capabilityOwners.has(capability)) issues.push({ code: 'missing-capability', path: `capabilities.${capability}`, message: `${capability} no tiene módulo propietario.` });
  }
  // Una suscripción a un hecho que nadie emite es una promesa muerta: se rechaza
  // aquí y no en producción, cuando el consumidor calla para siempre.
  for (const subscription of subscriptions) {
    if (!eventOwners.has(subscription.type)) {
      issues.push({ code: 'unknown-subscription', path: subscription.path, message: `Ningún módulo emite ${subscription.type}.` });
    }
  }
  issues.push(...dependencyCycleIssues(descriptors));
  return issues;
}

export class ModuleRegistryError extends Error {
  readonly issues: readonly ModuleRegistryIssue[];

  constructor(issues: readonly ModuleRegistryIssue[]) {
    super(`Registro de módulos inválido:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join('\n')}`);
    this.name = 'ModuleRegistryError';
    this.issues = issues;
  }
}

export function createModuleRegistry(input: unknown = MODULE_DESCRIPTORS): ModuleRegistry {
  const issues = validateModuleRegistry(input);
  if (issues.length > 0) throw new ModuleRegistryError(issues);
  const descriptors = Object.freeze((input as readonly ModuleDescriptor[]).map((descriptor): ModuleDescriptor =>
    Object.freeze({
      ...descriptor,
      capabilities: Object.freeze([...descriptor.capabilities]),
      dependencies: Object.freeze([...descriptor.dependencies]),
      permissions: Object.freeze([...descriptor.permissions]),
      events: Object.freeze([...descriptor.events]),
      subscriptions: Object.freeze([...descriptor.subscriptions]),
      jobs: Object.freeze([...descriptor.jobs]),
      healthchecks: Object.freeze([...descriptor.healthchecks]),
      wikiLinks: Object.freeze([...descriptor.wikiLinks]),
      navigation: Object.freeze(descriptor.navigation.map((item) => Object.freeze({ ...item }))),
      routes: Object.freeze(descriptor.routes.map((route) => Object.freeze({ ...route }))),
    }),
  ));
  const byId = Object.freeze(Object.fromEntries(descriptors.map((descriptor) => [descriptor.id, descriptor]))) as Readonly<Record<ModuleId, ModuleDescriptor>>;
  const capabilityOwners = Object.freeze(Object.fromEntries(descriptors.flatMap((descriptor) =>
    descriptor.capabilities.map((capability) => [capability, descriptor.id]),
  ))) as Readonly<Record<CapabilityId, ModuleId>>;
  const eventOwners = Object.freeze(Object.fromEntries(descriptors.flatMap((descriptor) =>
    descriptor.events.map((event) => [event, descriptor.id]),
  ))) as Readonly<Record<string, ModuleId>>;
  const jobOwners = Object.freeze(Object.fromEntries(descriptors.flatMap((descriptor) =>
    descriptor.jobs.map((job) => [job, descriptor.id]),
  ))) as Readonly<Record<string, ModuleId>>;
  const healthcheckOwners = Object.freeze(Object.fromEntries(descriptors.flatMap((descriptor) =>
    descriptor.healthchecks.map((healthcheck) => [healthcheck, descriptor.id]),
  ))) as Readonly<Record<string, ModuleId>>;
  const navigation = Object.freeze(descriptors.flatMap((descriptor) => descriptor.navigation).toSorted((a, b) => a.order - b.order));
  const routes = Object.freeze(descriptors.flatMap((descriptor) => descriptor.routes).toSorted((a, b) =>
    (a.match === b.match ? b.path.length - a.path.length : a.match === 'exact' ? -1 : 1),
  ));
  return Object.freeze({ descriptors, byId, capabilityOwners, eventOwners, jobOwners, healthcheckOwners, navigation, routes });
}

export function resolveOperationalModules(
  registry: ModuleRegistry,
  manifest: ResolvedCapabilityManifest,
): readonly OperationalModule[] {
  const modules = registry.descriptors.flatMap((descriptor): OperationalModule[] => {
    const activeCapabilities = descriptor.capabilities.filter((id) => manifest.capabilities[id].state === 'active');
    const degradedCapabilities = descriptor.capabilities.filter((id) => manifest.capabilities[id].state === 'degraded');
    if (activeCapabilities.length === 0 && degradedCapabilities.length === 0) return [];
    return [{
      descriptor,
      state: activeCapabilities.length > 0 ? 'active' : 'degraded',
      activeCapabilities: Object.freeze(activeCapabilities),
      degradedCapabilities: Object.freeze(degradedCapabilities),
    }];
  });
  const operationalIds = new Set(modules.map((module) => module.descriptor.id));
  for (const module of modules) {
    const missing = module.descriptor.dependencies.filter((dependency) => !operationalIds.has(dependency));
    if (missing.length > 0) {
      throw new ModuleRegistryError([{ code: 'unknown-dependency', path: `modules.${module.descriptor.id}.dependencies`, message: `Dependencias no operativas: ${missing.join(', ')}.` }]);
    }
  }
  return Object.freeze(modules);
}

export const MODULE_REGISTRY = createModuleRegistry();
