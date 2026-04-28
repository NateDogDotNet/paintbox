#!/usr/bin/env node
// Build images/icon.png — 128x128 with transparent background.
// Source: vendor/minipaint/images/logo-colors.png (128x123).
// Strategy: top-pad 3px, bottom-pad 2px to center vertically.

const path = require('path');
const sharp = require('sharp');

const SRC = path.resolve(__dirname, '..', 'vendor', 'minipaint', 'images', 'logo-colors.png');
const OUT = path.resolve(__dirname, '..', 'images', 'icon.png');

(async () => {
    const meta = await sharp(SRC).metadata();
    if (meta.width !== 128 || meta.height !== 123) {
        console.error(`unexpected source dimensions ${meta.width}x${meta.height}, expected 128x123`);
        process.exit(1);
    }
    await sharp(SRC)
        .ensureAlpha()
        .extend({
            top: 3,
            bottom: 2,
            left: 0,
            right: 0,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toFile(OUT);
    const outMeta = await sharp(OUT).metadata();
    console.log(`wrote ${OUT} ${outMeta.width}x${outMeta.height} alpha=${outMeta.hasAlpha}`);
})().catch((err) => {
    console.error(err);
    process.exit(1);
});
