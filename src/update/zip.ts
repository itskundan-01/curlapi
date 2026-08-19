/**
 * Unpacking a zip, without a dependency and without shelling out.
 *
 * The update payload has to be unpacked on all three platforms by whatever is
 * already installed. `tar` exists on macOS and Linux and on recent Windows, but
 * "recent" is doing real work in that sentence, and a self-update that fails on
 * an older Windows is worse than no self-update at all. Node has no archive
 * reader of its own, so this is the third hand-written format in the codebase,
 * for the same reason as the other two.
 *
 * It is a close relative of the reader in the .docx importer, which pulls a
 * single known entry out of an archive. This one walks every entry and writes it
 * to disk, which brings in two things that one did not need: directories, and
 * the question of whether an entry is allowed to be where it says it is.
 */

import { inflateRawSync } from 'node:zlib';
import { mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;

/** Stored and deflated. No zip we produce uses anything else. */
const STORED = 0;
const DEFLATED = 8;

function findEndOfCentralDirectory(zip: Buffer): number {
  // The record sits at the very end unless the archive carries a comment, so
  // scan backwards over the largest comment the format allows.
  const earliest = Math.max(0, zip.length - 22 - 0xffff);
  for (let i = zip.length - 22; i >= earliest; i--) {
    if (zip.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY) return i;
  }
  return -1;
}

/**
 * Rejects an entry name that would write outside the destination.
 *
 * A zip is just a list of paths, and nothing stops one saying `../../.bashrc`.
 * This code runs on an archive fetched over the network, so the check is not
 * paranoia about our own build — it is what makes a compromised or corrupted
 * download unable to touch anything but the directory being replaced.
 */
function safeJoin(destination: string, name: string): string | null {
  if (name.includes('\0')) return null;

  // Absolute paths and Windows drive letters are rejected outright rather than
  // normalised, because there is no reading of them that is legitimate here.
  if (name.startsWith('/') || name.startsWith('\\') || /^[a-z]:/i.test(name)) return null;

  const target = resolve(destination, name);
  const root = resolve(destination);
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

export type ExtractResult = {
  files: number;
  /** Entries refused by the traversal check, by name. */
  rejected: string[];
};

/**
 * Writes every entry in `zip` beneath `destination`.
 *
 * Reads the central directory rather than scanning local headers: a local header
 * may declare its sizes as zero and defer them to a descriptor that follows the
 * compressed data, which cannot be located without already knowing the length.
 */
export function extractZip(zip: Buffer, destination: string): ExtractResult {
  const eocd = findEndOfCentralDirectory(zip);
  if (eocd === -1) throw new Error('Not a zip archive: no end-of-central-directory record.');

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  const rejected: string[] = [];
  let files = 0;

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) {
      throw new Error(`Corrupt zip: entry ${i + 1} has no central file header.`);
    }

    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const externalAttributes = zip.readUInt32LE(offset + 38);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    offset += 46 + nameLength + extraLength + commentLength;

    const target = safeJoin(destination, name);
    if (target === null) {
      rejected.push(name);
      continue;
    }

    // A trailing separator is how a zip marks a directory entry; it carries no
    // data of its own.
    if (name.endsWith('/') || name.endsWith('\\')) {
      mkdirSync(target, { recursive: true });
      continue;
    }

    // The local header repeats the name and extra fields at its own lengths,
    // which routinely differ from the central directory's, so the start of the
    // data has to be computed from the local copy.
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(start, start + compressedSize);

    let contents: Buffer;
    if (method === STORED) {
      contents = Buffer.from(raw);
    } else if (method === DEFLATED) {
      try {
        contents = inflateRawSync(raw);
      } catch (err) {
        // zlib's own wording for a truncated stream is "unexpected end of file",
        // which reads like a bug in the reader rather than a bad download.
        throw new Error(
          `Corrupt zip: ${name} could not be decompressed ` +
            `(${err instanceof Error ? err.message : String(err)}).`,
        );
      }
    } else {
      throw new Error(`Unsupported compression method ${method} for ${name}.`);
    }

    if (contents.length !== uncompressedSize) {
      throw new Error(
        `Corrupt zip: ${name} unpacked to ${contents.length} bytes, expected ${uncompressedSize}.`,
      );
    }

    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents);

    // The top 16 bits hold the Unix mode when the archive was made on a Unix
    // system. Without this the executable bit on bin/curlapi.js is lost, and the
    // npm-installed command stops working after an update.
    const mode = (externalAttributes >>> 16) & 0o7777;
    if (mode !== 0 && process.platform !== 'win32') {
      try {
        chmodSync(target, mode);
      } catch {
        // A filesystem that will not take the mode is not a reason to fail the
        // whole update; the file itself is written either way.
      }
    }

    files++;
  }

  return { files, rejected };
}

/** Where a payload's own entries live, for callers that need to check one. */
export function zipEntryNames(zip: Buffer): string[] {
  const eocd = findEndOfCentralDirectory(zip);
  if (eocd === -1) return [];

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const names: string[] = [];

  for (let i = 0; i < entryCount; i++) {
    if (zip.readUInt32LE(offset) !== CENTRAL_FILE_HEADER) break;
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  // `join` is not used on these: they are archive paths, not filesystem paths,
  // and normalising them here would hide exactly what the caller wants to see.
  return names;
}

/** Used by the updater to confirm a payload looks like curlapi before swapping. */
export function looksLikeCurlapiPayload(zip: Buffer): boolean {
  const names = new Set(zipEntryNames(zip));
  return names.has('src/cli.ts') && names.has('package.json');
}
