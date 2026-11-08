"use strict";
/* Génère build/icon.png (512) et build/icon.ico (16–256) : carré rouge agence, « ML » en gras blanc (charte AGOA). */
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const pngToIco = require("png-to-ico");

const RED = "#A31621";
const svg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="56" fill="${RED}"/>
  <text x="256" y="351" text-anchor="middle" font-family="DejaVu Sans, Segoe UI, Arial, sans-serif" font-weight="700" font-size="260" fill="#fff" letter-spacing="-6">ML</text>
</svg>`;

(async () => {
  const out = path.join(__dirname, "..", "build");
  fs.mkdirSync(out, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const bufs = [];
  for (const s of sizes) bufs.push(await sharp(Buffer.from(svg(s))).resize(s, s).png().toBuffer());
  fs.writeFileSync(path.join(out, "icon.png"), await sharp(Buffer.from(svg(512))).png().toBuffer());
  fs.writeFileSync(path.join(out, "icon.ico"), await pngToIco(bufs));
  console.log("icônes générées dans build/");
})().catch((e) => { console.error(e); process.exit(1); });
