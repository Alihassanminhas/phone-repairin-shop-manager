/** Formats a PKR amount stored as integer paisa without floating-point math. */
export function formatPkr(paisa: number): string {
  const absolutePaisa = Math.abs(paisa);
  const rupees = Math.floor(absolutePaisa / 100);
  const fraction = (absolutePaisa % 100).toString().padStart(2, '0');
  return `${paisa < 0 ? '-' : ''}Rs. ${rupees.toLocaleString('en-PK')}.${fraction}`;
}

/** Parses a rupee text input to paisa, rejecting precision beyond two decimals. */
export function parsePaisa(value: string): number | null {
  const normalized = value.trim().replace(/,/g, '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) return null;
  const [rupees, fraction = ''] = normalized.split('.');
  const amount = Number(rupees) * 100 + Number(fraction.padEnd(2, '0'));
  return Number.isSafeInteger(amount) ? amount : null;
}
