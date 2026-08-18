/**
 * A JSON Schema draft-04 validator, small enough to read in one sitting.
 *
 * It exists for one document: the published Postman Collection v2.1 schema in
 * test/fixtures. That schema uses nine keywords — `type`, `enum`, `required`,
 * `properties`, `items`, `oneOf`, `anyOf`, `$ref`, `maxLength`, `minimum` — and
 * nothing else, so a general-purpose validator (and the dependency it would
 * add to a project that deliberately has almost none) buys nothing here.
 *
 * Errors carry the JSON path of the offending value, because the useful output
 * of a failed export test is *which* field is wrong, not that one is.
 */

import { readFileSync } from 'node:fs';

type Schema = Record<string, any>;

export type ValidationError = { path: string; message: string };

export function loadSchema(path: string): Schema {
  return JSON.parse(readFileSync(path, 'utf8')) as Schema;
}

export function validate(value: unknown, schema: Schema): ValidationError[] {
  const errors: ValidationError[] = [];
  check(value, schema, '$', schema, errors);
  return errors;
}

/** Resolves the only kind of reference the document uses: `#/definitions/x`. */
function deref(schema: Schema, root: Schema): Schema {
  let current = schema;
  // A `$ref` may point at a schema that is itself a `$ref`, though this one
  // never does. Following the chain costs three lines and removes the question.
  while (typeof current['$ref'] === 'string') {
    const pointer = current['$ref'] as string;
    if (!pointer.startsWith('#/')) throw new Error(`unsupported $ref: ${pointer}`);
    let target: any = root;
    for (const rawSegment of pointer.slice(2).split('/')) {
      const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
      target = target?.[segment];
    }
    if (!target) throw new Error(`unresolved $ref: ${pointer}`);
    current = target as Schema;
  }
  return current;
}

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value;
}

function matchesType(value: unknown, expected: string): boolean {
  const actual = typeOf(value);
  if (expected === 'number') return actual === 'number' || actual === 'integer';
  if (expected === 'integer') return actual === 'integer';
  return actual === expected;
}

function check(
  value: unknown,
  rawSchema: Schema,
  path: string,
  root: Schema,
  errors: ValidationError[],
): void {
  const schema = deref(rawSchema, root);

  if (schema['type'] !== undefined) {
    const allowed: string[] = Array.isArray(schema['type']) ? schema['type'] : [schema['type']];
    if (!allowed.some((expected) => matchesType(value, expected))) {
      errors.push({
        path,
        message: `expected ${allowed.join(' or ')}, got ${typeOf(value)}`,
      });
      return; // Every later keyword assumes the type held.
    }
  }

  if (Array.isArray(schema['enum']) && !schema['enum'].includes(value as never)) {
    errors.push({
      path,
      message: `${JSON.stringify(value)} is not one of ${JSON.stringify(schema['enum'])}`,
    });
  }

  if (typeof value === 'string' && typeof schema['maxLength'] === 'number') {
    if (value.length > schema['maxLength']) {
      errors.push({ path, message: `longer than maxLength ${schema['maxLength']}` });
    }
  }

  if (typeof value === 'number' && typeof schema['minimum'] === 'number') {
    if (value < schema['minimum']) {
      errors.push({ path, message: `below minimum ${schema['minimum']}` });
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;

    for (const key of (schema['required'] as string[] | undefined) ?? []) {
      if (!(key in object)) errors.push({ path, message: `missing required property "${key}"` });
    }

    const properties = (schema['properties'] as Record<string, Schema> | undefined) ?? {};
    for (const [key, child] of Object.entries(properties)) {
      // An absent optional property is not a violation; `undefined` never
      // survives JSON.stringify, so this mirrors what actually ships.
      if (object[key] === undefined) continue;
      check(object[key], child, `${path}.${key}`, root, errors);
    }
  }

  if (Array.isArray(value) && schema['items']) {
    const items = schema['items'] as Schema;
    value.forEach((entry, index) => check(entry, items, `${path}[${index}]`, root, errors));
  }

  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const branches = schema[keyword] as Schema[] | undefined;
    if (!branches) continue;
    // Draft-04's `oneOf` demands exactly one match, but the Postman schema uses
    // it where `anyOf` is meant — `{"type": "null"}` alongside a `$ref` whose
    // own branches overlap. Requiring exactly one would reject collections
    // Postman itself accepts, so both are checked as "at least one".
    const matched = branches.some((branch) => check2(value, branch, root).length === 0);
    if (!matched) {
      errors.push({
        path,
        message: `matched none of the ${branches.length} ${keyword} branches`,
      });
    }
  }
}

/** A trial run: collects errors for one branch without recording them. */
function check2(value: unknown, schema: Schema, root: Schema): ValidationError[] {
  const errors: ValidationError[] = [];
  check(value, schema, '$', root, errors);
  return errors;
}

/** Formats the first few errors for an assertion message. */
export function describeErrors(errors: ValidationError[]): string {
  return errors
    .slice(0, 8)
    .map((error) => `  ${error.path}: ${error.message}`)
    .join('\n');
}
