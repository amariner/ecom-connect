import { CatalogAdminError } from './product-variant-admin';
import type { AttributeDefinitionAdminRow, AttributeValueType } from './product-admin';

export type ProductMediaWrite = Readonly<{
  kind: 'image' | 'video';
  source: string;
  alt_text: string;
  focal_x_bps: number;
  focal_y_bps: number;
  variant_ids: readonly number[];
}>;

export type AttributeDefinitionWrite = Readonly<{
  code: string;
  label: string;
  value_type: AttributeValueType;
  unit: string | null;
  constraints: Readonly<Record<string, unknown>>;
  active: boolean;
}>;

export type AttributeTypedValue =
  | Readonly<{ type: 'text'; value: string }>
  | Readonly<{ type: 'number'; value: number }>
  | Readonly<{ type: 'boolean'; value: boolean }>
  | Readonly<{ type: 'reference'; value: string }>
  | Readonly<{ type: 'list'; value: readonly string[] }>;

export type AttributeValueStorage = Readonly<{
  value_text: string | null;
  value_number: number | null;
  value_boolean: number | null;
  value_reference: string | null;
  value_list_json: string | null;
}>;

function invalid(message: string): never {
  throw new CatalogAdminError('invalid-selection', message);
}

function onlyKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) invalid(`Restricciones no admitidas: ${unexpected.join(', ')}.`);
}

function optionalNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${label} debe ser un número finito.`);
  return value;
}

function optionalInteger(value: unknown, label: string): number | undefined {
  const parsed = optionalNumber(value, label);
  if (parsed !== undefined && !Number.isInteger(parsed)) invalid(`${label} debe ser un entero.`);
  return parsed;
}

export function normalizeAttributeDefinition(write: AttributeDefinitionWrite): Readonly<{
  code: string;
  label: string;
  value_type: AttributeValueType;
  unit: string | null;
  constraints_json: string;
  active: number;
}> {
  const code = write.code.trim().toLocaleLowerCase('en');
  const label = write.label.trim();
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(code)) invalid('El código debe usar minúsculas, números, guion o guion bajo.');
  if (label.length < 1 || label.length > 120) invalid('La etiqueta debe tener entre 1 y 120 caracteres.');
  const unit = write.unit?.trim() || null;
  if (unit !== null && (write.value_type !== 'number' || unit.length > 24)) {
    invalid('Solo un atributo numérico admite una unidad de hasta 24 caracteres.');
  }

  const constraints = { ...write.constraints };
  if (write.value_type === 'text') {
    onlyKeys(constraints, ['minLength', 'maxLength']);
    const min = optionalInteger(constraints.minLength, 'minLength') ?? 1;
    const max = optionalInteger(constraints.maxLength, 'maxLength') ?? 5000;
    if (min < 0 || max > 5000 || min > max) invalid('Las longitudes de texto no son válidas.');
  } else if (write.value_type === 'number') {
    onlyKeys(constraints, ['min', 'max', 'step']);
    const min = optionalNumber(constraints.min, 'min');
    const max = optionalNumber(constraints.max, 'max');
    const step = optionalNumber(constraints.step, 'step');
    if (min !== undefined && max !== undefined && min > max) invalid('El mínimo no puede superar al máximo.');
    if (step !== undefined && step <= 0) invalid('El paso debe ser positivo.');
  } else if (write.value_type === 'boolean') {
    onlyKeys(constraints, []);
  } else if (write.value_type === 'reference') {
    onlyKeys(constraints, ['allowedPrefixes']);
    const prefixes = constraints.allowedPrefixes;
    if (prefixes !== undefined && (!Array.isArray(prefixes) || prefixes.length > 20 || prefixes.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 80))) {
      invalid('allowedPrefixes debe ser una lista de hasta 20 prefijos.');
    }
  } else {
    onlyKeys(constraints, ['choices', 'minItems', 'maxItems']);
    const choices = constraints.choices;
    if (!Array.isArray(choices) || choices.length < 1 || choices.length > 100 || choices.some((item) => typeof item !== 'string' || item.length < 1 || item.length > 120) || new Set(choices).size !== choices.length) {
      invalid('Una lista necesita entre 1 y 100 opciones únicas.');
    }
    const min = optionalInteger(constraints.minItems, 'minItems') ?? 1;
    const max = optionalInteger(constraints.maxItems, 'maxItems') ?? choices.length;
    if (min < 1 || max > choices.length || min > max) invalid('La cardinalidad de la lista no es válida.');
  }
  return Object.freeze({
    code,
    label,
    value_type: write.value_type,
    unit,
    constraints_json: JSON.stringify(constraints),
    active: write.active ? 1 : 0,
  });
}

export function attributeValueStorage(
  definition: Pick<AttributeDefinitionAdminRow, 'value_type' | 'constraints_json' | 'active'>,
  input: AttributeTypedValue,
): AttributeValueStorage {
  if (definition.active !== 1) invalid('La definición está desactivada.');
  if (input.type !== definition.value_type) invalid('El tipo del valor no coincide con la definición.');
  const constraints = JSON.parse(definition.constraints_json) as Record<string, unknown>;
  const empty: AttributeValueStorage = {
    value_text: null, value_number: null, value_boolean: null,
    value_reference: null, value_list_json: null,
  };

  if (input.type === 'text') {
    const min = Number(constraints.minLength ?? 1);
    const max = Number(constraints.maxLength ?? 5000);
    if (input.value.length < min || input.value.length > max) invalid('El texto no respeta la longitud configurada.');
    return { ...empty, value_text: input.value };
  }
  if (input.type === 'number') {
    const min = constraints.min as number | undefined;
    const max = constraints.max as number | undefined;
    const step = constraints.step as number | undefined;
    if (!Number.isFinite(input.value) || (min !== undefined && input.value < min) || (max !== undefined && input.value > max)) {
      invalid('El número queda fuera del rango configurado.');
    }
    if (step !== undefined && min !== undefined) {
      const quotient = (input.value - min) / step;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9) invalid('El número no respeta el paso configurado.');
    }
    return { ...empty, value_number: input.value };
  }
  if (input.type === 'boolean') return { ...empty, value_boolean: input.value ? 1 : 0 };
  if (input.type === 'reference') {
    const value = input.value.trim();
    const prefixes = constraints.allowedPrefixes as string[] | undefined;
    if (value.length < 1 || value.length > 500 || (prefixes && !prefixes.some((prefix) => value.startsWith(prefix)))) {
      invalid('La referencia no respeta los prefijos configurados.');
    }
    return { ...empty, value_reference: value };
  }
  const choices = constraints.choices as string[];
  const values = [...new Set(input.value)];
  const min = Number(constraints.minItems ?? 1);
  const max = Number(constraints.maxItems ?? choices.length);
  if (values.length < min || values.length > max || values.some((value) => !choices.includes(value))) {
    invalid('La selección contiene opciones o una cardinalidad no admitidas.');
  }
  return { ...empty, value_list_json: JSON.stringify(values) };
}

export function validateMediaWrite(write: ProductMediaWrite): ProductMediaWrite {
  const source = write.source.trim();
  const alt = write.alt_text.trim();
  if (source.length < 1 || source.length > 500) invalid('La ruta de media no es válida.');
  if (alt.length < 1 || alt.length > 240) invalid('El texto alternativo debe tener entre 1 y 240 caracteres.');
  if (![write.focal_x_bps, write.focal_y_bps].every((value) => Number.isInteger(value) && value >= 0 && value <= 10000)) {
    invalid('El foco debe estar entre 0 y 10000.');
  }
  const variantIds = [...new Set(write.variant_ids)];
  if (variantIds.length !== write.variant_ids.length || variantIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    invalid('Las variantes asociadas no son válidas.');
  }
  return Object.freeze({ ...write, source, alt_text: alt, variant_ids: Object.freeze(variantIds) });
}
