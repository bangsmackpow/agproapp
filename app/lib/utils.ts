import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges class names, resolving Tailwind conflicts in favour of the last. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Formats integer cents as USD. Mirrors `formatUsd` in src/shared/pricing.ts. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
}

export function formatDate(value: string | number | Date | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(date);
}

export function formatNumber(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value);
}

/**
 * A decimal fraction as a percentage. Zero is "None" rather than "0%", because on
 * a settings screen the difference between "exempt" and "measured as zero" is the
 * whole question.
 */
export function formatPercent(fraction: number | null | undefined): string {
  if (fraction === null || fraction === undefined) return '—';
  if (fraction === 0) return 'None';
  return `${Number((fraction * 100).toFixed(2))}%`;
}
