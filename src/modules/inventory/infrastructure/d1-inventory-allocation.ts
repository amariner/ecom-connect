import type { InventoryRoutingCandidate } from '../domain/inventory-allocation';

export type InventoryRoutingPolicyRecord = Readonly<{
  location_id: number;
  location_name: string;
  location_code: string;
  is_primary: number;
  priority: number;
  handling_cost_cents: number;
  markets_json: string;
  channels_json: string;
  enabled: number;
  version: number;
  updated_at: string;
}>;

export type InventoryAllocationDecisionRecord = Readonly<{
  id: string;
  fulfillment_id: number;
  order_id: number;
  order_number: string;
  location_id: number;
  location_name: string;
  location_code: string;
  market: string;
  channel: string;
  policy_version: number;
  explanation_json: string;
  line_count: number;
  quantity: number;
  created_at: string;
}>;

export function createD1InventoryAllocation(db: D1Database) {
  async function policies(): Promise<readonly InventoryRoutingPolicyRecord[]> {
    const { results } = await db.prepare(`SELECT p.*, l.name AS location_name,
      l.code AS location_code, l.is_primary
      FROM inventory_routing_policies p
      JOIN inventory_locations l ON l.id = p.location_id
      ORDER BY p.enabled DESC, p.priority, p.handling_cost_cents, l.id`)
      .all<InventoryRoutingPolicyRecord>();
    return Object.freeze(results.map((row) => Object.freeze(row)));
  }

  return Object.freeze({
    policies,

    async candidates(variantIds: readonly number[], committedByVariant: ReadonlyMap<number, number>): Promise<readonly InventoryRoutingCandidate[]> {
      const routingPolicies = await policies();
      const ids = [...new Set(variantIds)];
      if (ids.length === 0) return [];
      const { results } = await db.prepare(`SELECT location_id, variant_id,
        on_hand - reserved AS available FROM inventory_location_balances
        WHERE variant_id IN (${ids.map(() => '?').join(',')})`)
        .bind(...ids).all<{ location_id: number; variant_id: number; available: number }>();
      const balances = new Map(results.map((row) => [`${row.location_id}:${row.variant_id}`, row.available]));
      return Object.freeze(routingPolicies.filter((policy) => policy.enabled === 1).map((policy) => Object.freeze({
        locationId: policy.location_id,
        code: policy.location_code,
        isPrimary: policy.is_primary === 1,
        priority: policy.priority,
        handlingCostCents: policy.handling_cost_cents,
        policyVersion: policy.version,
        markets: Object.freeze(JSON.parse(policy.markets_json) as string[]),
        channels: Object.freeze(JSON.parse(policy.channels_json) as string[]),
        availableByVariant: Object.freeze(Object.fromEntries(ids.map((variantId) => [
          variantId,
          (balances.get(`${policy.location_id}:${variantId}`) ?? 0) +
            (policy.is_primary === 1 ? (committedByVariant.get(variantId) ?? 0) : 0),
        ]))),
      })));
    },

    async decisions(): Promise<readonly InventoryAllocationDecisionRecord[]> {
      const { results } = await db.prepare(`SELECT d.*, o.order_number,
        l.name AS location_name, l.code AS location_code,
        count(lines.order_item_id) AS line_count,
        COALESCE(sum(lines.quantity), 0) AS quantity
        FROM inventory_allocation_decisions d
        JOIN orders o ON o.id = d.order_id
        JOIN inventory_locations l ON l.id = d.location_id
        LEFT JOIN inventory_allocation_lines lines ON lines.decision_id = d.id
        GROUP BY d.id ORDER BY d.created_at DESC, d.id DESC LIMIT 100`)
        .all<InventoryAllocationDecisionRecord>();
      return Object.freeze(results.map((row) => Object.freeze(row)));
    },
  });
}

export type D1InventoryAllocation = ReturnType<typeof createD1InventoryAllocation>;
