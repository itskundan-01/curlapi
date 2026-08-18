/**
 * The workspace's icons, drawn rather than typed.
 *
 * The apps used to be labelled with emoji from the server manifest. Emoji are
 * rendered by the operating system, so the same interface arrived as flat glyphs
 * on one machine and glossy full-colour stickers on another — and neither
 * version could take the theme's colour or line weight. These are one-colour
 * strokes on the same 24-unit grid, so they sit at the same optical weight as
 * the text beside them.
 *
 * Kept deliberately small. An icon set that grows past what the interface
 * actually needs becomes a thing to maintain instead of a thing to use.
 */

type IconProps = {
  /** Matches the surrounding text size by default. */
  size?: number;
  className?: string;
};

function Svg({ size = 16, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Capture: a signal being intercepted mid-flight. */
export function IconCapture(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 12h4l2.5-6 5 12L17 12h4" />
    </Svg>
  );
}

/** A document turning into a request. */
export function IconDocument(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
      <path d="M13 3v6h6" />
      <path d="M9 14h6M9 17.5h4" />
    </Svg>
  );
}

export function IconArrow(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h13M12.5 6l6 6-6 6" />
    </Svg>
  );
}

export function IconTheme(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 3.5v17a8.5 8.5 0 0 0 0-17z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

/** Work in progress. Spun by CSS, so it stops when motion is reduced. */
export function IconSpinner(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5a8.5 8.5 0 1 0 8.5 8.5" />
    </Svg>
  );
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </Svg>
  );
}

/** The mark beside the wordmark: a request going out, a response coming back. */
export function Wordmark({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M4 8.5h11.5M12 5l3.5 3.5L12 12" />
      <path d="M20 15.5H8.5M12 19l-3.5-3.5L12 12" opacity="0.55" />
    </svg>
  );
}

const BY_APP: Record<string, (props: IconProps) => React.ReactElement> = {
  'curl-extractor': IconCapture,
  'doc-runner': IconDocument,
};

/**
 * The icon for an app, falling back to the manifest's own character.
 *
 * A utility added later still gets a sensible mark without this file being
 * edited — which is the point of the manifest carrying one.
 */
export function AppIcon({
  id,
  fallback,
  size = 16,
  className,
}: {
  id: string;
  fallback?: string;
  size?: number;
  className?: string;
}) {
  const Drawn = BY_APP[id];
  if (Drawn) return <Drawn size={size} className={className} />;
  return (
    <span className={className} style={{ fontSize: size }} aria-hidden="true">
      {fallback ?? '•'}
    </span>
  );
}
