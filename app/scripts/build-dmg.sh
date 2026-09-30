#!/usr/bin/env bash
# Build MeetLoaf.app (arm64, unsigned), ad-hoc sign it, and package a DMG.
# Ad-hoc signing is enough to satisfy macOS's "must be signed" rule on Apple Silicon,
# but colleagues will still see a Gatekeeper prompt on first launch (documented in README).
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="MeetLoaf"
DIST_DIR="dist"
APP_DIR="$DIST_DIR/mac-arm64/$APP_NAME.app"
# No version in the filename on purpose: it keeps
# releases/latest/download/MeetLoaf-mac-arm64.dmg valid forever, so the
# install snippet in the README never goes stale. The app reports its own
# version under MeetLoaf → About.
DMG_OUT="$DIST_DIR/$APP_NAME-mac-arm64.dmg"

# 1. Build icon if missing
if [[ ! -f icon.icns ]]; then
  ./scripts/build-icon.sh
fi

# 2. Build unsigned .app via electron-builder
rm -rf "$DIST_DIR"
# --publish never: a publish provider is configured so electron-updater gets
# its latest.yml, but publishing is the release job's business alone. Without
# this, electron-builder's default (onTagOrDraft) would race it on tag builds.
npx electron-builder --mac --arm64 --publish never

if [[ ! -d "$APP_DIR" ]]; then
  echo "Expected build at $APP_DIR not found" >&2
  exit 1
fi

# 3. Ad-hoc sign (the "-" identity) so Gatekeeper will at least launch it
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep "$APP_DIR"

# 4. Package into a DMG
#
# Staged through a temp folder holding the app plus a symlink to /Applications,
# which is what gives the mounted volume the familiar drag-across-to-install
# layout. Pointing hdiutil straight at the .app (as this did before) produces a
# volume containing only the app, leaving people to find /Applications
# themselves. The symlink costs nothing in the image — it's a link, not a copy.
STAGING="$(mktemp -d)"
trap 'rm -rf "$STAGING"' EXIT
cp -R "$APP_DIR" "$STAGING/"
ln -s /Applications "$STAGING/Applications"

rm -f "$DMG_OUT"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$STAGING" \
  -ov -format UDZO \
  "$DMG_OUT"

echo ""
echo "Built: $DMG_OUT"
