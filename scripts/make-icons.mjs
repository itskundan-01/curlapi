/**
 * Draws the application icon, and packs it into the three containers the
 * desktop platforms want.
 *
 * Written by hand for the same reason the .docx and PDF readers were: the
 * alternative is a toolchain. ImageMagick is not on a CI runner by default,
 * `iconutil` and `sips` exist only on macOS — which would mean the Windows icon
 * could only be built on a Mac — and an npm rasteriser would put a native
 * dependency into a project whose entire install story is that it has none.
 *
 * What it actually needs to do is small: fill a rounded rectangle, stroke three
 * line segments, and write PNG, ICNS and ICO. All three formats are containers
 * around PNG data at the sizes used here, so one encoder covers them all.
 *
 *   node scripts/make-icons.mjs
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');

// --- palette --------------------------------------------------------------

// The workspace's own dark surface and accent, from ui/src/styles.css. The icon
// is the first thing anyone sees of the tool, and it should already look like
// the thing it opens.
const BACKDROP_TOP = [24, 27, 32];
const BACKDROP_BOTTOM = [11, 12, 14];
const ACCENT = [63, 216, 198];

// --- geometry -------------------------------------------------------------

/**
 * Supersampling factor.
 *
 * Every shape below is a hard inside/outside test, so edges would be jagged at
 * 1 sample per pixel. Rendering at 4x and averaging 16 samples down is the whole
 * of the antialiasing strategy, and at these sizes it costs milliseconds.
 */
const SS = 4;

/** Distance from a point to a line segment — the primitive every stroke uses. */
function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  // A zero-length segment is a point, and projecting onto it would divide by zero.
  const t =
    lengthSquared === 0
      ? 0
      : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

/** Inside test for a rectangle with round corners, in unit coordinates. */
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  if (x < left || x > right || y < top || y > bottom) return false;

  // Only the corner squares need the circular test; everything else is inside
  // by the bounds check above.
  const cx = x < left + radius ? left + radius : x > right - radius ? right - radius : x;
  const cy = y < top + radius ? top + radius : y > bottom - radius ? bottom - radius : y;
  return Math.hypot(x - cx, y - cy) <= radius;
}

/**
 * The mark: a terminal prompt.
 *
 * A chevron and a caret rule, which is what a shell looks like anywhere, and
 * what this tool hands you — commands you can paste. Coordinates are in a 0..1
 * square so one description renders at every size.
 */
function drawPixel(x, y) {
  if (!insideRoundedRect(x, y, 0.06, 0.06, 0.94, 0.94, 0.21)) return null;

  const gradient = (y - 0.06) / 0.88;
  const backdrop = [
    BACKDROP_TOP[0] + (BACKDROP_BOTTOM[0] - BACKDROP_TOP[0]) * gradient,
    BACKDROP_TOP[1] + (BACKDROP_BOTTOM[1] - BACKDROP_TOP[1]) * gradient,
    BACKDROP_TOP[2] + (BACKDROP_BOTTOM[2] - BACKDROP_TOP[2]) * gradient,
  ];

  const stroke = 0.062;

  // The chevron, as two segments meeting at a point.
  const upper = distanceToSegment(x, y, 0.29, 0.34, 0.49, 0.5);
  const lower = distanceToSegment(x, y, 0.49, 0.5, 0.29, 0.66);
  // The rule that follows it, sitting on the same baseline.
  const rule = distanceToSegment(x, y, 0.58, 0.66, 0.75, 0.66);

  if (Math.min(upper, lower, rule) <= stroke) return ACCENT;
  return backdrop;
}

