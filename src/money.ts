/** Bounded, exact arithmetic for normalized decimal strings, not a locale parser.
 * Quantities/prices: <=12 integer digits and <=6 decimal places.
 * Monetary amounts: must fit the explicitly configured minor-unit precision.
 * No implicit rounding of printed amounts. Product rounding is half away from zero.
 */
export function assertScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < 0 || scale > 6) {
    throw new RangeError('Precision must be an integer from 0 through 6');
  }
}
function parts(value: unknown): { coefficient: bigint; scale: number } {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(value)) {
    throw new TypeError('Expected a bounded canonical decimal string');
  }
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = (negative ? value.slice(1) : value).split('.');
  return { coefficient: BigInt((negative ? '-' : '') + whole + fraction), scale: fraction.length };
}
function power(n: number): bigint { return 10n ** BigInt(n); }
export function parseUnits(value: unknown, scale: number): bigint {
  assertScale(scale);
  const p = parts(value);
  if (p.scale <= scale) return p.coefficient * power(scale - p.scale);
  const denominator = power(p.scale - scale);
  if (p.coefficient % denominator !== 0n) throw new RangeError('Amount exceeds configured precision');
  return p.coefficient / denominator;
}
export function formatUnits(units: bigint, scale: number): string {
  assertScale(scale);
  if (typeof units !== 'bigint') throw new TypeError('Expected integer minor units');
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return scale === 0 ? sign + digits : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
export function sumAmounts(values: readonly unknown[], scale: number): string {
  assertScale(scale);
  return formatUnits(values.reduce<bigint>((sum, value) => sum + parseUnits(value, scale), 0n), scale);
}
export function lineExtension(quantity: unknown, unitPrice: unknown, scale: number): string {
  assertScale(scale);
  const a = parts(quantity); const b = parts(unitPrice);
  const numerator = a.coefficient * b.coefficient * power(scale);
  const denominator = power(a.scale + b.scale);
  const magnitude = numerator < 0n ? -numerator : numerator;
  let rounded = magnitude / denominator;
  if ((magnitude % denominator) * 2n >= denominator) rounded += 1n;
  return formatUnits(numerator < 0n ? -rounded : rounded, scale);
}
