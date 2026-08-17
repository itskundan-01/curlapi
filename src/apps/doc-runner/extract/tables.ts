/**
 * The two tables that describe an endpoint without being one.
 *
 * A parameter table:
 *   | # | Parameter Name | Description | Data Type | Expected Values |
 *   | 1 | benfTypeCd     | Beneficiary type | String | 1, 2 or 3     |
 *
 * A response-code table:
 *   | Response Code | Description                  |
 *   | 200           | Successful Response          |
 *   | 400           | Bad Request/Validation Error |
 *
 * Both are worth keeping. The parameter table is the only place a document says
 * what a field *means*, and dropping it would leave the reader with
 * `"benfTypeCd": "1"` and no way to know what to change it to. The response-code
 * table is what turns a 400 from a run into "validation error" rather than a
 * mystery.
 *
 * Recognising them also stops them being mistaken for endpoints, which is the
 * other reason this exists.
 */

import type { Table } from '../ingest/model.ts';
import type { DocParam, ParamIn, ResponseCode } from '../types.ts';
import { labelKey, squash } from '../normalize.ts';

const PARAM_NAME_HEADINGS = new Set([
  'parametername',
  'parameter',
  'parameters',
  'name',
  'fieldname',
  'field',
  'key',
  'attribute',
  'attributename',
  'element',
]);

const DESCRIPTION_HEADINGS = new Set([
  'description',
  'desc',
  'remarks',
  'meaning',
  'details',
  'comment',
  'comments',
]);

const TYPE_HEADINGS = new Set(['datatype', 'type', 'datatypes', 'fieldtype']);

const EXPECTED_HEADINGS = new Set([
  'expectedvalues',
  'expectedvalue',
  'samplevalue',
  'samplevalues',
  'example',
  'examples',
  'values',
  'possiblevalues',
  'value',
  'defaultvalue',
]);

const REQUIRED_HEADINGS = new Set([
  'required',
  'mandatory',
  'isrequired',
  'ismandatory',
  'optional',
  'requiredoptional',
]);

const IN_HEADINGS = new Set(['in', 'location', 'paramtype', 'parametertype', 'sentin']);

/** Column indices for the fields we understand, by heading text. */
type Columns = {
  name: number;
  description: number;
  type: number;
  expected: number;
  required: number;
  in: number;
};

function readColumns(headingRow: string[]): Columns | null {
  const columns: Columns = {
    name: -1,
    description: -1,
    type: -1,
    expected: -1,
    required: -1,
    in: -1,
  };

  headingRow.forEach((cell, index) => {
    const key = labelKey(cell);
    if (columns.name === -1 && PARAM_NAME_HEADINGS.has(key)) columns.name = index;
    else if (columns.description === -1 && DESCRIPTION_HEADINGS.has(key)) {
      columns.description = index;
    } else if (columns.type === -1 && TYPE_HEADINGS.has(key)) columns.type = index;
    else if (columns.expected === -1 && EXPECTED_HEADINGS.has(key)) columns.expected = index;
    else if (columns.required === -1 && REQUIRED_HEADINGS.has(key)) columns.required = index;
    else if (columns.in === -1 && IN_HEADINGS.has(key)) columns.in = index;
  });

  // A name column alone is not enough — a one-column list of words is not a
  // parameter table. One supporting column is the minimum.
  const supporting = [columns.description, columns.type, columns.expected, columns.required];
  if (columns.name === -1 || supporting.every((index) => index === -1)) return null;
  return columns;
}

const NEGATIVE_REQUIRED = /^(no|n|false|optional|not required|nullable)$/i;

function readRequired(cell: string, heading: string): boolean {
  const value = squash(cell).toLowerCase();
  if (value.length === 0) return false;
  // A column headed "Optional" inverts the sense of its own contents.
  const inverted = labelKey(heading) === 'optional';
  const positive = !NEGATIVE_REQUIRED.test(value);
  return inverted ? !positive : positive;
}

function readIn(cell: string): ParamIn | null {
  const value = squash(cell).toLowerCase();
  if (value.includes('path')) return 'path';
  if (value.includes('query') || value.includes('param')) return 'query';
  if (value.includes('header')) return 'header';
  if (value.includes('body') || value.includes('payload')) return 'body';
  return null;
}

/** Reads a parameter table, or returns null when the table is something else. */
export function readParamTable(table: Table): DocParam[] | null {
  if (table.rows.length < 2) return null;
  const columns = readColumns(table.rows[0]);
  if (!columns) return null;

  const heading = table.rows[0];
  const params: DocParam[] = [];

  for (const row of table.rows.slice(1)) {
    const name = squash(row[columns.name] ?? '');
    // A ragged row — the samples contain one where a cell was merged away — is
    // still worth reading for its name.
    if (name.length === 0) continue;
    // Numbering columns leak in when the `#` header is absent.
    if (/^\d+$/.test(name)) continue;

    params.push({
      name,
      in:
        (columns.in !== -1 ? readIn(row[columns.in] ?? '') : null) ??
        // Defaulted by the caller, which knows whether the endpoint has a body.
        'body',
      description: squash(row[columns.description] ?? ''),
      dataType: squash(row[columns.type] ?? ''),
      expected: squash(row[columns.expected] ?? ''),
      required:
        columns.required !== -1
          ? readRequired(row[columns.required] ?? '', heading[columns.required] ?? '')
          : false,
    });
  }

  return params.length > 0 ? params : null;
}

const CODE_HEADINGS = new Set([
  'responsecode',
  'code',
  'statuscode',
  'httpcode',
  'httpresponsecode',
  'errorcode',
  'status',
]);

/** Reads a response-code table, or returns null when it is something else. */
export function readResponseCodeTable(table: Table): ResponseCode[] | null {
  if (table.rows.length < 2) return null;

  const heading = table.rows[0];
  const codeColumn = heading.findIndex((cell) => CODE_HEADINGS.has(labelKey(cell)));
  if (codeColumn === -1) return null;

  const descriptionColumn = heading.findIndex(
    (cell, index) => index !== codeColumn && DESCRIPTION_HEADINGS.has(labelKey(cell)),
  );

  const codes: ResponseCode[] = [];
  const seen = new Set<string>();

  for (const row of table.rows.slice(1)) {
    const code = squash(row[codeColumn] ?? '');
    // Application codes like `PM0000` sit alongside HTTP ones in these
    // documents, so the test is "short and code-shaped", not "three digits".
    if (!/^[A-Z0-9_-]{2,12}$/i.test(code)) continue;
    // The samples repeat a row verbatim; a duplicate is a typo, not two codes.
    if (seen.has(code)) continue;
    seen.add(code);
    codes.push({
      code,
      description: squash(
        row[descriptionColumn !== -1 ? descriptionColumn : codeColumn + 1] ?? '',
      ),
    });
  }

  return codes.length > 0 ? codes : null;
}
