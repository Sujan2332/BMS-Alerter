const axios = require('axios');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

const API_URL = 'https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue';

function parseShowTimes(text) {
  const regex = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
  const times = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    times.push(match[0]);
  }
  return [...new Set(times)];
}

function sanitizeHeaders(rawHeaders) {
  const blockedHeaders = new Set([
    'host',
    'content-length',
    'connection',
    'sec-fetch-site',
    'sec-fetch-mode',
    'sec-fetch-dest',
    'upgrade-insecure-requests'
  ]);

  return Object.fromEntries(
    Object.entries(rawHeaders).filter(([key]) => !blockedHeaders.has(key.toLowerCase()))
  );
}

async function captureLiveSession(pageUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  let session = null;

  try {
    const page = await browser.newPage();
    page.on('request', request => {
      const reqUrl = request.url();
      if (reqUrl.includes('/api/v3/mobile/showtimes/byvenue')) {
        const parsed = new URL(reqUrl);
        session = {
          params: Object.fromEntries(parsed.searchParams.entries()),
          headers: sanitizeHeaders(request.headers())
        };
      }
    });

    const waitForApiHit = page
      .waitForResponse(
        response => response.url().includes('/api/v3/mobile/showtimes/byvenue'),
        { timeout: 25000 }
      )
      .catch(() => null);

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 7000));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });

    await waitForApiHit;

    if (!session) {
      throw new Error('Could not capture live BMS API session from browser traffic.');
    }
    return session;
  } finally {
    await browser.close();
  }
}

async function getShowtimes(pageUrl) {
  try {
    const liveSession = await captureLiveSession(pageUrl);

    const response = await axios.get(API_URL, {
      params: liveSession.params,
      headers: liveSession.headers,
      timeout: 20000
    });

    console.log('Showtimes API call succeeded.');
    console.log(JSON.stringify(response.data, null, 2));
    return response.data;
  } catch (error) {
    console.error('Showtimes API call failed, switching to fallback scraper.');
    if (error.response) {
      console.error('Status:', error.response.status);
    } else {
      console.error('Error:', error.message);
    }

    return getShowtimesViaPage(pageUrl);
  }
}

async function getShowtimesViaPage(pageUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
  });

  try {
    const page = await browser.newPage();
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 7000));

    const pageText = await page.evaluate(() => document.body.innerText || '');
    const blocked = /blocked|cloudflare|captcha|just a moment|attention required/i.test(pageText);
    const showtimes = parseShowTimes(pageText);

    const fallbackResult = {
      source: 'fallback_page_scraper',
      blocked,
      showtimes
    };

    console.log('Fallback result:', JSON.stringify(fallbackResult, null, 2));
    return fallbackResult;
  } catch (err) {
    console.error('Fallback scraper failed:', err.message);
    return null;
  } finally {
    await browser.close();
  }
}

const pageUrl =
  process.env.BMS_PAGE_URL ||
  'https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/SATB/20260409';

getShowtimes(pageUrl);
