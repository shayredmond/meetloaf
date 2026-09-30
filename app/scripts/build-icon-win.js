#!/usr/bin/env node
// Rasterize icon.svg into the icons Windows builds need. The macOS pipeline
// (build-icon.sh) relies on rsvg-convert + iconutil, neither of which exists
// on a stock Windows machine, so this uses resvg's prebuilt Node binding —
// same Rust SVG renderer family, faithful gradients/filters, no system deps.
//
//   icon.ico          16–256px multi-resolution — installer, exe, taskbar and
//                     Explorer. Each size is rendered from the SVG rather than
//                     downscaled, so the small ones stay crisp.
//   icon.png          512px — BrowserWindow icon
//   tray.png          32px  — notification-area icon (full colour: Windows
//   tray@2x.png       64px    doesn't tint "Template" images like macOS)
//
// Usage:  node scripts/build-icon-win.js
const fs = require('fs');
const path = require('path');
const { Resvg } = require('@resvg/resvg-js');

const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'icon.svg'));

const render = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng();

const PNGS = [
  [512, 'icon.png'],
  [32, 'tray.png'],
  [64, 'tray@2x.png']
];

for (const [size, name] of PNGS) {
  fs.writeFileSync(path.join(root, name), render(size));
  console.log(`Wrote ${name} (${size}px)`);
}

// ICO container with PNG-compressed entries (supported since Windows Vista).
// Layout: 6-byte ICONDIR, one 16-byte ICONDIRENTRY per image, then the data.
const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const images = ICO_SIZES.map(render);
const header = Buffer.alloc(6 + 16 * images.length);
header.writeUInt16LE(0, 0);             // reserved
header.writeUInt16LE(1, 2);             // type: icon
header.writeUInt16LE(images.length, 4);
let offset = header.length;
images.forEach((png, i) => {
  const size = ICO_SIZES[i];
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e);     // width (0 means 256)
  header.writeUInt8(size >= 256 ? 0 : size, e + 1); // height
  header.writeUInt8(0, e + 2);                      // palette colours
  header.writeUInt8(0, e + 3);                      // reserved
  header.writeUInt16LE(1, e + 4);                   // colour planes
  header.writeUInt16LE(32, e + 6);                  // bits per pixel
  header.writeUInt32LE(png.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
fs.writeFileSync(path.join(root, 'icon.ico'), Buffer.concat([header, ...images]));
console.log(`Wrote icon.ico (${ICO_SIZES.join(', ')}px)`);
