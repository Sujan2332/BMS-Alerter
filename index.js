require('dotenv').config();

if (!process.env.PUPPETEER_CACHE_DIR) {
  process.env.PUPPETEER_CACHE_DIR = require('path').join(__dirname, '.cache', 'puppeteer');
}

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const puppeteerVanilla = require('puppeteer');
const CHROME_EXEC = puppeteerVanilla.executablePath();
if (!fs.existsSync(CHROME_EXEC)) {
  console.error('[CHROME] NOT FOUND at:', CHROME_EXEC);
  process.exit(1);
}
console.log('[CHROME] Found:', CHROME_EXEC);

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  throw new Error('BOT_TOKEN is not set. Please configure it in the environment or .env file.');
}
const PORT = process.env.PORT || 3000;
const HOST_URL = (process.env.HOST_URL || 'https://bms-alerter.onrender.com').replace(/\/$/, '');
const WEBHOOK_PATH = process.env.WEBHOOK_PATH || '/bot';
const WEBHOOK_URL = process.env.WEBHOOK_URL || `${HOST_URL}${WEBHOOK_PATH}`;

// Optional webhook settings. Add these in Render/your .env if you want to override defaults.
// WEBHOOK_PATH should usually be '/bot'
// WEBHOOK_URL should usually be your public Render URL, for example https://your-app.onrender.com/bot

const defaultCacheDir = path.join(__dirname, '.cache', 'puppeteer');
const envCacheDir = process.env.PUPPETEER_CACHE_DIR;
if (!envCacheDir || (process.platform === 'win32' && envCacheDir.includes('/opt/render/'))) {
  process.env.PUPPETEER_CACHE_DIR = defaultCacheDir;
} else {
  process.env.PUPPETEER_CACHE_DIR = envCacheDir;
}

const VENUE_MAP = { 'sandhya': 'SATB', 'pvr forum mall': 'PVRF', 'inox garuda': 'GNML', 'cinepolis': 'CPFM' };
const REGION_MAP = { 'bengaluru': 'BANG', 'bangalore': 'BANG', 'mumbai': 'MUMB', 'delhi': 'NDLS', 'hyderabad': 'HYD', 'chennai': 'CHEN', 'pune': 'PUNE' };

const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BMS Alerts Bot is running!'));

const bot = new TelegramBot(BOT_TOKEN, { polling: false });

async function setupWebhook() {
  try {
    await bot.setWebHook(`${WEBHOOK_URL}${BOT_TOKEN}`);
    console.log(`✅ Webhook set to ${WEBHOOK_URL}${BOT_TOKEN}`);
  } catch (err) {
    console.error('Webhook setup failed:', err.message);
    console.log('Falling back to polling mode');
    await bot.startPolling();
  }
}

