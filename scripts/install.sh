#!/bin/sh
#
# curlapi installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/itskundan-01/curlapi/main/scripts/install.sh | sh
#
# Deliberately POSIX sh, not bash: /bin/sh is dash on Debian and Ubuntu, and an
# installer that assumes bash fails on the machines least likely to have anything
# else installed.
#
# What it does, in order: fetch the application, make sure there is a Node 24 to
# run it with — downloading one only if the machine has none — and register it as
# something clickable. Nothing is installed system-wide and nothing needs sudo;
# everything lands under ~/.curlapi, which the tool already uses for its data.
#
# Why a shell installer rather than a .pkg or .dmg: files fetched by curl carry
# no quarantine flag, so this path has no Gatekeeper prompt and no "unidentified
# developer" wall, which a downloaded installer would have without a paid
# signing certificate.

set -eu

REPO="itskundan-01/curlapi"

# Pinned rather than "latest", so an install today and an install next month put
# the same runtime on disk. Bumping it is a deliberate commit.
NODE_VERSION="24.19.0"

# The oldest Node the tool can use: below this there is no `node:sqlite` and no
# direct TypeScript execution, which are the two things it is built on.
NODE_MINIMUM_MAJOR=24

CURLAPI_HOME="${CURLAPI_HOME:-$HOME/.curlapi}"
APP_DIR="$CURLAPI_HOME/app"
RUNTIME_DIR="$CURLAPI_HOME/runtime"
BIN_DIR="$CURLAPI_HOME/bin"

# --- output ---------------------------------------------------------------

if [ -t 1 ]; then
  BOLD=$(printf '\033[1m')
  DIM=$(printf '\033[2m')
  TEAL=$(printf '\033[36m')
  RED=$(printf '\033[31m')
  OFF=$(printf '\033[0m')
else
  BOLD=''; DIM=''; TEAL=''; RED=''; OFF=''
fi

say()  { printf '%s\n' "$*"; }
step() { printf '%s→%s %s\n' "$TEAL" "$OFF" "$*"; }
warn() { printf '%s!%s %s\n' "$RED" "$OFF" "$*" >&2; }
die()  { printf '\n%serror%s %s\n' "$RED" "$OFF" "$*" >&2; exit 1; }

# --- platform -------------------------------------------------------------

detect_platform() {
  os=$(uname -s)
  arch=$(uname -m)

  case "$os" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux" ;;
    *) die "Unsupported operating system: $os. curlapi installs on macOS and Linux; on Windows use scripts/install.ps1." ;;
  esac

  case "$arch" in
    x86_64 | amd64) ARCH="x64" ;;
    arm64 | aarch64) ARCH="arm64" ;;
    *) die "Unsupported processor: $arch. Prebuilt Node runtimes exist for x64 and arm64 only." ;;
  esac
}

# --- downloading ----------------------------------------------------------

if command -v curl >/dev/null 2>&1; then
  DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then
  DOWNLOADER="wget"
else
  die "Neither curl nor wget is available, so there is no way to fetch anything."
fi

fetch() {
  # fetch <url> <destination>
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL --retry 3 --connect-timeout 20 "$1" -o "$2"
  else
    wget -q --tries=3 --timeout=20 -O "$2" "$1"
  fi
}

fetch_stdout() {
  if [ "$DOWNLOADER" = "curl" ]; then
    curl -fsSL --retry 3 --connect-timeout 20 "$1"
  else
    wget -q --tries=3 --timeout=20 -O - "$1"
  fi
}

# Two names for one algorithm: coreutils calls it sha256sum, macOS ships shasum.
sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    echo ""
  fi
}

verify_sha256() {
  # verify_sha256 <file> <expected> <label>
  actual=$(sha256_of "$1")
  if [ -z "$actual" ]; then
    warn "No sha256 tool found, so $3 could not be verified."
    return 0
  fi
  if [ "$actual" != "$2" ]; then
    die "Checksum mismatch on $3.
  expected  $2
  got       $actual
Refusing to install it. Try again, and if it repeats, open an issue."
  fi
}

# --- the application ------------------------------------------------------

