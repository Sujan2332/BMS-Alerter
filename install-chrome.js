// Run at startup if Chrome is missing
const { execSync } = require('child_process');
const fs = require('fs');

const puppeteerVanilla = require('puppeteer');
const chromePath = puppeteerVanilla.executablePath();

if (!fs.existsSync(chromePath)) {
  console.log('[CHROME] Not found at:', chromePath);
  console.log('[CHROME] Installing now...');
  try {
    execSync('npx puppeteer browsers install chrome', {
      stdio: 'inherit',
      timeout: 120000,
    });
    console.log('[CHROME] Install complete');
  } catch (e) {
    console.error('[CHROME] Install failed:', e.message);
    process.exit(1);
  }
} else {
  console.log('[CHROME] Already installed:', chromePath);
}
