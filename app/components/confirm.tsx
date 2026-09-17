import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { Button, type ButtonProps } from './ui';

/**
 * Confirmation for destructive actions.
 *
 * `window.confirm` is unstyled, cannot say *what* is about to happen, and is
 * suppressed in some embedded contexts — which would silently turn a destructive
 * action into an immediate one. This renders a real dialog whose confirm button
 * names the consequence.
 *
 * Note the progressive-enhancement trade-off: the visible control is
 * `type="button"`, so with JavaScript disabled nothing submits at all. Failing
 * closed is the right direction for a destructive action, and the server
 * validates every mutation regardless.
 */

export interface ConfirmButtonProps extends Omit<ButtonProps, 'type' | 'onClick'> {
  /** Dialog heading, phrased as the question being asked. */
  title: string;
  /** What will actually happen. State the consequence, not "are you sure?". */
  description: ReactNode;
  confirmLabel?: string;
  /** Variant of the confirming button; the trigger stays whatever `variant` says. */
  confirmVariant?: ButtonProps['variant'];
  variant?: ButtonProps['variant'];
  children: ReactNode;
}

export function ConfirmButton({
  title,
  description,
  confirmLabel = 'Confirm',
  confirmVariant = 'danger',
  variant = 'ghost',
  children,
  ...rest
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const hiddenSubmit = useRef<HTMLButtonElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    // Escape closes; the safest control takes focus.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('keydown', onKeyDown);
    cancelButton.current?.focus();

    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  return (
    <>
      <Button type="button" variant={variant} onClick={() => setOpen(true)} {...rest}>
        {children}
      </Button>

      {/* The real submit. Triggered only from the dialog. */}
      <button ref={hiddenSubmit} type="submit" className="hidden" aria-hidden="true" tabIndex={-1} />

      {open ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="presentation"
          onClick={(event) => {
            if (event.target === event.currentTarget) setOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            className="w-full max-w-md rounded-lg border border-border bg-surface p-5 shadow-lg"
          >
            <h2 id="confirm-title" className="text-base font-semibold text-ink">
              {title}
            </h2>
            <div className="mt-2 text-sm text-ink-muted">{description}</div>

            <div className="mt-5 flex justify-end gap-2">
              <Button ref={cancelButton} type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={confirmVariant}
                onClick={() => {
                  setOpen(false);
                  hiddenSubmit.current?.click();
                }}
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
