import type { CurlOptions, RequestRecord, SessionRecord } from '../types.ts';
import { buildCurl } from '../curl/build.ts';
import { resolveNames } from './naming.ts';

/**
 * A runnable shell script, serial-numbered so it lines up with the collection
 * view. Commands are commented rather than executed in sequence — replaying a
 * capture blindly would re-submit every POST in it.
 */
export function toShellScript(
  records: RequestRecord[],
  session: SessionRecord,
  options: CurlOptions,
): string {
  const names = resolveNames(records);
  const captured = new Date(session.startedAt).toISOString();

  const header = [
    '#!/usr/bin/env bash',
    '#',
    `# ${session.label}`,
    `# ${records.length} endpoint${records.length === 1 ? '' : 's'}` +
      (session.primaryHost ? ` from ${session.primaryHost}` : '') +
      `, captured ${captured}`,
    options.redact
      ? '#\n# Secrets are replaced with {{placeholders}} — substitute before running.'
      : '#\n# Contains live credentials from the captured session. Treat as a secret.',
    '',
    'set -euo pipefail',
    '',
  ].join('\n');

  const blocks = records.map((record, index) => {
    const status = record.status ?? (record.error ? 'ERR' : '—');
    const title = `# ${index + 1}. ${names[index]} — ${record.method} ${status}`;
    const detail = `#    ${record.url}`;
    const note = record.verdict.reason ? `#    kept: ${record.verdict.reason}` : '';
    return [title, detail, note, buildCurl(record, options)].filter(Boolean).join('\n');
  });

  return header + blocks.join('\n\n') + '\n';
}
