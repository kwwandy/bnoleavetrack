const path = require('path');
const http = require('http');
const fs = require('fs');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const PORT = 8746;
const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.png': 'image/png' };

function startServer() {
  const server = http.createServer((req, res) => {
    let urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = path.join(ROOT, urlPath);
    fs.readFile(filePath, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      const ext = path.extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)));
}

async function setupData(page) {
  await page.click('#btnNewProfile');
  await page.fill('#newProfileName', '阿明');
  await page.click('#newProfileConfirm');
  await page.waitForSelector('#tabPanels:not([hidden])');

  await page.click('.tab-btn[data-tab="milestones"]');
  await page.fill('#pfVisaGrantDate', '2021-02-19');
  await page.fill('#pfFirstArrivalDate', '2021-02-25');
  await page.click('#profileForm button[type="submit"]');
  await page.waitForTimeout(150);

  await page.click('.tab-btn[data-tab="trips"]');
  await page.fill('#tripDeparture', '2022-01-01');
  await page.fill('#tripReturn', '2022-08-01');
  await page.fill('#tripReason', '返香港探親');
  await page.click('#tripSubmitBtn');
  await page.waitForTimeout(150);
}

async function main() {
  const server = await startServer();
  const browser = await chromium.launch();

  // 桌面寬度
  const desktopCtx = await browser.newContext({ viewport: { width: 900, height: 1000 } });
  const desktopPage = await desktopCtx.newPage();
  await desktopPage.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await setupData(desktopPage);
  await desktopPage.screenshot({ path: path.join(__dirname, 'screenshot-desktop-trips.png') });
  await desktopPage.click('.tab-btn[data-tab="milestones"]');
  await desktopPage.waitForTimeout(150);
  await desktopPage.screenshot({ path: path.join(__dirname, 'screenshot-desktop-milestones.png') });

  // 手機寬度 (390px)
  const mobileCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const mobilePage = await mobileCtx.newPage();
  await mobilePage.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'networkidle' });
  await setupData(mobilePage);
  await mobilePage.screenshot({ path: path.join(__dirname, 'screenshot-mobile-trips.png'), fullPage: true });

  await browser.close();
  server.close();
  console.log('done');
}

main().catch((e) => { console.error(e); process.exit(1); });
