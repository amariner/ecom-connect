export const BUNDLE_STATES = ['active', 'disabled', 'archived'] as const;
export const BUNDLE_KINDS = ['fixed', 'configurable'] as const;
export type BundleState = (typeof BUNDLE_STATES)[number];
export type BundleKind = (typeof BUNDLE_KINDS)[number];

export type BundleComponent = Readonly<{ productId: number; quantity: number }>;
export type BundleOption = BundleComponent & Readonly<{ isDefault: boolean }>;
export type BundleGroup = Readonly<{
  id: string;
  label: string;
  minimumSelections: number;
  maximumSelections: number;
  options: readonly BundleOption[];
}>;
export type BundleDefinition = Readonly<{
  id: string;
  version: number;
  label: string;
  state: BundleState;
  kind: BundleKind;
  productId: number;
  components: readonly BundleComponent[];
  groups: readonly BundleGroup[];
}>;
export type BundleSelection = Readonly<{ groupId: string; productId: number }>;
export type BundleResolution = Readonly<{
  bundle: BundleDefinition;
  selections: readonly BundleSelection[];
  components: readonly BundleComponent[];
  availableStock: number;
  snapshot: Readonly<{
    schema: 1;
    bundle_id: string;
    version: number;
    kind: BundleKind;
    label: string;
    selections: readonly Readonly<{ group_id: string; product_id: number }>[];
    components: readonly Readonly<{ product_id: number; quantity_per_bundle: number }>[];
    stock_policy: 'minimum_component_availability';
    amendment_policy: 'composition_frozen';
    return_policy: 'restock_components';
  }>;
}>;

function integer(value: number, label: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label} inválido.`);
}
function token(value: string, label: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(value)) throw new RangeError(`${label} inválido.`);
}

export function assertBundle(bundle: BundleDefinition): void {
  token(bundle.id, 'bundle.id');
  integer(bundle.version, 'bundle.version', 1, 1_000_000);
  if (bundle.label.trim().length < 2 || bundle.label.trim().length > 120) throw new RangeError('bundle.label inválido.');
  if (!BUNDLE_STATES.includes(bundle.state)) throw new RangeError('bundle.state inválido.');
  if (!BUNDLE_KINDS.includes(bundle.kind)) throw new RangeError('bundle.kind inválido.');
  integer(bundle.productId, 'bundle.productId', 1, 2_147_483_647);
  const products = new Set<number>();
  const validateComponent = (component: BundleComponent, label: string) => {
    integer(component.productId, `${label}.productId`, 1, 2_147_483_647);
    integer(component.quantity, `${label}.quantity`, 1, 99);
    if (component.productId === bundle.productId || products.has(component.productId)) {
      throw new RangeError('Un componente no puede ser el bundle ni repetirse.');
    }
    products.add(component.productId);
  };
  if (bundle.kind === 'fixed') {
    if (bundle.components.length < 1 || bundle.components.length > 100 || bundle.groups.length !== 0) {
      throw new RangeError('Un bundle fijo exige componentes y no admite grupos.');
    }
    bundle.components.forEach((component) => validateComponent(component, 'bundle.components'));
    return;
  }
  if (bundle.components.length !== 0 || bundle.groups.length < 1 || bundle.groups.length > 20) {
    throw new RangeError('Un bundle configurable exige grupos y no admite componentes fijos.');
  }
  const groups = new Set<string>();
  for (const group of bundle.groups) {
    token(group.id, 'bundle.group.id');
    if (groups.has(group.id)) throw new RangeError('bundle.groups duplicados.');
    groups.add(group.id);
    if (group.label.trim().length < 2 || group.label.trim().length > 120) throw new RangeError('bundle.group.label inválido.');
    integer(group.minimumSelections, 'bundle.group.minimumSelections', 0, 20);
    integer(group.maximumSelections, 'bundle.group.maximumSelections', 1, 20);
    if (group.minimumSelections > group.maximumSelections || group.maximumSelections > group.options.length ||
        group.options.length < 1 || group.options.length > 100) throw new RangeError('Selecciones de grupo inválidas.');
    let defaults = 0;
    for (const option of group.options) {
      validateComponent(option, `bundle.group.${group.id}.option`);
      if (option.isDefault) defaults += 1;
    }
    if (defaults < group.minimumSelections || defaults > group.maximumSelections) {
      throw new RangeError('Los defaults no satisfacen el grupo.');
    }
  }
}

export function resolveBundle(input: Readonly<{
  bundle: BundleDefinition;
  selections?: readonly BundleSelection[];
  availableByProduct: ReadonlyMap<number, number>;
}>): BundleResolution {
  assertBundle(input.bundle);
  if (input.bundle.state !== 'active') throw new RangeError('El bundle no está activo.');
  const rawSelections = input.selections ?? [];
  let selections: readonly BundleSelection[] = [];
  let components: readonly BundleComponent[];
  if (input.bundle.kind === 'fixed') {
    if (rawSelections.length > 0) throw new RangeError('Un bundle fijo no admite selecciones.');
    components = input.bundle.components;
  } else {
    const selectedByGroup = new Map<string, Set<number>>();
    for (const selection of rawSelections) {
      const selected = selectedByGroup.get(selection.groupId) ?? new Set<number>();
      if (selected.has(selection.productId)) throw new RangeError('Selección de bundle duplicada.');
      selected.add(selection.productId);
      selectedByGroup.set(selection.groupId, selected);
    }
    const resolvedSelections: BundleSelection[] = [];
    const resolvedComponents: BundleComponent[] = [];
    for (const group of input.bundle.groups) {
      const explicit = selectedByGroup.get(group.id);
      const selected = explicit ?? new Set(group.options.filter((option) => option.isDefault).map((option) => option.productId));
      if (selected.size < group.minimumSelections || selected.size > group.maximumSelections) {
        throw new RangeError(`El grupo ${group.id} no cumple sus selecciones.`);
      }
      for (const productId of selected) {
        const option = group.options.find((candidate) => candidate.productId === productId);
        if (!option) throw new RangeError(`Opción ajena al grupo ${group.id}.`);
        resolvedSelections.push(Object.freeze({ groupId: group.id, productId }));
        resolvedComponents.push(Object.freeze({ productId, quantity: option.quantity }));
      }
      selectedByGroup.delete(group.id);
    }
    if (selectedByGroup.size > 0) throw new RangeError('Selección para grupo inexistente.');
    selections = Object.freeze(resolvedSelections);
    components = Object.freeze(resolvedComponents);
  }
  const availableStock = components.reduce((minimum, component) => {
    const available = input.availableByProduct.get(component.productId) ?? 0;
    return Math.min(minimum, Math.floor(Math.max(0, available) / component.quantity));
  }, Number.MAX_SAFE_INTEGER);
  const normalizedStock = components.length === 0 ? 0 : availableStock;
  const snapshot = Object.freeze({
    schema: 1 as const, bundle_id: input.bundle.id, version: input.bundle.version,
    kind: input.bundle.kind, label: input.bundle.label.trim(),
    selections: Object.freeze(selections.map((selection) => Object.freeze({
      group_id: selection.groupId, product_id: selection.productId,
    }))),
    components: Object.freeze(components.map((component) => Object.freeze({
      product_id: component.productId, quantity_per_bundle: component.quantity,
    }))),
    stock_policy: 'minimum_component_availability' as const,
    amendment_policy: 'composition_frozen' as const,
    return_policy: 'restock_components' as const,
  });
  return Object.freeze({ bundle: input.bundle, selections, components,
    availableStock: normalizedStock, snapshot });
}
