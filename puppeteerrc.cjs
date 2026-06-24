const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Tell puppeteer to install Chrome here — same path we look at runtime
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};
