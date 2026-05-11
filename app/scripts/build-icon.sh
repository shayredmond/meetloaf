#!/usr/bin/env bash
# Rasterize icon.svg into a macOS .icns bundle.
# Uses rsvg-convert (librsvg) for SVG rendering — ImageMagick's native SVG
# renderer silently drops gradients and filters. librsvg is the de-facto
# standard for faithful SVG rasterization.
#
# Install:  brew install librsvg
set -euo pipefail

cd "$(dirname "$0")/.."

SVG="icon.svg"
ICONSET="icon.iconset"
OUT="icon.icns"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert not found. Install with: brew install librsvg" >&2
  exit 1
fi

if [[ ! -f "$SVG" ]]; then
  echo "Missing $SVG" >&2
  exit 1
fi

rm -rf "$ICONSET" "$OUT"
mkdir -p "$ICONSET"

declare -a SIZES=(
  "16:icon_16x16.png"
  "32:icon_16x16@2x.png"
  "32:icon_32x32.png"
  "64:icon_32x32@2x.png"
  "128:icon_128x128.png"
  "256:icon_128x128@2x.png"
  "256:icon_256x256.png"
  "512:icon_256x256@2x.png"
  "512:icon_512x512.png"
  "1024:icon_512x512@2x.png"
)

for pair in "${SIZES[@]}"; do
  size="${pair%%:*}"
  name="${pair##*:}"
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$ICONSET/$name"
done

iconutil -c icns "$ICONSET" -o "$OUT"
echo "Wrote $OUT"

# Tray icon: monochrome PNG for the macOS menu bar (16pt and 32pt @2x).
# Filename suffix "Template" is the macOS convention that auto-tints the
# image for light/dark appearance.
if [[ -f tray-icon.svg ]]; then
  rsvg-convert -w 22 -h 22 tray-icon.svg -o trayTemplate.png
  rsvg-convert -w 44 -h 44 tray-icon.svg -o trayTemplate@2x.png
  echo "Wrote trayTemplate.png + @2x"
fi