/** Renders one square RGBA bitmap at the requested edge length. */
function render(size) {
  const pixels = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS) / size;
          const y = (py + (sy + 0.5) / SS) / size;
          const colour = drawPixel(x, y);
          if (colour) {
            r += colour[0];
            g += colour[1];
            b += colour[2];
            a += 255;
          }
        }
      }

      const samples = SS * SS;
      const offset = (py * size + px) * 4;
      // Averaged over covered samples, not over all of them: dividing colour by
      // the full count would darken edge pixels towards black instead of
      // fading them out, which is the classic halo around a transparent corner.
      const covered = a / 255;
      pixels[offset] = covered ? Math.round(r / covered) : 0;
      pixels[offset + 1] = covered ? Math.round(g / covered) : 0;
      pixels[offset + 2] = covered ? Math.round(b / covered) : 0;
      pixels[offset + 3] = Math.round(a / samples);
    }
  }

  return pixels;
}

// --- PNG ------------------------------------------------------------------

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

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // truecolour with alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Filter byte 0 (None) per scanline. The image is flat colour and a couple of
  // edges, so deflate already does well and a filter search would buy nothing.
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- ICNS -----------------------------------------------------------------

/**
 * macOS icon types that take a PNG payload, and the pixel size each expects.
 *
 * Both members of each retina pair are listed — `ic08` and `ic13` are both
 * 256px, and macOS picks between them by context. Emitting one and not the
 * other is how an icon ends up crisp in Finder and blurry in the Dock.
 */
const ICNS_TYPES = [
  ['ic11', 32],
  ['ic12', 64],
  ['ic07', 128],
  ['ic13', 256],
  ['ic08', 256],
  ['ic14', 512],
  ['ic09', 512],
  ['ic10', 1024],
];

function encodeIcns(pngBySize) {
  const entries = ICNS_TYPES.map(([type, size]) => {
    const png = pngBySize.get(size);
    const header = Buffer.alloc(8);
    header.write(type, 0, 'latin1');
    // The length field counts its own 8-byte header as well as the payload.
    header.writeUInt32BE(png.length + 8, 4);
    return Buffer.concat([header, png]);
  });

  const body = Buffer.concat(entries);
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'latin1');
  header.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([header, body]);
}

// --- ICO ------------------------------------------------------------------

/** Sizes Windows actually asks for, from the taskbar up to the large-icon view. */
const ICO_SIZES = [16, 32, 48, 64, 128, 256];

function encodeIco(pngBySize) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // 1 = icon
  header.writeUInt16LE(ICO_SIZES.length, 4);

  const directory = Buffer.alloc(16 * ICO_SIZES.length);
  const images = ICO_SIZES.map((size) => pngBySize.get(size));

  let offset = header.length + directory.length;
  ICO_SIZES.forEach((size, index) => {
    const at = index * 16;
    // 256 does not fit in a byte and is encoded as 0 — the format's one wart.
    directory[at] = size === 256 ? 0 : size;
    directory[at + 1] = size === 256 ? 0 : size;
    directory[at + 2] = 0; // palette colours
    directory[at + 3] = 0; // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(images[index].length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += images[index].length;
  });

  return Buffer.concat([header, directory, ...images]);
}

// --- build ----------------------------------------------------------------

/** Every size any of the three containers asks for, rendered once each. */
const SIZES = [...new Set([...ICO_SIZES, ...ICNS_TYPES.map(([, size]) => size)])].sort(
  (a, b) => a - b,
);

mkdirSync(ASSETS, { recursive: true });

const pngBySize = new Map();
for (const size of SIZES) {
  pngBySize.set(size, encodePng(size, render(size)));
}

// Linux wants loose PNGs in the hicolor theme; these are the sizes it indexes.
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  writeFileSync(join(ASSETS, `icon-${size}.png`), pngBySize.get(size));
}

writeFileSync(join(ASSETS, 'curlapi.icns'), encodeIcns(pngBySize));
writeFileSync(join(ASSETS, 'curlapi.ico'), encodeIco(pngBySize));

console.log(`Wrote icons to ${ASSETS}`);
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  console.log(`  icon-${size}.png`.padEnd(22) + `${pngBySize.get(size).length} bytes`);
}
console.log('  curlapi.icns'.padEnd(22) + `${encodeIcns(pngBySize).length} bytes`);
console.log('  curlapi.ico'.padEnd(22) + `${encodeIco(pngBySize).length} bytes`);
