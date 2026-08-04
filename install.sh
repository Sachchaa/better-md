#!/bin/sh
# better-md installer.
#
#   curl -fsSL https://better-md.dev/install.sh | sh
#
# Downloads a self-contained better-md executable, verifies it against the
# published SHA256SUMS, and installs it. No Node.js required — the runtime is
# embedded in the binary.
#
# Environment:
#   BETTER_MD_VERSION   release tag to install (default: latest)
#   BETTER_MD_INSTALL   install directory   (default: $HOME/.local/bin)
#
# Uninstall: delete the two files it reports at the end.

set -eu

REPO="Sachchaa/better-md"
INSTALL_DIR="${BETTER_MD_INSTALL:-$HOME/.local/bin}"
VERSION="${BETTER_MD_VERSION:-latest}"

say() { printf '%s\n' "$*"; }
die() {
  printf 'better-md: %s\n' "$*" >&2
  exit 1
}

need() { command -v "$1" >/dev/null 2>&1 || die "this installer needs '$1' on PATH"; }

# --- work out which build to fetch -------------------------------------------

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported operating system '$os'. Prebuilt binaries cover macOS and Linux; on anything else install from source: https://github.com/$REPO" ;;
esac

arch=$(uname -m)
case "$arch" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported architecture '$arch'. Prebuilt binaries cover arm64 and x64." ;;
esac

asset="better-md-${os}-${arch}"

if [ "$VERSION" = latest ]; then
  base="https://github.com/$REPO/releases/latest/download"
else
  base="https://github.com/$REPO/releases/download/$VERSION"
fi

# --- download and verify ------------------------------------------------------

need curl
need mkdir
need install

# Prefer whichever checksum tool this platform ships.
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  die "need 'sha256sum' or 'shasum' to verify the download"
fi

tmp=$(mktemp -d)
# Clean up on any exit path, including interruption — never leave a partial
# binary lying around that a later run might mistake for a good one.
trap 'rm -rf "$tmp"' EXIT INT TERM

say "better-md: fetching $asset ($VERSION)"
curl -fsSL "$base/$asset" -o "$tmp/$asset" ||
  die "could not download $base/$asset
Check that release '$VERSION' exists and publishes an asset named '$asset'."

curl -fsSL "$base/SHA256SUMS" -o "$tmp/SHA256SUMS" ||
  die "downloaded the binary but not SHA256SUMS, so it cannot be verified. Refusing to install."

expected=$(grep " $asset\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 || true)
[ -n "$expected" ] || die "SHA256SUMS has no entry for '$asset'. Refusing to install unverified."

actual=$(checksum "$tmp/$asset")
if [ "$expected" != "$actual" ]; then
  die "checksum mismatch for $asset — refusing to install.
  expected $expected
  actual   $actual"
fi
say "better-md: checksum verified"

# --- install ------------------------------------------------------------------

mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"
install -m 755 "$tmp/$asset" "$INSTALL_DIR/better-md" ||
  die "could not write to $INSTALL_DIR. Set BETTER_MD_INSTALL to a writable directory."

# It also answers to the shorter 'btr-md'; a copy rather than a symlink so the
# binary reports whichever name was typed even if one is moved later.
install -m 755 "$tmp/$asset" "$INSTALL_DIR/btr-md" || true

say "better-md: installed to $INSTALL_DIR/better-md (and btr-md)"

# --- tell the user what to do next -------------------------------------------

case ":$PATH:" in
  *":$INSTALL_DIR:"*)
    say ""
    say "Try it:  better-md --plan"
    ;;
  *)
    say ""
    say "$INSTALL_DIR is not on your PATH. Add it:"
    say ""
    say "  echo 'export PATH=\"$INSTALL_DIR:\$PATH\"' >> ~/.zshrc   # or ~/.bashrc"
    say ""
    say "Then:  better-md --plan"
    ;;
esac
