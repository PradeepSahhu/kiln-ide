// Renders the app icon - the Welcome screen's "K" tile (orange -> pink -> purple gradient) - with
// Electron, so it matches the app exactly, and writes resources/icon.png (1024 px) and, on macOS,
// resources/icon.icns (with iconutil).
//
//   npx electron scripts/make-icon.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { app, BrowserWindow } = require('electron');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'resources');
const FONT = path.join(ROOT, 'node_modules', '@fontsource', 'inter', 'files', 'inter-latin-800-normal.woff2');

// macOS icon grid: an 824 px rounded square centered on a 1024 px canvas, with a soft shadow.
const html = `<!doctype html><html><head><style>
@font-face { font-family: Inter; font-weight: 800; src: url("data:font/woff2;base64,${fs.readFileSync(FONT).toString('base64')}") format("woff2"); }
html, body { margin: 0; width: 1024px; height: 1024px; background: transparent; overflow: hidden; }
.tile { position: absolute; left: 100px; top: 92px; width: 824px; height: 824px; border-radius: 185px;
  background: linear-gradient(135deg, #FF7A3D, #E5375B 55%, #8E5BD8);
  box-shadow: 0 18px 36px rgba(0, 0, 0, .28), inset 0 2px 0 rgba(255, 255, 255, .18);
  display: grid; place-items: center; }
.k { font-family: Inter; font-weight: 800; font-size: 440px; line-height: 1; color: #fff; transform: translateY(-8px);
  text-shadow: 0 8px 24px rgba(80, 0, 40, .25); }
</style></head><body><div class="tile"><div class="k">K</div></div></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, frame: false, transparent: true, useContentSize: true, webPreferences: { offscreen: true } });
  win.webContents.setZoomFactor(1);
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const loaded = await win.webContents.executeJavaScript('document.fonts.load("800 440px Inter").then((f) => f.length > 0)');
  if (!loaded) throw new Error('Inter did not load');
  await new Promise((r) => setTimeout(r, 300));
  let image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  if (image.getSize().width !== 1024) image = image.resize({ width: 1024, height: 1024, quality: 'best' });
  fs.mkdirSync(OUT, { recursive: true });
  const png = path.join(OUT, 'icon.png');
  fs.writeFileSync(png, image.toPNG());
  console.log(`wrote ${path.relative(ROOT, png)}`);
  if (process.platform === 'darwin') {
    const set = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kiln-icon-')), 'icon.iconset');
    fs.mkdirSync(set);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = size * scale;
        const name = `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`;
        fs.writeFileSync(path.join(set, name), image.resize({ width: px, height: px, quality: 'best' }).toPNG());
      }
    }
    const icns = path.join(OUT, 'icon.icns');
    execFileSync('iconutil', ['-c', 'icns', set, '-o', icns]);
    fs.rmSync(path.dirname(set), { recursive: true, force: true });
    console.log(`wrote ${path.relative(ROOT, icns)}`);
  }
  app.quit();
});