resolve_version() {
  if [ -n "${CURLAPI_VERSION:-}" ]; then
    VERSION="$CURLAPI_VERSION"
    return
  fi
  # The releases API rather than a "latest" redirect, because this repo publishes
  # prereleases and the tag has to be read rather than guessed.
  VERSION=$(fetch_stdout "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null \
    | grep -o '"tag_name"[^,]*' | head -1 | cut -d'"' -f4 | sed 's/^v//') || VERSION=""
  [ -n "$VERSION" ] || die "Could not work out the latest curlapi version from GitHub.
Set one explicitly:  CURLAPI_VERSION=0.2.0-beta.1 sh install.sh"
}

install_app() {
  staging="$CURLAPI_HOME/.staging-app"
  rm -rf "$staging"
  mkdir -p "$staging"

  if [ -n "${CURLAPI_INSTALL_FROM:-}" ]; then
    # Escape hatch for developing the installer itself: take the payload from a
    # local checkout or tarball instead of a published release.
    step "Installing from ${CURLAPI_INSTALL_FROM}"
    if [ -d "$CURLAPI_INSTALL_FROM" ]; then
      (cd "$CURLAPI_INSTALL_FROM" && tar -cf - \
        bin src ui/dist assets scripts/make-icons.mjs package.json node_modules) \
        | (cd "$staging" && tar -xf -)
    else
      tar -xzf "$CURLAPI_INSTALL_FROM" -C "$staging"
    fi
    VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$staging/package.json" | head -1)
  else
    resolve_version
    step "Fetching curlapi $VERSION"
    archive="$CURLAPI_HOME/.curlapi-app.tar.gz"
    base="https://github.com/$REPO/releases/download/v$VERSION"

    fetch "$base/curlapi-$VERSION-app.tar.gz" "$archive" \
      || die "Could not download curlapi $VERSION. Check the release exists at
  https://github.com/$REPO/releases"

    # The checksums file is small and always published beside the payload; a
    # release without one is a release that should not be trusted.
    if sums=$(fetch_stdout "$base/SHA256SUMS" 2>/dev/null) && [ -n "$sums" ]; then
      expected=$(printf '%s\n' "$sums" | grep "curlapi-$VERSION-app.tar.gz" | cut -d' ' -f1)
      [ -n "$expected" ] && verify_sha256 "$archive" "$expected" "the curlapi payload"
    else
      warn "No SHA256SUMS published for this release; skipping verification."
    fi

    tar -xzf "$archive" -C "$staging"
    rm -f "$archive"
  fi

  [ -f "$staging/src/cli.ts" ] || die "The downloaded payload is missing src/cli.ts — it is not a curlapi build."

  # Swap rather than overwrite: an interrupted extraction must not leave a
  # half-replaced installation that starts and then fails somewhere deeper.
  rm -rf "$APP_DIR.old"
  [ -d "$APP_DIR" ] && mv "$APP_DIR" "$APP_DIR.old"
  mv "$staging" "$APP_DIR"
  rm -rf "$APP_DIR.old"
}

# --- the runtime ----------------------------------------------------------

node_major() {
  # Asking Node itself avoids parsing a version string that has had a `v`, a
  # `-nightly`, or a distribution suffix on it depending on where it came from.
  "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

ensure_runtime() {
  if [ -x "$RUNTIME_DIR/bin/node" ] && [ "$(node_major "$RUNTIME_DIR/bin/node")" -ge "$NODE_MINIMUM_MAJOR" ]; then
    step "Using the Node runtime already in $RUNTIME_DIR"
    RUNTIME_KIND="bundled"
    return
  fi

  if command -v node >/dev/null 2>&1; then
    have=$(node_major "$(command -v node)")
    if [ "$have" -ge "$NODE_MINIMUM_MAJOR" ]; then
      step "Using the Node $have already on this machine"
      RUNTIME_KIND="system"
      return
    fi
    say "  ${DIM}Node $have is installed but curlapi needs $NODE_MINIMUM_MAJOR or newer.${OFF}"
  fi

  step "Downloading Node $NODE_VERSION (about 50 MB, once)"

  case "$OS" in
    darwin) node_pkg="node-v$NODE_VERSION-darwin-$ARCH.tar.gz" ;;
    linux)  node_pkg="node-v$NODE_VERSION-linux-$ARCH.tar.xz" ;;
  esac

  node_url="https://nodejs.org/dist/v$NODE_VERSION/$node_pkg"
  node_archive="$CURLAPI_HOME/.$node_pkg"

  fetch "$node_url" "$node_archive" || die "Could not download Node from $node_url"

  if sums=$(fetch_stdout "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt" 2>/dev/null); then
    expected=$(printf '%s\n' "$sums" | grep " $node_pkg\$" | cut -d' ' -f1)
    [ -n "$expected" ] && verify_sha256 "$node_archive" "$expected" "the Node runtime"
  else
    warn "Could not fetch Node's checksums; skipping verification."
  fi

  staging="$CURLAPI_HOME/.staging-runtime"
  rm -rf "$staging"
  mkdir -p "$staging"

  # --strip-components drops the node-vX.Y.Z-os-arch/ directory the official
  # tarballs wrap everything in, so bin/node lands where the shim expects it.
  case "$node_pkg" in
    *.tar.xz)
      tar -xJf "$node_archive" -C "$staging" --strip-components=1 \
        || die "Could not extract $node_pkg — is xz available?" ;;
    *) tar -xzf "$node_archive" -C "$staging" --strip-components=1 ;;
  esac
  rm -f "$node_archive"

  [ -x "$staging/bin/node" ] || die "The extracted Node has no bin/node in it."

  rm -rf "$RUNTIME_DIR"
  mv "$staging" "$RUNTIME_DIR"

  # npm and the headers are for building things; curlapi has no build step and
  # no native modules, so removing them saves about 60 MB of the install.
  rm -rf "$RUNTIME_DIR/lib/node_modules" "$RUNTIME_DIR/include" "$RUNTIME_DIR/share"
  rm -f "$RUNTIME_DIR/bin/npm" "$RUNTIME_DIR/bin/npx" "$RUNTIME_DIR/bin/corepack"

  RUNTIME_KIND="bundled"
}