app.post(`${WEBHOOK_PATH}${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

setupWebhook().catch(err => console.error('Setup error:', err.message));

const sessions = {};
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) {
    try { await sharedBrowser.version(); return sharedBrowser; } catch { sharedBrowser = null; }
  }
  sharedBrowser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_EXEC,
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage', '--disable-gpu', '--single-process',
    ],
    userDataDir: path.join(__dirname, 'profile'),
  });
  console.log('[BROWSER] Launched');
  return sharedBrowser;
}

async function sendMsg(chatId, text) {
  try { await bot.sendMessage(chatId, text, { parse_mode: 'HTML' }); }
  catch (e) { console.error('TG error:', e.message); }
}

function parseShowTime(timeStr) {
  const m = timeStr && timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return h;
}

const SKIP_HEADERS = new Set(['host','content-length','connection','sec-fetch-site','sec-fetch-mode','sec-fetch-dest','upgrade-insecure-requests']);

async function fetchShowtimesViaBrowser(venueCode, regionCode, dateSlug) {
  const bmsPageUrl = `https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/${venueCode}/${dateSlug}`;
  const apiPath = '/api/v3/mobile/showtimes/byvenue';
  const apiParams = new URLSearchParams({
    appCode: 'MOBAND2', appVersion: '14.3.4', language: 'en',
    venueCode, regionCode, bmsId: '1.21.0',
    token: '67x1xa33b4x422b361ba',
    lat: '12.9716', lon: '77.5946', dateCode: dateSlug,
  });
  const fullApiUrl = `https://in.bookmyshow.com${apiPath}?${apiParams}`;

  const browser = await getBrowser();
  const page = await browser.newPage();
  let intercepted = null;

  try {
    await page.setViewport({ width: 1366, height: 768 });
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-IN,en;q=0.9' });
    await page.setRequestInterception(true);

    page.on('request', req => {
      const url = req.url();
      if (url.includes(apiPath) && !intercepted) {
        intercepted = {
          params: Object.fromEntries(new URL(url).searchParams.entries()),
          headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))),
        };
        console.log('[BROWSER] API intercepted from page');
      }
      ['image', 'font', 'media'].includes(req.resourceType()) ? req.abort() : req.continue();
    });

    // Step 1: Load BMS homepage first to get CF clearance cookie
    console.log('[BROWSER] Loading BMS homepage for CF clearance...');
    await page.goto('https://in.bookmyshow.com/', { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[BROWSER] Homepage loaded');

    // Step 2: Navigate to the cinema page
    console.log('[BROWSER] Navigating to cinema page...');
    await page.goto(bmsPageUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    console.log('[BROWSER] Cinema page loaded');

    // Wait a bit more for any delayed API calls
    await new Promise(r => setTimeout(r, 3000));

    // Step 3: If we intercepted the API call, replay it with live headers
    if (intercepted) {
      console.log('[BROWSER] Replaying intercepted API call...');
      intercepted.params.venueCode = venueCode;
      intercepted.params.regionCode = regionCode;
      intercepted.params.dateCode = dateSlug;
      const res = await axios.get(`https://in.bookmyshow.com${apiPath}`, {
        params: intercepted.params,
        headers: intercepted.headers,
        timeout: 20000,
      });
      return res.data;
    }

    // Step 4: No interception — call the API directly from inside the browser
    // (the page already has CF cookies set, so fetch() from page context works)
    console.log('[BROWSER] No interception, trying in-page fetch...');
    const result = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, {
          credentials: 'include',
          headers: {
            'accept': 'application/json',
            'accept-language': 'en-IN,en;q=0.9',
            'x-region-code': 'BANG',
            'x-subregion-code': 'BANG',
          },
        });
        if (!res.ok) return { ok: false, status: res.status };
        return { ok: true, data: await res.json() };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }, fullApiUrl);

    if (result.ok) {
      console.log('[BROWSER] In-page fetch succeeded');
      return result.data;
    }

    throw new Error(`In-page fetch failed: status=${result.status} error=${result.error}`);

  } finally {
    await page.close().catch(() => {});
  }
}

async function checkShowForUser(chatId) {
  const session = sessions[chatId];
  if (!session) return;
  const { movie, theatre, city, date, ranges } = session;
  const dateSlug = date.replace(/-/g, '');
  const theatreKey = theatre.toLowerCase().trim();
  const cityKey = city.toLowerCase().trim();
  const venueCode = VENUE_MAP[theatreKey] || theatre.toUpperCase().replace(/\s+/g, '').slice(0, 6);
  const regionCode = REGION_MAP[cityKey] || city.toUpperCase().slice(0, 4);

  try {
    console.log(`[CHECK] movie="${movie}" venue="${venueCode}" region="${regionCode}" date="${dateSlug}"`);
    const data = await fetchShowtimesViaBrowser(venueCode, regionCode, dateSlug);
    const showDetails = data?.ShowDetails || [];
    if (!showDetails.length) { console.log('[CHECK] No ShowDetails yet'); return; }

    let movieFound = false;
    const matchedTimes = [], availableTimes = [];
    for (const showDay of showDetails) {
      for (const event of (showDay?.Event || [])) {
        const title = (event?.EventTitle || '').trim();
        if (!title.toLowerCase().includes(movie.toLowerCase())) continue;
        movieFound = true;
        for (const child of (event?.ChildEvents || [])) {
          for (const st of (child?.ShowTimes || [])) {
            const hour = parseShowTime(st?.ShowTime || '');
            if (hour === null) continue;
            availableTimes.push(st.ShowTime);
            if (ranges.some(({ from, to }) => hour >= from && hour <= to)) matchedTimes.push(st.ShowTime);
          }
        }
      }
    }

    console.log(`[CHECK] found=${movieFound} available=[${availableTimes.join(', ')}] matched=[${matchedTimes.join(', ')}]`);

    if (movieFound && matchedTimes.length > 0) {
      const bookUrl = `https://in.bookmyshow.com/cinemas/${cityKey.replace(/\s+/g, '-')}/${theatreKey.replace(/\s+/g, '-')}/buytickets/${venueCode}/${dateSlug}`;
      await sendMsg(chatId,
        `🎬 <b>${movie}</b> is now bookable at <b>${theatre}</b>!\n` +
        `📅 Date: ${date}\n🕐 Showtimes: ${matchedTimes.join(', ')}\n` +
        `🔗 <a href="${bookUrl}">Book Now on BMS</a>`
      );
      clearInterval(session.interval);
      delete sessions[chatId];
    } else if (movieFound && availableTimes.length) {
      console.log(`[CHECK] Not in range. Available: ${availableTimes.join(', ')}`);
    } else {
      console.log(`[CHECK] "${movie}" not listed yet at "${venueCode}"`);
    }
  } catch (err) {
    console.error('[CHECK] Error:', err.message);
  }
}

bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 1 };
  sendMsg(chatId, `🎬 <b>Welcome to BookMyShow Alerts!</b>\n\nWhich <b>movie</b> would you like to track?`);
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !msg.text || msg.text.startsWith('/')) return;
  switch (session.step) {
    case 1: session.movie = msg.text.trim(); session.step = 2; sendMsg(chatId, `✅ Movie: <code>${session.movie}</code>\n\nWhich <b>city</b>?`); break;
    case 2: session.city = msg.text.trim(); session.step = 3; sendMsg(chatId, `✅ City: <code>${session.city}</code>\n\nWhich <b>theatre</b>?`); break;
    case 3: session.theatre = msg.text.trim(); session.step = 4; sendMsg(chatId, `✅ Theatre: <code>${session.theatre}</code>\n\nWhat <b>date</b>? (YYYY-MM-DD)`); break;
    case 4:
      if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.text.trim())) { sendMsg(chatId, `⚠️ Use YYYY-MM-DD format`); break; }
      session.date = msg.text.trim(); session.step = 5;
      sendMsg(chatId, `✅ Date: <code>${session.date}</code>\n\nTime ranges? (e.g. <code>17-20,21-23</code>)`); break;
    case 5: {
      const parsed = msg.text.trim().split(',').map(r => { const [a,b] = r.trim().split('-').map(Number); return {from:a,to:isNaN(b)?a:b}; });
      if (parsed.some(r => isNaN(r.from))) { sendMsg(chatId, `⚠️ Try: <code>17-20,21-23</code>`); break; }
      session.ranges = parsed; session.step = 6;
      sendMsg(chatId, `✅ Ranges set.\n\nFor how many <b>hours</b>? (e.g. <code>6</code>)`); break;
    }
    case 6: {
      const hours = parseInt(msg.text.trim());
      if (isNaN(hours) || hours <= 0) { sendMsg(chatId, `⚠️ Enter a number like 6`); break; }
      const endTime = Date.now() + hours * 3600000;
      const rangeStr = session.ranges.map(r => `${r.from}:00–${r.to}:00`).join(', ');
      await sendMsg(chatId,
        `🎯 <b>Tracking started!</b>\n🎬 <b>${session.movie}</b> @ <b>${session.theatre}</b>, ${session.city}\n` +
        `📅 ${session.date} | 🕐 ${rangeStr}\n⏱️ Every 3 min for ${hours}h`
      );
      await checkShowForUser(chatId);
      if (sessions[chatId]) {
        session.interval = setInterval(async () => {
          if (Date.now() > endTime) {
            await sendMsg(chatId, `⏰ Time's up! No shows found. Use /start to try again.`);
            clearInterval(session.interval); delete sessions[chatId];
          } else { await checkShowForUser(chatId); }
        }, 3 * 60 * 1000);
      }
      session.step = 7; break;
    }
  }
});

setInterval(() => { axios.get(HOST_URL).catch(() => {}); }, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ BMS Alerts running on port ${PORT}`);
  console.log(`   Webhook: ${HOST_URL}/bot${BOT_TOKEN}`);
});
