/**
 * The data half of the filter. Everything here is overridable via
 * ~/.curlapi/filters.json so a user can adapt to a site without editing code.
 */

/** Resource types that are always API traffic worth keeping. */
export const ALWAYS_KEEP_TYPES = ['XHR', 'Fetch', 'WebSocket', 'EventSource'];

/** Resource types that are never useful when reverse-engineering an API. */
export const ALWAYS_DROP_TYPES = [
  'Image',
  'Font',
  'Stylesheet',
  'Media',
  'Manifest',
  'TextTrack',
  'CSPViolationReport',
  'Ping',
  'Prefetch',
  'SignedExchange',
];

export const NOISE_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.css', '.map',
  // Script payloads are noise even when fetched through fetch()/XHR rather than
  // a <script> tag, which is how a bundler-loaded chunk shows up as `Fetch`.
  '.js', '.mjs', '.cjs',
  '.mp4', '.webm', '.mp3', '.wav', '.ogg', '.m4a', '.mov',
];

/**
 * Third-party telemetry, tag managers, error trackers and asset CDNs. Matched
 * against the hostname as an exact match or a dot-suffix, never a substring —
 * substring matching would drop a legitimate `api.mixpanel-clone.example.com`.
 */
export const NOISE_DOMAINS = [
  // Analytics and tag management
  'google-analytics.com',
  'googletagmanager.com',
  'analytics.google.com',
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'facebook.net',
  'connect.facebook.net',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'heap.io',
  'matomo.cloud',
  'plausible.io',
  'posthog.com',
  // Error and performance monitoring
  'sentry.io',
  'ingest.sentry.io',
  'bugsnag.com',
  'datadoghq.com',
  'newrelic.com',
  'nr-data.net',
  'dynatrace.com',
  // Session replay and support widgets
  'hotjar.com',
  'hotjar.io',
  'clarity.ms',
  'fullstory.com',
  'logrocket.io',
  'intercom.io',
  'intercomcdn.com',
  'zendesk.com',
  'zdassets.com',
  'crisp.chat',
  'drift.com',
  // Chrome's own service traffic — new tab tiles, safe browsing, autofill,
  // component updates. None of it belongs to the site under test.
  'clients2.google.com',
  'clients4.google.com',
  'clients6.google.com',
  'safebrowsing.googleapis.com',
  'update.googleapis.com',
  'optimizationguide-pa.googleapis.com',
  'content-autofill.googleapis.com',
  'gstatic.com',
  // Fonts and asset CDNs
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdnjs.cloudflare.com',
  'unpkg.com',
  'jsdelivr.net',
  'bootstrapcdn.com',
  'gravatar.com',
];

/** Path fragments that strongly suggest a real API endpoint. */
export const API_PATH_HINTS = [
  '/api/',
  '/apis/',
  '/v1/',
  '/v2/',
  '/v3/',
  '/rest/',
  '/rpc/',
  '/graphql',
  '/gql',
  '/_next/data/',
  '/wp-json/',
  '/odata/',
];

/** Response content types that indicate structured data rather than a page asset. */
export const DATA_MIME_HINTS = [
  'application/json',
  'application/ld+json',
  'application/x-ndjson',
  'application/graphql',
  'application/vnd.api+json',
  'text/event-stream',
  'application/xml',
  'text/xml',
  'application/x-protobuf',
  'application/grpc',
];

/** URL schemes that never represent network calls we can replay. */
export const IGNORED_SCHEMES = ['data:', 'blob:', 'chrome-extension:', 'about:', 'file:'];

export type FilterConfig = {
  alwaysKeepTypes: string[];
  alwaysDropTypes: string[];
  noiseExtensions: string[];
  noiseDomains: string[];
  apiPathHints: string[];
  dataMimeHints: string[];
  /** Hostnames to always keep, even if they match a noise rule. */
  allowDomains: string[];
  /** Keep Script responses too. Off by default; useful for JSONP-era sites. */
  keepScripts: boolean;
  /** Keep top-level document navigations. Off by default; POSTs kept regardless. */
  keepDocuments: boolean;
  /** Keep browser-generated CORS preflights. Off by default. */
  keepPreflight: boolean;
};

export const DEFAULT_CONFIG: FilterConfig = {
  alwaysKeepTypes: ALWAYS_KEEP_TYPES,
  alwaysDropTypes: ALWAYS_DROP_TYPES,
  noiseExtensions: NOISE_EXTENSIONS,
  noiseDomains: NOISE_DOMAINS,
  apiPathHints: API_PATH_HINTS,
  dataMimeHints: DATA_MIME_HINTS,
  allowDomains: [],
  keepScripts: false,
  keepDocuments: false,
  keepPreflight: false,
};
