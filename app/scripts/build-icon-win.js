#!/usr/bin/env node
// Rasterize icon.svg into the PNGs Windows builds need. The macOS pipeline
// (build-icon.sh) relies on rsvg-convert + iconutil, neither of which exists
// on a stock Windows machine, so this uses resvg's prebuilt Node binding —
// same Rust SVG renderer family, faithful gradients/filters, no system deps.
//
//   icon.png          512px — window icon, and electron-builder converts it
//                     to the installer/exe .ico itself (needs >= 256px)
//   tray.png          32px  — notification-area icon (full colour: Windows
//   tray@2x.png       64px    doesn't tint "Template" images like macOS)
//
// Usage:  node scripts/build-icon-win.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'icon.svg'));

const OUTPUTS = [
  [512, 'icon.png'],
  [32, 'tray.png'],
  [64, 'tray@2x.png']
];

for (const [size, name] of OUTPUTS) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();
  fs.writeFileSync(path.join(root, name), png);
  console.log(`Wrote ${name} (${size}px)`);
}
