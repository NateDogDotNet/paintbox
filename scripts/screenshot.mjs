#!/usr/bin/env node
// scripts/screenshot.mjs
// Re-runnable Playwright capture of miniPaint UI for the listing screenshot.
//
// Strategy: serve vendor/minipaint/ over HTTP on a free port, navigate Chromium
// to it, wait for miniPaint init, draw a programmatic gradient onto the canvas
// so the editor has interesting content, screenshot at 1280x800, save to
// images/screenshot.png. Falls back to plain miniPaint UI capture (no fixture
// load) per the design contract §screenshot OPEN ITEM if a fixture-loaded
// canvas can't be coaxed into the right state.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SERVE_DIR = path.join(ROOT, 'vendor', 'minipaint');
const OUT = path.join(ROOT, 'images', 'screenshot.png');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.json': 'application/json; charset=utf-8',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

function startServer() {
    const server = http.createServer((req, res) => {
        let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
        if (urlPath === '/') urlPath = '/index.html';
        const filePath = path.join(SERVE_DIR, urlPath);
        // basic traversal guard
        if (!filePath.startsWith(SERVE_DIR)) {
            res.writeHead(403); res.end('forbidden'); return;
        }
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404); res.end('not found'); return;
            }
            const ext = path.extname(filePath).toLowerCase();
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
            res.end(data);
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            resolve({ server, port: typeof addr === 'object' && addr ? addr.port : 0 });
        });
    });
}

async function main() {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const { server, port } = await startServer();
    console.log(`serving ${SERVE_DIR} on http://127.0.0.1:${port}`);

    let browser;
    try {
        browser = await chromium.launch({ headless: true });
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        page.on('console', (msg) => {
            if (msg.type() === 'error') console.log('[browser-error]', msg.text());
        });
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });

        // Poll for miniPaint init — same pattern as the webview shim.
        await page.waitForFunction(() => {
            return typeof window.FileOpen !== 'undefined'
                && typeof window.State !== 'undefined';
        }, { timeout: 30000 });

        // Draw a gradient onto the main canvas so the screenshot has visual interest.
        await page.evaluate(() => {
            const canvas = document.getElementById('canvas_minipaint');
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const w = canvas.width;
            const h = canvas.height;
            // diagonal gradient
            const grad = ctx.createLinearGradient(0, 0, w, h);
            grad.addColorStop(0, '#5b8def');
            grad.addColorStop(0.5, '#a06cd5');
            grad.addColorStop(1, '#ff6b9d');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
            // overlay some shapes for texture
            ctx.globalAlpha = 0.6;
            ctx.fillStyle = '#ffffff';
            for (let i = 0; i < 8; i++) {
                ctx.beginPath();
                ctx.arc(80 + i * 60, 60 + (i % 3) * 40, 18 + (i % 4) * 6, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.globalAlpha = 1.0;
            ctx.fillStyle = '#1a1a2e';
            ctx.font = 'bold 36px sans-serif';
            ctx.fillText('miniPaint', 24, h - 28);
        });

        // Give layout a beat to settle.
        await page.waitForTimeout(500);

        await page.screenshot({ path: OUT, fullPage: false });
        console.log(`wrote ${OUT}`);
    } finally {
        if (browser) await browser.close();
        await new Promise((r) => server.close(() => r(undefined)));
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
