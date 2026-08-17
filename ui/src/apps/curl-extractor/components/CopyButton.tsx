import { useState } from 'react';
import { copyText } from '../../../util.ts';

/** Copy control that confirms in place, so no toast or layout shift is needed. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);

  return (
    <button
      className={`btn copy${done ? ' done' : ''}`}
      title={label ?? 'Copy'}
      aria-label={label ?? 'Copy'}
      disabled={text.length === 0}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setDone(true);
          window.setTimeout(() => setDone(false), 1400);
        });
      }}
    >
      {done ? '✓ copied' : '⧉ copy'}
    </button>
  );
}
