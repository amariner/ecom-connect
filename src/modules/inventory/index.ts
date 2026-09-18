export {
  APPLY_INVENTORY_DELTA_SQL,
  INVENTORY_MOVEMENT_REASONS,
  INVENTORY_POLICY,
  INVENTORY_RESERVATION_STATES,
  availableStock,
  canTransitionReservation,
  planInventoryMovement,
} from './domain/inventory-ledger';

export {
  INVENTORY_RESERVATION_POLICY,
  assertReservationCreation,
  assertReservationTransition,
  reservationExpiry,
} from './domain/inventory-reservation';

export type {
  InventoryActorKind,
  InventoryBalance,
  InventoryMovementDraft,
  InventoryMovementReason,
  InventoryReservationState,
} from './domain/inventory-ledger';
export type {
  InventoryReservation,
  InventoryReservationLine,
  InventoryReservationOwnerType,
} from './domain/inventory-reservation';

export { createD1InventoryLedger } from './infrastructure/d1-inventory-ledger';
export {
  createD1InventoryCounts,
  type D1InventoryCounts,
  type InventoryCountDetail,
  type InventoryCountLineRecord,
  type InventoryCountRecord,
  type InventoryCountStockOption,
} from './infrastructure/d1-inventory-counts';
export { createD1InventoryReservations } from './infrastructure/d1-inventory-reservations';
export { createD1InventoryLocations, type InventoryLocationRecord } from './infrastructure/d1-inventory-locations';
export {
  INVENTORY_COUNT_POLICY,
  INVENTORY_COUNT_REASONS,
  INVENTORY_COUNT_STATUSES,
  assertInventoryCountDraft,
  assertInventoryCountReviewer,
  type InventoryCountLineDraft,
  type InventoryCountReason,
  type InventoryCountStatus,
} from './domain/inventory-count';
export {
  createD1InventoryTransfers,
  type D1InventoryTransfers,
  type InventoryTransferDetail,
  type InventoryTransferLineRecord,
  type InventoryTransferRecord,
  type InventoryTransferStockOption,
} from './infrastructure/d1-inventory-transfers';
export {
  INVENTORY_TRANSFER_POLICY,
  INVENTORY_TRANSFER_STATUSES,
  assertInventoryTransferDraft,
  assertInventoryTransferReceipt,
  transferStatusAfterReceipt,
  type InventoryTransferLineDraft,
  type InventoryTransferReceiptDraft,
  type InventoryTransferStatus,
} from './domain/inventory-transfer';
export {
  INVENTORY_LOCATION_KINDS,
  INVENTORY_LOCATION_STATUSES,
  assertInventoryLocationInput,
  normalizeInventoryLocationCode,
  type InventoryLocationKind,
  type InventoryLocationStatus,
} from './domain/inventory-location';
export {
  planInventoryRouting,
  type InventoryRoutingCandidate,
  type InventoryRoutingCandidateExplanation,
  type InventoryRoutingDemand,
  type InventoryRoutingPlan,
} from './domain/inventory-allocation';
export {
  createD1InventoryAllocation,
  type D1InventoryAllocation,
  type InventoryAllocationDecisionRecord,
  type InventoryRoutingPolicyRecord,
} from './infrastructure/d1-inventory-allocation';
export type {
  D1InventoryLedger,
  InventoryStockChange,
  InventoryWriteGuard,
} from './infrastructure/d1-inventory-ledger';
export type {
  D1InventoryReservations,
  ReservationGuard,
  ReservationSourceLine,
  VariantReservationSourceLine,
} from './infrastructure/d1-inventory-reservations';
