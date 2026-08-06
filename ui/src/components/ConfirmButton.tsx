import { useEffect, useRef, useState } from 'react';

type Props = {
  /** Resting label. */
  children: React.ReactNode;
  /** Label once armed — say what is about to happen, not just "Confirm". */
  confirmLabel: string;
  onConfirm: () => void;
  className?: string;
  title?: string;
  disabled?: boolean;
  /** How long the armed state survives without a second click. */
  timeoutMs?: number;
};

/**
 * A destructive action that confirms in place instead of opening a dialog.
 *
 * The first click arms the button and it relabels itself; the second click acts.
 * A modal would steal focus and force a mouse trip to a different corner of the
 * screen for what is a two-click decision — and this app's whole surface is a
 * list you are working through quickly.
 *
 * Arming expires on its own, on Escape, and on a click anywhere else, so a
 * half-pressed destructive button never sits waiting to be hit by accident.
 */
export function ConfirmButton({
  children,
  confirmLabel,
  onConfirm,
  className = 'btn small danger',
  title,
  disabled,
  timeoutMs = 5000,
}: Props) {
  const [armed, setArmed] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), timeoutMs);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setArmed(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) setArmed(false);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onPointer);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onPointer);
    };
  }, [armed, timeoutMs]);

  // Disabling mid-arm (the list emptied under us) must not leave it armed.
  useEffect(() => {
    if (disabled) setArmed(false);
  }, [disabled]);

  return (
    <button
      ref={ref}
      type="button"
      className={`${className}${armed ? ' armed' : ''}`}
      title={armed ? 'Click again to confirm — Esc to cancel' : title}
      disabled={disabled}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : children}
    </button>
  );
}
