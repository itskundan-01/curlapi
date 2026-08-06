import type { DocEntry, DocFolder, SessionRecord } from '../types.ts';

/**
 * What rendering a document actually needs.
 *
 * Excludes the record snapshot so the same functions serve the server, which
 * holds full entries, and the UI, which holds entries with the snapshot removed
 * and the command already resolved.
 */
type DocLine = Omit<DocEntry, 'recordSnapshot'>;

/** Entries grouped into the documents they belong to, in folder order. */
function group(
  entries: DocLine[],
  folders: DocFolder[],
): Array<{ folder: DocFolder | null; entries: DocLine[] }> {
  if (folders.length === 0) return [{ folder: null, entries }];

  const groups: Array<{ folder: DocFolder | null; entries: DocLine[] }> = folders.map(
    (folder) => ({
      folder,
      entries: entries.filter((entry) => entry.folderId === folder.id),
    }),
  );

  // Entries whose folder is missing would otherwise vanish from the export,
  // which is the one failure a document must never have.
  const known = new Set(folders.map((folder) => folder.id));
  const orphans = entries.filter((entry) => !known.has(entry.folderId));
  if (orphans.length > 0) groups.push({ folder: null, entries: orphans });

  return groups.filter((entry) => entry.entries.length > 0);
}

/**
 * Renders the working document as Markdown.
 *
 * Entries are numbered in document order rather than capture order — the point
 * of the document is the sequence the user chose, which is usually the order a
 * flow actually happens in (request OTP, then verify, then fetch profile).
 * Numbering restarts in each folder, so "#2 in the login flow" stays stable no
 * matter what gets added to the other documents.
 */
export function toMarkdown(
  entries: DocLine[],
  session: SessionRecord,
  curlFor: (entry: DocLine) => string,
  folders: DocFolder[] = [],
): string {
  const lines: string[] = [];

  lines.push(`# ${session.label}`);
  lines.push('');
  lines.push(
    `Captured from ${session.primaryHost ?? 'a browser session'} on ` +
      `${new Date(session.startedAt).toLocaleString()}.`,
  );
  lines.push('');

  const groups = group(entries, folders);
  const multiple = groups.length > 1;

  for (const { folder, entries: inFolder } of groups) {
    if (multiple && folder) {
      lines.push(`# ${folder.name}`);
      lines.push('');
    }

    // A short index is worth the few lines once a document passes a handful of
    // endpoints, which is the point at which it stops being scannable.
    const withCommands = inFolder.filter((entry) => entry.requestId !== null);
    if (withCommands.length > 3) {
      lines.push('## Contents');
      lines.push('');
      withCommands.forEach((entry, index) => {
        const label = entry.title || 'untitled';
        lines.push(
          `${index + 1}. ${label} — \`${entry.method} ${entry.status ?? ''}\``.trimEnd(),
        );
      });
      lines.push('');
    }

    // Notes are headings and sit outside the count, so the numbers here are the
    // same ones shown in the Doc tab and produced by "Copy all".
    let commandNumber = 0;

    inFolder.forEach((entry) => {
      // A note without a request is a heading or a paragraph the user typed.
      if (entry.requestId === null) {
        if (entry.title) {
          lines.push(`## ${entry.title}`);
          lines.push('');
        }
        if (entry.note) {
          lines.push(entry.note);
          lines.push('');
        }
        return;
      }

      commandNumber++;
      lines.push(`## ${commandNumber}. ${entry.title || 'untitled'}`);
      lines.push('');
      lines.push(
        `\`${entry.method}\` · \`${entry.status ?? '—'}\`` +
          (entry.url ? `\n\n<${entry.url}>` : ''),
      );
      lines.push('');
      if (entry.note) {
        lines.push(entry.note);
        lines.push('');
      }
      lines.push('```bash');
      lines.push(curlFor(entry));
      lines.push('```');
      lines.push('');
    });
  }

  return lines.join('\n');
}

/**
 * Every command in one document as plain text, ready for the clipboard.
 *
 * Each command is preceded by a `#` comment carrying its number, name, method
 * and status, and separated from the next by a blank line. Comments rather than
 * bare labels because the result then pastes into a shell and runs, which is
 * exactly what someone reaching for "copy all" is about to try.
 *
 * Shared with the UI, so it must stay free of Node built-ins.
 */
export function toCopyBlock(
  entries: DocLine[],
  curlFor: (entry: DocLine) => string,
): string {
  const blocks: string[] = [];
  let commandNumber = 0;

  entries.forEach((entry) => {
    if (entry.requestId === null) {
      // Notes are the user's own structure; keep them as comments so the
      // grouping survives the paste instead of the list arriving unlabelled.
      const text = [entry.title, entry.note].filter(Boolean).join('\n');
      if (text) blocks.push(text.split('\n').map((line) => `# ${line}`.trimEnd()).join('\n'));
      return;
    }

    commandNumber++;
    const heading =
      `# ${commandNumber}. ${entry.title || 'untitled'}` +
      (entry.method ? ` — ${entry.method}` : '') +
      (entry.status === null ? '' : ` ${entry.status}`);
    const curl = curlFor(entry);
    blocks.push(curl ? `${heading}\n${curl}` : heading);
  });

  // Trailing newline: a shell paste ending mid-line waits for Enter, and the
  // last command silently not running is the worst way to learn that.
  return blocks.length > 0 ? `${blocks.join('\n\n')}\n` : '';
}
