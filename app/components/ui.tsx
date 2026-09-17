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
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-brand-700 text-white hover:bg-brand-600',
        secondary: 'bg-white text-ink ring-1 ring-border hover:bg-muted',
        ghost: 'text-ink hover:bg-muted',
        danger: 'bg-danger text-white hover:opacity-90',
      },
      // One step tighter all round. 32px is the default control height, which is
      // what makes a dense toolbar read as a toolbar rather than a row of buttons.
      size: {
        sm: 'h-7 px-2.5',
        md: 'h-8 px-3',
        lg: 'h-10 px-4',
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
      <span className="mb-0.5 block text-xs font-medium text-ink">{label}</span>
      {children}
      {hint && !error ? <span className="mt-0.5 block text-xs text-ink-muted">{hint}</span> : null}
      {error ? <span className="mt-0.5 block text-xs text-danger">{error}</span> : null}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(
        'h-8 w-full rounded-md border border-border bg-white px-2 text-sm text-ink placeholder:text-ink-muted focus:border-brand-600 focus:outline-none',
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
        'h-8 w-full rounded-md border border-border bg-white px-2 text-sm text-ink focus:border-brand-600 focus:outline-none',
        className,
      )}
      {...props}
    />
  );
}


/* ── Surfaces ──────────────────────────────────────────────────────────────── */

/**
 * A bordered region. No shadow and no lift: on a white page the border is the
 * whole separation, which keeps stacked panels from reading as floating cards.
 */
export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <section className={cn('rounded-md border border-border bg-surface', className)}>{children}</section>
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
    <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/60 px-3 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-xs font-semibold tracking-wide text-ink uppercase">{title}</h2>
        {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </header>
  );
}


/* ── Badge ─────────────────────────────────────────────────────────────────── */

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

/**
 * A categorical label — a division, a regulatory flag, and similar.
 *
 * Flat and muted on purpose. Colour is reserved for status, so a catalogue full
 * of products does not turn into a wall of tinted pills that all look equally
 * urgent, and the one that matters stands out because it is the only one coloured.
 */
const badgeVariants = cva('inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[11px] font-medium', {
  variants: {
    tone: {
      neutral: 'border-border text-ink-muted',
      info: 'border-brand-200 text-brand-900',
      success: 'border-green-200 text-green-800',
      warning: 'border-amber-200 text-amber-800',
      danger: 'border-red-200 text-red-800',
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

const statusDotTones: Record<BadgeTone, string> = {
  neutral: 'bg-ink-muted',
  info: 'bg-brand-600',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/**
 * Status as a small coloured dot followed by the word.
 *
 * The dot carries the signal, so the text can stay in the ordinary ink colour and
 * every status reads at the same weight. Tinting the whole label instead makes a
 * routine `draft` look as loud as a `voided`, which is the wrong emphasis.
 */
export function Status({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-sm text-ink">
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', statusDotTones[tone])}
        aria-hidden="true"
      />
      {children}
    </span>
  );
}

/** Maps a domain status onto a tone, in one place. */
export function statusTone(status: string): BadgeTone {
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
        'border-b border-border px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <td className={cn('border-b border-border px-2.5 py-1 text-ink', className)}>{children}</td>
  );
}


/* ── Feedback ──────────────────────────────────────────────────────────────── */

export function EmptyRow({ colSpan, message }: { colSpan: number; message: string }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2.5 py-6 text-center text-sm text-ink-muted">
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
  // A left rule and a faint tint rather than a filled bordered panel. Only the
  // left border is coloured, so there is no `border-*` versus `border-l-*` colour
  // conflict to depend on stylesheet order for.
  const tones = {
    danger: 'border-l-danger bg-red-50/70 text-red-900',
    warning: 'border-l-warning bg-amber-50/70 text-amber-900',
    info: 'border-l-brand-600 bg-brand-50/70 text-brand-900',
  } as const;

  return (
    <div className={cn('rounded-sm border-l-2 py-1.5 pr-2.5 pl-2 text-sm', tones[tone])} role="alert">
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
  // A rule under the header rather than a box around the page. It gives the
  // screen one clear top edge and lets everything below sit flat on white.
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-2 border-b border-border pb-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <h1 className="text-lg font-semibold text-ink">{title}</h1>
        {description ? <p className="text-xs text-ink-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-border px-3 py-2">
      <p className="text-[11px] font-medium tracking-wide text-ink-muted uppercase">{label}</p>
      <p className="tabular mt-0.5 text-lg font-semibold text-ink">{value}</p>
      {hint ? <p className="text-xs text-ink-muted">{hint}</p> : null}
    </div>
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
        'border-b border-border px-2.5 py-1.5 text-left text-[11px] font-semibold tracking-wide text-ink-muted uppercase',
        className,
      )}
    >
      <a
        className="inline-flex items-center gap-0.5 hover:text-ink"
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
    <nav className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-2.5 py-1.5 text-xs">
      <span className="text-ink-muted">
        Page {page} of {pages} · {total} total
      </span>
      <div className="flex items-center gap-1.5">
        {offset > 0 ? (
          <a
            className="rounded-sm border border-border px-2 py-0.5 text-ink hover:bg-muted"
            href={withParam(basePath, current, { offset: Math.max(0, offset - limit) })}
          >
            Newer
          </a>
        ) : null}
        {offset + limit < total ? (
          <a
            className="rounded-sm border border-border px-2 py-0.5 text-ink hover:bg-muted"
            href={withParam(basePath, current, { offset: offset + limit })}
          >
            Older
          </a>
        ) : null}
      </div>
    </nav>
  );
}

