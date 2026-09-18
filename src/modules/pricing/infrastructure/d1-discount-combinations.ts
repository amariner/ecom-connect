import type { DiscountCombinationPolicy } from '../domain/discount-combination';

type PolicyRow = Readonly<{
  id: string; version: number; label: string; state: DiscountCombinationPolicy['state'];
  priority: number; currency: string; active_from: string | null; active_until: string | null;
  markets_json: string; channels_json: string; maximum_discount_basis_points: number;
}>;

type SourcePairRow = Readonly<{
  policy_id: string; left_source: DiscountCombinationPolicy['sourcePairs'][number]['left'];
  right_source: DiscountCombinationPolicy['sourcePairs'][number]['right'];
}>;

type ClassPairRow = Readonly<{
  policy_id: string; left_class: DiscountCombinationPolicy['classPairs'][number]['left'];
  right_class: DiscountCombinationPolicy['classPairs'][number]['right'];
}>;

export type DiscountCombinationApplication = Readonly<{
  policyId: string;
  policyVersion: number;
  discountCents: number;
  snapshot: Readonly<Record<string, unknown>>;
}>;

function tokens(value: string, label: string): readonly string[] {
  const parsed = JSON.parse(value) as unknown;
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`${label} persistido inválido.`);
  }
  return Object.freeze(parsed as string[]);
}

function toPolicy(
  row: PolicyRow,
  sourcePairs: readonly SourcePairRow[],
  classPairs: readonly ClassPairRow[],
): DiscountCombinationPolicy {
  return Object.freeze({
    id: row.id, version: row.version, label: row.label, state: row.state,
    priority: row.priority, currency: row.currency, activeFrom: row.active_from,
    activeUntil: row.active_until, markets: tokens(row.markets_json, 'markets_json'),
    channels: tokens(row.channels_json, 'channels_json'),
    maximumDiscountBasisPoints: row.maximum_discount_basis_points,
    sourcePairs: Object.freeze(sourcePairs.filter((pair) => pair.policy_id === row.id)
      .map((pair) => Object.freeze({ left: pair.left_source, right: pair.right_source }))),
    classPairs: Object.freeze(classPairs.filter((pair) => pair.policy_id === row.id)
      .map((pair) => Object.freeze({ left: pair.left_class, right: pair.right_class }))),
  });
}

export function createD1DiscountCombinations(db: D1Database) {
  return Object.freeze({
    async listActive(): Promise<readonly DiscountCombinationPolicy[]> {
      const { results: rows } = await db.prepare(`SELECT id, version, label, state, priority,
        currency, active_from, active_until, markets_json, channels_json,
        maximum_discount_basis_points FROM discount_combination_policies
        WHERE state='active' ORDER BY priority, id`).all<PolicyRow>();
      if (rows.length === 0) return [];
      const [sourceResult, classResult] = await Promise.all([
        db.prepare(`SELECT policy_id, left_source, right_source
          FROM discount_combination_source_pairs ORDER BY policy_id, left_source, right_source`).all<SourcePairRow>(),
        db.prepare(`SELECT policy_id, left_class, right_class
          FROM discount_combination_class_pairs ORDER BY policy_id, left_class, right_class`).all<ClassPairRow>(),
      ]);
      return Object.freeze(rows.map((row) => toPolicy(row, sourceResult.results, classResult.results)));
    },

    applicationStatement(
      orderNumber: string,
      application: DiscountCombinationApplication,
      appliedAt: string,
    ): D1PreparedStatement {
      return db.prepare(`INSERT INTO discount_combination_applications (
        id, policy_id, policy_version, order_id, discount_cents,
        snapshot_json, idempotency_key, applied_at
      ) SELECT ?, ?, ?, o.id, ?, ?, ?, ? FROM orders o WHERE o.order_number=?`).bind(
        `combination_app_${crypto.randomUUID()}`,
        application.policyId,
        application.policyVersion,
        application.discountCents,
        JSON.stringify(application.snapshot),
        `combination:order:${orderNumber}`,
        appliedAt,
        orderNumber,
      );
    },
  });
}
