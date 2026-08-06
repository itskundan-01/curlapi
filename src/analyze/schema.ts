/**
 * Structural summaries of JSON payloads.
 *
 * When rebuilding an API you care about the shape of a response — which keys
 * exist and what types they hold — far more than about the 4,000 rows inside it.
 * A shape is also what makes "did this endpoint still behave the same?" a
 * question we can answer after a replay.
 */

export type Shape =
  | { kind: 'null' }
  | { kind: 'boolean' }
  | { kind: 'number' }
  | { kind: 'string' }
  | { kind: 'array'; element: Shape | null }
  | { kind: 'object'; fields: Record<string, Shape> }
  | { kind: 'union'; options: Shape[] };

const MAX_DEPTH = 8;
/** Arrays are sampled rather than walked whole; homogeneity is the common case. */
const ARRAY_SAMPLE = 20;

function unify(a: Shape, b: Shape): Shape {
  if (signature(a) === signature(b)) return a;
  if (a.kind === 'null') return b;
  if (b.kind === 'null') return a;

  if (a.kind === 'object' && b.kind === 'object') {
    const fields: Record<string, Shape> = { ...a.fields };
    for (const [key, shape] of Object.entries(b.fields)) {
      fields[key] = key in fields ? unify(fields[key], shape) : shape;
    }
    return { kind: 'object', fields };
  }

  if (a.kind === 'array' && b.kind === 'array') {
    const element =
      a.element && b.element ? unify(a.element, b.element) : (a.element ?? b.element);
    return { kind: 'array', element };
  }

  const options = [
    ...(a.kind === 'union' ? a.options : [a]),
    ...(b.kind === 'union' ? b.options : [b]),
  ];
  const seen = new Map<string, Shape>();
  for (const option of options) seen.set(signature(option), option);
  return { kind: 'union', options: [...seen.values()] };
}

export function inferShape(value: unknown, depth = 0): Shape {
  if (value === null || value === undefined) return { kind: 'null' };
  if (depth >= MAX_DEPTH) return { kind: 'string' };

  switch (typeof value) {
    case 'boolean':
      return { kind: 'boolean' };
    case 'number':
      return { kind: 'number' };
    case 'string':
      return { kind: 'string' };
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'array', element: null };
    let element = inferShape(value[0], depth + 1);
    for (const item of value.slice(1, ARRAY_SAMPLE)) {
      element = unify(element, inferShape(item, depth + 1));
    }
    return { kind: 'array', element };
  }

  const fields: Record<string, Shape> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    fields[key] = inferShape(item, depth + 1);
  }
  return { kind: 'object', fields };
}

/** Stable, order-independent string form, suitable for equality comparison. */
export function signature(shape: Shape): string {
  switch (shape.kind) {
    case 'array':
      return `[${shape.element ? signature(shape.element) : ''}]`;
    case 'object': {
      const parts = Object.keys(shape.fields)
        .sort()
        .map((key) => `${key}:${signature(shape.fields[key])}`);
      return `{${parts.join(',')}}`;
    }
    case 'union':
      return `(${shape.options.map(signature).sort().join('|')})`;
    default:
      return shape.kind;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Compares two JSON payloads structurally. Returns null when either side is not
 * JSON, so callers can say "not comparable" instead of implying a mismatch.
 */
export function shapesMatch(a: string | null, b: string | null): boolean | null {
  if (!a || !b) return null;
  const left = parseJson(a);
  const right = parseJson(b);
  if (left === undefined || right === undefined) return null;
  return signature(inferShape(left)) === signature(inferShape(right));
}

/** Human-readable outline used in the detail pane and the OpenAPI groundwork. */
export function describeShape(shape: Shape, indent = 0): string {
  const pad = '  '.repeat(indent);
  switch (shape.kind) {
    case 'object': {
      const entries = Object.entries(shape.fields);
      if (entries.length === 0) return '{}';
      const lines = entries.map(
        ([key, field]) => `${pad}  ${key}: ${describeShape(field, indent + 1)}`,
      );
      return `{\n${lines.join('\n')}\n${pad}}`;
    }
    case 'array':
      return shape.element ? `${describeShape(shape.element, indent)}[]` : 'unknown[]';
    case 'union':
      return shape.options.map((option) => describeShape(option, indent)).join(' | ');
    default:
      return shape.kind;
  }
}
