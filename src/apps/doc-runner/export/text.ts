/**
 * The two flat exports: a shell script, and a Markdown summary.
 *
 * Both reuse the capture side's curl builder, so a command exported here escapes
 * exactly the way one exported from a capture does — including the PowerShell
 * and one-line forms, which took real work to get right and are not worth
 * having a second, subtly different implementation of.
 */

import { buildCurl } from '../../../curl/build.ts';
import type { CurlOptions } from '../../../types.ts';
import type { ParsedEndpoint, Variable } from '../types.ts';
import { toRequestRecord } from '../resolve.ts';

export function toShellScript(
  endpoints: ParsedEndpoint[],
  variables: Variable[],
  title: string,
  options: CurlOptions,
): string {
  const lines = [
    '#!/usr/bin/env bash',
    '# ' + title,
    `# ${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'} imported from an API document by curlapi.`,
    '#',
    '# Each command is left commented-out. Uncomment the ones you want and run,',
    '# or copy them individually — running an unreviewed file of POSTs against a',
    '# live service is rarely what anybody meant to do.',
    '',
    'set -euo pipefail',
    '',
  ];

  // Unfilled placeholders become shell variables at the top, which is both a
  // checklist and the thing that makes the script runnable at all.
  const unfilled = variables.filter((variable) => variable.value.length === 0);
  if (unfilled.length > 0) {
    lines.push('# Fill these in before running:');
    for (const variable of unfilled) {
      lines.push(`${shellName(variable.key)}=""`);
    }
    lines.push('');
  }

  endpoints.forEach((endpoint, index) => {
    const record = toRequestRecord(endpoint, variables);
    lines.push(`# ${index + 1}. ${endpoint.name}`);
    if (endpoint.section.length > 0) lines.push(`#    ${endpoint.section.join(' › ')}`);
    for (const warning of endpoint.warnings) lines.push(`#    ! ${warning}`);
    lines.push(
      buildCurl(record, options)
        .split('\n')
        .map((line) => `# ${line}`)
        .join('\n'),
    );
    lines.push('');
  });

  return lines.join('\n');
}

function shellName(key: string): string {
  return key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

export function toMarkdown(
  endpoints: ParsedEndpoint[],
  variables: Variable[],
  title: string,
  options: CurlOptions,
): string {
  const out: string[] = [`# ${title}`, ''];

  out.push(
    `${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}, imported from an API document by curlapi.`,
    '',
  );

  if (variables.length > 0) {
    out.push('## Values used', '');
    out.push('| Name | Value | Source |', '| --- | --- | --- |');
    for (const variable of variables) {
      // A credential is named but never printed: this file gets committed.
      const shown = variable.secret
        ? variable.value
          ? '`(set — hidden)`'
          : '`(not set)`'
        : variable.value || '`(not set)`';
      out.push(`| \`${variable.key}\` | ${shown} | ${variable.origin} |`);
    }
    out.push('');
  }

  out.push('## Endpoints', '');
  endpoints.forEach((endpoint, index) => {
    out.push(`### ${index + 1}. ${endpoint.name}`, '');
    if (endpoint.section.length > 0) out.push(`*${endpoint.section.join(' › ')}*`, '');
    if (endpoint.description) out.push(endpoint.description, '');

    out.push(`\`${endpoint.method} ${endpoint.url}\``, '');

    if (endpoint.warnings.length > 0) {
      for (const warning of endpoint.warnings) out.push(`> **Check:** ${warning}`);
      out.push('');
    }

    const record = toRequestRecord(endpoint, variables);
    out.push('```bash', buildCurl(record, options), '```', '');

    const requestFields = endpoint.params.filter((param) => param.in !== 'response');
    const responseFields = endpoint.params.filter((param) => param.in === 'response');

    for (const [heading, fields] of [
      ['Request fields', requestFields],
      ['Response fields', responseFields],
    ] as const) {
      if (fields.length === 0) continue;
      out.push(`**${heading}**`, '');
      out.push('| Field | In | Type | Required | Description |', '| --- | --- | --- | --- | --- |');
      for (const field of fields) {
        out.push(
          `| \`${field.name}\` | ${field.in} | ${field.dataType || '—'} | ` +
            `${field.required ? 'yes' : '—'} | ${cell(field.description)} |`,
        );
      }
      out.push('');
    }

    if (endpoint.documentedResponse) {
      out.push('**Documented response**', '', '```json', endpoint.documentedResponse, '```', '');
    }

    if (endpoint.responseCodes.length > 0) {
      out.push('**Response codes**', '', '| Code | Meaning |', '| --- | --- |');
      for (const code of endpoint.responseCodes) {
        out.push(`| \`${code.code}\` | ${cell(code.description)} |`);
      }
      out.push('');
    }
  });

  return out.join('\n');
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n+/g, ' ') || '—';
}