# --- the launcher ---------------------------------------------------------

write_shim() {
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/curlapi" <<SHIM
#!/bin/sh
# Generated by the curlapi installer. Finds a Node to run the tool with, then
# hands over to it. Regenerated on every install, so edits here are lost.
set -eu

CURLAPI_HOME="\${CURLAPI_HOME:-$CURLAPI_HOME}"
APP="\$CURLAPI_HOME/app/src/cli.ts"

node_major() {
  "\$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

# The bundled runtime wins when there is one: it is the version this install was
# tested against, and it cannot be changed out from under us by a system update.
if [ -x "\$CURLAPI_HOME/runtime/bin/node" ]; then
  NODE="\$CURLAPI_HOME/runtime/bin/node"
elif command -v node >/dev/null 2>&1 && [ "\$(node_major "\$(command -v node)")" -ge $NODE_MINIMUM_MAJOR ]; then
  NODE=\$(command -v node)
else
  echo "curlapi cannot find a Node $NODE_MINIMUM_MAJOR runtime." >&2
  echo "Reinstall to fetch one:" >&2
  echo "  curl -fsSL https://raw.githubusercontent.com/$REPO/main/scripts/install.sh | sh" >&2
  exit 1
fi

exec "\$NODE" "\$APP" "\$@"
SHIM
  chmod +x "$BIN_DIR/curlapi"
}

link_onto_path() {
  # Preferred in order: a directory already on PATH that we can write to. No
  # sudo anywhere — an installer that asks for a password to put a symlink in
  # /usr/local/bin is asking for more trust than it needs.
  for candidate in "$HOME/.local/bin" "$HOME/bin" "/usr/local/bin"; do
    case ":$PATH:" in
      *":$candidate:"*) ;;
      *) continue ;;
    esac
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      ln -sf "$BIN_DIR/curlapi" "$candidate/curlapi"
      LINKED="$candidate/curlapi"
      return
    fi
  done

  # Nothing suitable was already on PATH, so make the conventional location and
  # tell the user how to reach it.
  mkdir -p "$HOME/.local/bin"
  ln -sf "$BIN_DIR/curlapi" "$HOME/.local/bin/curlapi"
  LINKED="$HOME/.local/bin/curlapi"
  case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) NEEDS_PATH="yes" ;;
  esac
}

# --- something to click ---------------------------------------------------

