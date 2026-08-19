/**
 * Packs a directory into a zip, with no `zip` binary involved.
 *
 * The build needs a zip because Windows unpacks one with a built-in cmdlet and
 * has no tar worth relying on. But `zip` is not everywhere either — Git Bash on
 * a Windows runner has none, which is exactly where the Windows payload gets
 * built — so reaching for it made the build depend on the one platform it was
 * meant to serve.
 *
 * Writing the format is a smaller job than reading it, and the reader already
 * exists in src/update/zip.ts. The one thing that must be right is CRC-32:
 * PowerShell's Expand-Archive verifies it and rejects the archive if it does not
 * match, so an omitted checksum fails on Windows and nowhere else.
 *
 *   node scripts/make-zip.mjs <directory> <output.zip>
 */

import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// --- CRC-32 ---------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// --- walking --------------------------------------------------------------

function filesUnder(root) {
  const out = [];
  const walk = (dir) => {
    // Sorted, so two builds of the same tree lay entries down in the same order
    // and produce the same bytes.
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    )) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(root);
  return out;
}

// --- the format -----------------------------------------------------------

/**
 * A fixed timestamp, in the DOS format zip inherited.
 *
 * Real modification times would make the archive differ between builds of the
 * same commit, which defeats the point of publishing a checksum for it.
 */
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1; // 2020-01-01
const DOS_TIME = 0;

/** Bit 11 tells the reader the name is UTF-8 rather than the legacy code page. */
const UTF8_NAME = 0x0800;

function pack(root, output) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  let count = 0;

  for (const file of filesUnder(root)) {
    // Zip paths always use forward slashes, whatever the host separator is.
    const name = relative(root, file).split(sep).join('/');
    const nameBytes = Buffer.from(name, 'utf8');
    const contents = readFileSync(file);
    const compressed = deflateRawSync(contents, { level: 9 });
    const checksum = crc32(contents);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0, for deflate
    local.writeUInt16LE(UTF8_NAME, 6);
    local.writeUInt16LE(8, 8); // deflated
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4); // made by: 3 = Unix, so the mode is read
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_NAME, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    // The Unix mode goes in the top 16 bits. Without it the executable bit on
    // bin/curlapi.js is lost, and the command stops working after an update.
    central.writeUInt32LE((statSync(file).mode & 0o7777) << 16, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + compressed.length;
    count++;
  }

  const localBlock = Buffer.concat(locals);
  const centralBlock = Buffer.concat(centrals);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(localBlock.length, 16);

  writeFileSync(output, Buffer.concat([localBlock, centralBlock, end]));
  return count;
}

const [, , root, output] = process.argv;
if (!root || !output) {
  console.error('usage: node scripts/make-zip.mjs <directory> <output.zip>');
  process.exit(1);
}

console.log(`Packed ${pack(root, output)} files into ${output}`);
