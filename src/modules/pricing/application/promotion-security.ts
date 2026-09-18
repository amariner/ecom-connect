const CODE_PATTERN = /^[A-Z0-9](?:[A-Z0-9-]{1,30}[A-Z0-9])?$/;

export function normalizePromotionCode(value: string): string {
  const normalized = value.normalize('NFKC').trim().toUpperCase();
  if (!CODE_PATTERN.test(normalized)) {
    throw new RangeError('El código promocional debe tener 3–32 caracteres ASCII alfanuméricos o guiones internos.');
  }
  return normalized;
}

async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function promotionCodeHash(value: string): Promise<string> {
  return sha256Hex(`logic2b:promotion-code:v1:${normalizePromotionCode(value)}`);
}

export function promotionCodeHint(value: string): string {
  const normalized = normalizePromotionCode(value);
  return `••••${normalized.slice(-4)}`;
}

export async function promotionCustomerHash(email: string): Promise<string> {
  const normalized = email.normalize('NFKC').trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 200 || !normalized.includes('@')) {
    throw new RangeError('Identidad de cliente inválida para límite promocional.');
  }
  return sha256Hex(`logic2b:promotion-customer:v1:${normalized}`);
}
