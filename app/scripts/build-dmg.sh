#!/usr/bin/env bash
# Build MeetLoaf.app (arm64, unsigned), ad-hoc sign it, and package a DMG.
# Ad-hoc signing is enough to satisfy macOS's "must be signed" rule on Apple Silicon,
# but colleagues will still see a Gatekeeper prompt on first launch (documented in README).
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="MeetLoaf"
DIST_DIR="dist"
APP_DIR="$DIST_DIR/mac-arm64/$APP_NAME.app"
DMG_OUT="$DIST_DIR/$APP_NAME-$(node -p "require('./package.json').version").dmg"

# 1. Build icon if missing
if [[ ! -f icon.icns ]]; then
  ./scripts/build-icon.sh
fi

# 2. Build unsigned .app via electron-builder
rm -rf "$DIST_DIR"
npx electron-builder --mac --arm64

if [[ ! -d "$APP_DIR" ]]; then
  echo "Expected build at $APP_DIR not found" >&2
  exit 1
fi

# 3. Ad-hoc sign (the "-" identity) so Gatekeeper will at least launch it
codesign --force --deep --sign - "$APP_DIR"
codesign --verify --deep "$APP_DIR"

# 4. Package into a DMG
rm -f "$DMG_OUT"
hdiutil create \
  -volname "$APP_NAME" \
  -srcfolder "$APP_DIR" \
  -ov -format UDZO \
  "$DMG_OUT"

echo ""
echo "Built: $DMG_OUT"
