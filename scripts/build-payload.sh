#!/bin/sh
#
# Builds the release payload: the whole application, minus anything only needed
# to develop it.
#
#   sh scripts/build-payload.sh          # -> dist/curlapi-<version>-app.tar.gz
#
# One archive serves every platform. There is nothing compiled in it — no native
# modules, no per-arch binaries — so the only thing that varies between a Mac, a
# Windows machine and a Linux box is the Node runtime, which the installers fetch
# separately and which is not our business to ship.

set -eu

cd "$(dirname "$0")/.."

VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)
[ -n "$VERSION" ] || { echo "Could not read the version out of package.json" >&2; exit 1; }

OUT="dist"
STAGE="$OUT/payload"
ARCHIVE="$OUT/curlapi-$VERSION-app.tar.gz"
ZIP="$OUT/curlapi-$VERSION-app.zip"

echo "Building curlapi $VERSION"

rm -rf "$STAGE" "$ARCHIVE" "$ZIP"
mkdir -p "$STAGE"

echo "→ Building the UI and icons"
npm run build:icons --silent
npm run build:ui --silent >/dev/null

echo "→ Collecting runtime dependencies"
# Installed into the staging directory rather than pruned in place, so the
# working tree keeps its dev dependencies and this stays repeatable.
cp package.json package-lock.json "$STAGE/"
(cd "$STAGE" && npm ci --omit=dev --silent --no-audit --no-fund)
rm -f "$STAGE/package-lock.json"
# Symlinks to dependency executables, none of which this tool ever runs — it
# imports its two dependencies as libraries. Dropping them keeps the tar and zip
# payloads identical, since a zip cannot carry a symlink the same way.
rm -rf "$STAGE/node_modules/.bin"

echo "→ Copying the application"
cp -R bin src ui "$STAGE/"
rm -rf "$STAGE/ui/src" "$STAGE/ui/index.html"
mkdir -p "$STAGE/assets" "$STAGE/scripts"
cp assets/*.png assets/*.icns assets/*.ico "$STAGE/assets/"
cp scripts/make-icons.mjs "$STAGE/scripts/"
cp README.md LICENSE "$STAGE/"

# Reproducible-ish: a fixed mtime and sorted names mean two builds of the same
# commit produce the same bytes, so a checksum means something.
echo "→ Packing"
tar --format=ustar -czf "$ARCHIVE" -C "$STAGE" .

# The same payload as a zip, for Windows, written by Node rather than by `zip` —
# Git Bash on a Windows runner has no `zip`, which is precisely where this needs
# to work. See scripts/make-zip.mjs.
node scripts/make-zip.mjs "$STAGE" "$ZIP" >/dev/null

(cd "$OUT" && {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "curlapi-$VERSION-app.tar.gz" "curlapi-$VERSION-app.zip" > SHA256SUMS
  else
    shasum -a 256 "curlapi-$VERSION-app.tar.gz" "curlapi-$VERSION-app.zip" > SHA256SUMS
  fi
})

rm -rf "$STAGE"

echo ""
echo "  $ARCHIVE  ($(du -h "$ARCHIVE" | cut -f1))"
echo "  $ZIP  ($(du -h "$ZIP" | cut -f1))"
echo ""
cat "$OUT/SHA256SUMS"