install_macos_app() {
  bundle="$HOME/Applications/curlapi.app"
  rm -rf "$bundle"
  mkdir -p "$bundle/Contents/MacOS" "$bundle/Contents/Resources"

  cp "$APP_DIR/assets/curlapi.icns" "$bundle/Contents/Resources/curlapi.icns" 2>/dev/null || true

  cat > "$bundle/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>curlapi</string>
  <key>CFBundleDisplayName</key><string>curlapi</string>
  <key>CFBundleIdentifier</key><string>dev.curlapi.workspace</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleExecutable</key><string>curlapi</string>
  <key>CFBundleIconFile</key><string>curlapi</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
</dict>
</plist>
PLIST

  cat > "$bundle/Contents/MacOS/curlapi" <<LAUNCHER
#!/bin/sh
# Launched by Finder, where there is no terminal and nothing reads stdout, so
# the workspace's output goes to a log worth having when something misbehaves.
CURLAPI_HOME="\${CURLAPI_HOME:-$CURLAPI_HOME}"
mkdir -p "\$CURLAPI_HOME/logs"
exec "$BIN_DIR/curlapi" app >>"\$CURLAPI_HOME/logs/desktop.log" 2>&1
LAUNCHER
  chmod +x "$bundle/Contents/MacOS/curlapi"

  # Apple Silicon refuses to execute a binary with no signature at all. Nothing
  # here is a Mach-O binary today, but ad-hoc signing the bundle costs nothing,
  # is free of any developer account, and keeps the launcher honest if that ever
  # changes. Notarisation is the part that costs money, and is not needed for an
  # app that was installed from a terminal rather than downloaded in a browser.
  if command -v codesign >/dev/null 2>&1; then
    codesign --force --deep --sign - "$bundle" >/dev/null 2>&1 || true
  fi

  # Finder caches bundle metadata aggressively; without this the icon and name
  # can stay stale until the next login.
  if [ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]; then
    /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
      -f "$bundle" >/dev/null 2>&1 || true
  fi

  DESKTOP_ENTRY="$bundle"
}

install_linux_desktop() {
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor"
  mkdir -p "$apps"

  for size in 16 32 48 64 128 256 512; do
    if [ -f "$APP_DIR/assets/icon-$size.png" ]; then
      mkdir -p "$icons/${size}x${size}/apps"
      cp "$APP_DIR/assets/icon-$size.png" "$icons/${size}x${size}/apps/curlapi.png"
    fi
  done

  cat > "$apps/curlapi.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=curlapi
GenericName=API workspace
Comment=Capture a browser session's API calls as curl, or turn an API document into runnable requests
Exec=$BIN_DIR/curlapi app
Icon=curlapi
Terminal=false
Categories=Development;WebDevelopment;Utility;
Keywords=api;curl;http;postman;devtools;
# Matches --class=curlapi on the browser window the launcher opens, so the dock
# groups that window under this icon instead of under the browser's.
StartupWMClass=curlapi
DESKTOP

  chmod +x "$apps/curlapi.desktop"

  command -v update-desktop-database >/dev/null 2>&1 && \
    update-desktop-database "$apps" >/dev/null 2>&1 || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && \
    gtk-update-icon-cache -f -t "$icons" >/dev/null 2>&1 || true

  DESKTOP_ENTRY="$apps/curlapi.desktop"
}

# --- run ------------------------------------------------------------------

LINKED=""
NEEDS_PATH=""
DESKTOP_ENTRY=""
RUNTIME_KIND=""

say ""
say "${BOLD}curlapi${OFF}"
say "${DIM}a local workspace of API utilities${OFF}"
say ""

detect_platform
mkdir -p "$CURLAPI_HOME"

install_app
ensure_runtime
write_shim
link_onto_path

step "Registering the app"
case "$OS" in
  darwin) install_macos_app ;;
  linux)  install_linux_desktop ;;
esac

say ""
say "${BOLD}Installed curlapi $VERSION${OFF}"
say ""
say "  Command      ${LINKED}"
say "  Application  ${DESKTOP_ENTRY}"
say "  Runtime      $([ "$RUNTIME_KIND" = "bundled" ] && echo "bundled Node $NODE_VERSION" || echo "the Node already on this machine")"
say "  Data         $CURLAPI_HOME"
say ""

if [ -n "$NEEDS_PATH" ]; then
  say "${BOLD}One thing left${OFF} — \$HOME/.local/bin is not on your PATH. Add it:"
  say ""
  say "  ${DIM}echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.profile${OFF}"
  say ""
fi

if [ "$OS" = "darwin" ]; then
  say "Open it from Spotlight or ~/Applications, or run ${BOLD}curlapi${OFF} in a terminal."
else
  say "Open it from your applications menu, or run ${BOLD}curlapi${OFF} in a terminal."
fi
say ""
