import { cva, type VariantProps } from 'class-variance-authority';
import type {
  ComponentPropsWithRef,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

import { cn } from '../lib/utils';

/**
 * Shared UI primitives, styled in the shadcn/ui idiom (Tailwind + class-variance-authority)
 * but kept in one module. Run the shadcn CLI later to split these into
 * per-component files if the set grows; the API surface is already compatible.
 */

/* ── Button ────────────────────────────────────────────────────────────────── */

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-600',
        secondary: 'bg-white text-ink ring-1 ring-border hover:bg-muted',
        ghost: 'text-ink hover:bg-muted',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      size: {
        sm: 'h-8 px-3',
        md: 'h-10 px-4',
        lg: 'h-12 px-6',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  },
);

export interface ButtonProps
  extends ComponentPropsWithRef<'button'>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

/* ── Form controls ─────────────────────────────────────────────────────────── */

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-ink">{label}</span>
      {children}
      {hint && !error ? <span className="mt-1 block text-xs text-ink-muted">{hint}</span> : null}
      {error ? <span className="mt-1 block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-10 w-full rounded-md border border-border bg-white px-3 text-sm text-ink placeholder:text-ink-muted focus:border-brand-500 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        'h-10 w-full rounded-md border border-border bg-white px-3 text-sm text-ink focus:border-brand-500 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}

/* ── Surfaces ──────────────────────────────────────────────────────────────── */

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-lg border border-border bg-surface shadow-sm', className)}>
      {children}
    </section>
  );
}

export function CardHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* ── Badge ─────────────────────────────────────────────────────────────────── */

const badgeVariants = cva('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', {
  variants: {
    tone: {
      neutral: 'bg-muted text-ink-muted',
      info: 'bg-brand-100 text-brand-900',
      success: 'bg-green-100 text-green-800',
      warning: 'bg-amber-100 text-amber-800',
      danger: 'bg-red-100 text-red-800',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export interface BadgeProps extends VariantProps<typeof badgeVariants> {
  children: ReactNode;
  className?: string;
}

export function Badge({ tone, className, children }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)}>{children}</span>;
}

/** Maps a domain status onto a badge tone, in one place. */
export function statusTone(status: string): 'neutral' | 'info' | 'success' | 'warning' | 'danger' {
  switch (status) {
    case 'paid':
    case 'cleared':
    case 'committed':
      return 'success';
    case 'sent':
    case 'printed':
    case 'in_review':
      return 'info';
    case 'draft':
    case 'pending':
    case 'open':
      return 'warning';
    case 'canceled':
    case 'voided':
    case 'void':
    case 'rejected':
      return 'danger';
    default:
      return 'neutral';
  }
}

/* ── Table ─────────────────────────────────────────────────────────────────── */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('w-full overflow-x-auto', className)}>
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <th
      className={cn(
        'border-b border-border px-3 py-2 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cn('border-b border-border px-3 py-2 text-ink', className)}>{children}</td>;
}

/* ── Feedback ──────────────────────────────────────────────────────────────── */

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-3 py-8 text-center text-sm text-ink-muted">
        {message}
      </td>
    </tr>
  );
}

export function Alert({
  tone = 'danger',
  title,
  children,
}: {
  tone?: 'danger' | 'warning' | 'info';
  title: string;
  children?: ReactNode;
}) {
  const tones = {
    danger: 'border-red-200 bg-red-50 text-red-900',
    warning: 'border-amber-200 bg-amber-50 text-amber-900',
    info: 'border-brand-200 bg-brand-50 text-brand-900',
  } as const;

  return (
    <div className={cn('rounded-md border px-4 py-3 text-sm', tones[tone])} role="alert">
      <p className="font-medium">{title}</p>
      {children ? <div className="mt-1">{children}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-ink">{title}</h1>
        {description ? <p className="mt-1 text-sm text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      <p className="tabular mt-1 text-2xl font-semibold text-ink">{value}</p>
      {hint ? <p className="mt-1 text-xs text-ink-muted">{hint}</p> : null}
    </Card>
  );
}

/* ── Pagination and sorting ────────────────────────────────────────────────── */

/** Builds a URL that changes one query parameter, preserving the rest. */
export function withParam(
  basePath: string,
  current: string,
  changes: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams(current);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) params.delete(key);
    else params.set(key, String(value));
  }
  return `${basePath}?${params.toString()}`;
}

/**
 * Sortable column heading.
 *
 * Clicking toggles direction, and the sort key is a fixed string the API
 * whitelists — a column name never travels from the browser.
 */
export function SortLink({
  basePath,
  current,
  field,
  active,
  direction,
  children,
  className,
}: {
  basePath: string;
  current: string;
  field: string;
  active: boolean;
  direction: string;
  children: ReactNode;
  className?: string;
}) {
  const nextDirection = active && direction === 'asc' ? 'desc' : 'asc';

  return (
    <th
      className={cn(
        'border-b border-border px-3 py-2 text-left text-xs font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
    >
      <a
        className="inline-flex items-center gap-1 hover:text-ink"
        href={withParam(basePath, current, { sort: field, direction: nextDirection, offset: 0 })}
      >
        {children}
        <span aria-hidden="true">{active ? (direction === 'asc' ? '▲' : '▼') : ''}</span>
      </a>
    </th>
  );
}

/**
 * Paging control. Renders nothing when everything fits on one page, so short
 * lists do not grow chrome they do not need.
 */
export function Pagination({
  basePath,
  current,
  total,
  limit,
  offset,
}: {
  basePath: string;
  current: string;
  total: number;
  limit: number;
  offset: number;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;

  const page = Math.floor(offset / limit) + 1;

  return (
    <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-border p-3 text-sm">
      <span className="text-ink-muted">
        Page {page} of {pages} · {total} total
      </span>
      <div className="flex items-center gap-2">
        {offset > 0 ? (
          <a
            className="rounded-md bg-white px-3 py-1.5 text-ink ring-1 ring-border"
            href={withParam(basePath, current, { offset: Math.max(0, offset - limit) })}
          >
            Newer
          </a>
        ) : null}
        {offset + limit < total ? (
          <a
            className="rounded-md bg-white px-3 py-1.5 text-ink ring-1 ring-border"
            href={withParam(basePath, current, { offset: offset + limit })}
          >
            Older
          </a>
        ) : null}
      </div>
    </nav>
  );
}
