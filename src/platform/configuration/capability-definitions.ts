export const CAPABILITY_IDS = [
  'PLT-001',
  'PLT-004',
  'CAT-001',
  'CAT-002',
  'CAT-003',
  'CAT-007',
  'CAT-008',
  'INV-001',
  'INV-004',
  'INV-005',
  'INV-007',
  'INV-008',
  'INV-011',
  'PRC-001',
  'PRC-002',
  'PRC-003',
  'PRC-004',
  'PRC-005',
  'PRC-006',
  'PRC-007',
  'PRC-008',
  'PRC-009',
  'PRC-010',
  'PRC-011',
  'PRC-012',
  'PRC-013',
  'PRC-014',
  'CHK-001',
  'CHK-002',
  'CHK-003',
  'CHK-004',
  'CHK-011',
  'ORD-001',
  'ORD-002',
  'ORD-004',
  'ORD-005',
  'ORD-007',
  'ORD-008',
  'ORD-010',
  'ORD-011',
  'ORD-012',
  'FUL-001',
  'FUL-002',
  'FUL-003',
  'FUL-004',
  'FUL-005',
  'FUL-011',
  'CUS-001',
  'CUS-002',
  'CUS-003',
  'CUS-004',
  'CUS-005',
  'CUS-006',
  'CUS-007',
  'CUS-008',
  'CUS-009',
  'STO-001',
  'STO-002',
  'STO-008',
  'MKT-001',
  'MKT-002',
  'MAR-001',
  'MAR-003',
  'AUT-001',
  'AUT-002',
  'AUT-011',
  'INT-001',
  'INT-002',
  'INT-003',
  'INT-004',
  'SEC-001',
  'SEC-003',
  'SEC-004',
  'SEC-012',
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

export type CapabilityDefinition = Readonly<{
  dependencies: readonly CapabilityId[];
}>;

/**
 * Dependencias operativas, no imports físicos. R1.4 añadirá el descriptor de
 * módulo; este mapa solo permite validar combinaciones del manifest de R1.2.
 */
export const CAPABILITY_DEFINITIONS: Readonly<Record<CapabilityId, CapabilityDefinition>> = {
  'PLT-001': { dependencies: [] },
  'PLT-004': { dependencies: ['PLT-001'] },
  'CAT-001': { dependencies: ['PLT-004'] },
  'CAT-002': { dependencies: ['CAT-001'] },
  'CAT-003': { dependencies: ['CAT-001'] },
  'CAT-007': { dependencies: ['CAT-001'] },
  'CAT-008': { dependencies: ['CAT-001'] },
  'INV-001': { dependencies: ['CAT-001'] },
  'INV-004': { dependencies: ['INV-001', 'CHK-003', 'ORD-001', 'AUT-002'] },
  'INV-005': { dependencies: ['INV-001'] },
  'INV-007': { dependencies: ['INV-005'] },
  'INV-008': { dependencies: ['INV-005'] },
  'INV-011': { dependencies: ['INV-005', 'FUL-004'] },
  'PRC-001': { dependencies: ['CAT-001', 'MKT-001'] },
  'PRC-002': { dependencies: ['PRC-001'] },
  'PRC-003': { dependencies: ['PRC-001'] },
  'PRC-004': { dependencies: ['PRC-003', 'ORD-001', 'CHK-002'] },
  'PRC-005': { dependencies: ['PRC-003', 'ORD-001', 'CHK-002'] },
  'PRC-006': { dependencies: ['PRC-003', 'ORD-001', 'CHK-002'] },
  'PRC-007': { dependencies: ['PRC-006'] },
  'PRC-008': { dependencies: ['PRC-004', 'PRC-005', 'PRC-006'] },
  'PRC-009': { dependencies: ['PRC-001', 'ORD-001', 'CHK-002'] },
  'PRC-010': { dependencies: ['PRC-001', 'ORD-001', 'CHK-003', 'INT-001'] },
  'PRC-011': { dependencies: ['PRC-010', 'CUS-001'] },
  'PRC-012': { dependencies: ['PRC-001', 'INV-004', 'ORD-001', 'CHK-002', 'FUL-004'] },
  'PRC-013': { dependencies: ['PRC-001', 'CHK-003', 'ORD-001', 'INT-001', 'AUT-002'] },
  'PRC-014': { dependencies: ['PRC-001', 'INV-004', 'ORD-001', 'CHK-002', 'FUL-004', 'AUT-002'] },
  'CHK-001': { dependencies: ['CAT-001'] },
  'CHK-002': { dependencies: ['CHK-001', 'CAT-001', 'INV-001', 'PRC-001', 'FUL-001'] },
  'CHK-003': { dependencies: ['CHK-002', 'CUS-001', 'ORD-001', 'INT-001'] },
  'CHK-004': { dependencies: ['CHK-003', 'INV-001', 'ORD-002', 'AUT-002', 'INT-001'] },
  'CHK-011': { dependencies: ['CHK-003', 'CHK-004', 'ORD-008', 'INT-001'] },
  'ORD-001': { dependencies: ['PRC-001', 'CUS-001'] },
  'ORD-002': { dependencies: ['ORD-001'] },
  'ORD-004': { dependencies: ['ORD-001', 'AUT-001'] },
  'ORD-005': { dependencies: ['ORD-002', 'INV-004', 'FUL-001', 'INT-001', 'AUT-002'] },
  'ORD-007': { dependencies: ['ORD-002', 'INV-001', 'AUT-002', 'INT-001', 'MAR-003'] },
  'ORD-008': { dependencies: ['ORD-001', 'PRC-001', 'CUS-001', 'INV-004'] },
  'ORD-010': { dependencies: ['ORD-002', 'ORD-004', 'FUL-004', 'AUT-001'] },
  'ORD-011': { dependencies: ['ORD-002', 'ORD-004', 'ORD-010', 'AUT-011'] },
  'ORD-012': { dependencies: ['ORD-002', 'ORD-007', 'FUL-004', 'AUT-001'] },
  'FUL-001': { dependencies: ['PRC-001', 'MKT-002'] },
  'FUL-002': { dependencies: ['ORD-002', 'MAR-003'] },
  'FUL-003': { dependencies: ['ORD-001'] },
  'FUL-004': { dependencies: ['FUL-002'] },
  'FUL-005': { dependencies: ['FUL-004'] },
  'FUL-011': { dependencies: ['FUL-005', 'INV-005', 'ORD-007'] },
  'CUS-001': { dependencies: ['PLT-004'] },
  'CUS-002': { dependencies: ['CUS-001'] },
  'CUS-003': { dependencies: ['CUS-002', 'INT-002', 'SEC-003', 'SEC-004'] },
  'CUS-004': { dependencies: ['CUS-003', 'ORD-001', 'SEC-003', 'SEC-004'] },
  'CUS-005': { dependencies: ['CUS-003', 'CUS-004', 'FUL-011', 'SEC-003', 'SEC-004'] },
  'CUS-006': { dependencies: ['CUS-003', 'SEC-003', 'SEC-004'] },
  'CUS-007': { dependencies: ['CUS-001'] },
  'CUS-008': { dependencies: ['CUS-001'] },
  'CUS-009': { dependencies: ['CUS-002', 'ORD-001'] },
  'STO-001': { dependencies: ['CAT-001', 'PRC-001', 'SEC-012'] },
  'STO-002': { dependencies: ['CAT-002', 'STO-001'] },
  'STO-008': { dependencies: ['CAT-001', 'STO-001'] },
  'MKT-001': { dependencies: ['PLT-004'] },
  'MKT-002': { dependencies: ['PLT-004'] },
  'MAR-001': { dependencies: ['SEC-003', 'SEC-004'] },
  'MAR-003': { dependencies: ['AUT-002'] },
  'AUT-001': { dependencies: ['ORD-002'] },
  'AUT-002': { dependencies: ['PLT-004'] },
  'AUT-011': { dependencies: ['PLT-004'] },
  'INT-001': { dependencies: ['PLT-004'] },
  'INT-002': { dependencies: ['MAR-003'] },
  'INT-003': { dependencies: ['FUL-003'] },
  'INT-004': { dependencies: ['SEC-001'] },
  'SEC-001': { dependencies: ['PLT-004'] },
  'SEC-003': { dependencies: ['PLT-004'] },
  'SEC-004': { dependencies: ['PLT-004'] },
  'SEC-012': { dependencies: ['PLT-004'] },
};

export type CapabilityConfigById = {
  'PLT-004': Readonly<{ failFast: true }>;
  'FUL-001': Readonly<{ strategy: 'flat-zone'; supportsFreeThreshold: boolean }>;
  'MKT-001': Readonly<{ currency: 'EUR' }>;
  'MKT-002': Readonly<{ country: 'ES'; resolver: 'postal-prefix' }>;
  'MAR-003': Readonly<{ demoDelivery: 'outbox'; clientDelivery: 'provider' }>;
  'INT-001': Readonly<{
    provider: 'stripe-checkout';
    secretRefs: readonly ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
  }>;
  'INT-002':
    | Readonly<{ provider: 'resend'; delivery: 'capture' }>
    | Readonly<{ provider: 'resend'; delivery: 'send'; secretRef: 'RESEND_API_KEY' }>;
  'CUS-003': Readonly<{
    methods: readonly ['email_magic_link'];
    provider: 'resend';
    origin: `https://${string}`;
    challengeTtlSeconds: 600;
    session: Readonly<{
      idleTtlSeconds: number;
      absoluteTtlSeconds: number;
    }>;
    secretRefs: readonly [
      'CUSTOMER_PROFILE_HMAC_SECRET',
      'CUSTOMER_AUTH_CSRF_SECRET',
      'RESEND_API_KEY',
    ];
    rateLimit: Readonly<{
      enforcement: 'edge-durable';
      failClosed: true;
      attestationRef: string;
    }>;
    tracking: Readonly<{
      click: false;
      open: false;
      attestationRef: string;
    }>;
  }>;
};

export type ConfiguredCapabilityId = keyof CapabilityConfigById;

export const CONFIGURED_CAPABILITY_IDS = [
  'PLT-004',
  'FUL-001',
  'MKT-001',
  'MKT-002',
  'MAR-003',
  'INT-001',
  'INT-002',
  'CUS-003',
] as const satisfies readonly ConfiguredCapabilityId[];
