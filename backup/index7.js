require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

// ===== Chrome path — project-local cache (set via PUPPETEER_CACHE_DIR at build time) =====
// We install Chrome into .cache/puppeteer/ during the Render build step so it
// survives into the runtime container alongside the app code.
process.env.PUPPETEER_CACHE_DIR = path.join(__dirname, '.cache', 'puppeteer');

const puppeteerVanilla = require('puppeteer');
const CHROME_EXEC = puppeteerVanilla.executablePath();

if (!fs.existsSync(CHROME_EXEC)) {
  console.error('[CHROME] Not found at:', CHROME_EXEC);
  console.error('[CHROME] Make sure Render Build Command is:');
  console.error('         npm install && PUPPETEER_CACHE_DIR=.cache/puppeteer npx puppeteer browsers install chrome');
  // List what's actually in .cache so we can debug
  const cacheDir = path.join(__dirname, '.cache');
  if (fs.existsSync(cacheDir)) {
    console.error('[CHROME] .cache contents:', JSON.stringify(fs.readdirSync(cacheDir)));
    const pDir = path.join(cacheDir, 'puppeteer');
    if (fs.existsSync(pDir)) {
      console.error('[CHROME] .cache/puppeteer contents:', JSON.stringify(fs.readdirSync(pDir)));
    }
  } else {
    console.error('[CHROME] .cache dir does not exist — build step did not run');
  }
  process.exit(1);
}
console.log('[CHROME] Found:', CHROME_EXEC);

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUA = require('puppeteer-extra-plugin-anonymize-ua');
puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUA());

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || '8685438592:AAG-6incTzVBB85eXgu9KNT2t06m3dxlaUY';
const PORT = process.env.PORT || 3000;
const HOST_URL = (process.env.HOST_URL || 'https://bms-alerter.onrender.com').replace(/\/$/, '');

// ===== Venue & Region mapping =====
const VENUE_MAP = {
  'sandhya': 'SATB',
  'pvr forum mall': 'PVRF',
  'inox garuda': 'GNML',
  'cinepolis': 'CPFM',
};

const REGION_MAP = {
  'bengaluru': 'BANG',
  'bangalore': 'BANG',
  'mumbai': 'MUMB',
  'delhi': 'NDLS',
  'hyderabad': 'HYD',
  'chennai': 'CHEN',
  'pune': 'PUNE',
};

// ===== Express =====
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BMS Alerts Bot is running!'));

// ===== Telegram webhook =====
const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${HOST_URL}/bot${BOT_TOKEN}`);
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== Sessions =====
const sessions = {};

// ===== Shared browser =====
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser) {
    try { await sharedBrowser.version(); return sharedBrowser; }
    catch { sharedBrowser = null; }
  }
  sharedBrowser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_EXEC,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
    userDataDir: path.join(__dirname, 'profile'),
  });
  console.log('[BROWSER] Launched');
  return sharedBrowser;
}

// ===== Helpers =====
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

// ===== BMS fetch via browser =====
async function fetchShowtimesViaBrowser(venueCode, regionCode, dateSlug) {
  const bmsPageUrl = `https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/${venueCode}/${dateSlug}`;
  const apiPattern = '/api/v3/mobile/showtimes/byvenue';

  const browser = await getBrowser();
  const page = await browser.newPage();
  let captured = null;

  try {
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-IN,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });
    await page.setRequestInterception(true);

    page.on('request', req => {
      const url = req.url();
      if (url.includes(apiPattern) && !captured) {
        const parsed = new URL(url);
        captured = {
          params: Object.fromEntries(parsed.searchParams.entries()),
          headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => !SKIP_HEADERS.has(k.toLowerCase()))),
        };
        console.log('[BROWSER] API intercepted');
      }
      ['image','font','media'].includes(req.resourceType()) ? req.abort() : req.continue();
    });

    console.log('[BROWSER] Loading:', bmsPageUrl);
    await page.goto(bmsPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const deadline = Date.now() + 12000;
    while (!captured && Date.now() < deadline) await new Promise(r => setTimeout(r, 400));

    if (!captured) throw new Error('BMS API call not intercepted — Cloudflare may have blocked page load');

    captured.params.venueCode = venueCode;
    captured.params.regionCode = regionCode;
    captured.params.dateCode = dateSlug;

    const res = await axios.get('https://in.bookmyshow.com' + apiPattern, {
      params: captured.params,
      headers: captured.headers,
      timeout: 20000,
    });
    return res.data;

  } finally {
    await page.close().catch(() => {});
  }
}

// ===== Check show =====
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
            const timeStr = st?.ShowTime || '';
            const hour = parseShowTime(timeStr);
            if (hour === null) continue;
            availableTimes.push(timeStr);
            if (ranges.some(({ from, to }) => hour >= from && hour <= to)) matchedTimes.push(timeStr);
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
    } else if (movieFound) {
      console.log('[CHECK] Movie found, no showtimes yet');
    } else {
      console.log(`[CHECK] "${movie}" not listed yet at "${venueCode}"`);
    }
  } catch (err) {
    console.error('[CHECK] Error:', err.message);
    if (err.response) console.error('  Status:', err.response.status, JSON.stringify(err.response.data).slice(0, 200));
  }
}

// ===== Bot flow =====
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  sessions[chatId] = { step: 1, firstName: msg.from?.first_name || 'Friend' };
  sendMsg(chatId, `🎬 <b>Welcome to BookMyShow Alerts!</b>\n\nWhich <b>movie</b> would you like to track?`);
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !msg.text || msg.text.startsWith('/')) return;

  switch (session.step) {
    case 1:
      session.movie = msg.text.trim(); session.step = 2;
      sendMsg(chatId, `✅ Movie: <code>${session.movie}</code>\n\nWhich <b>city</b>? (e.g. Bengaluru)`);
      break;
    case 2:
      session.city = msg.text.trim(); session.step = 3;
      sendMsg(chatId, `✅ City: <code>${session.city}</code>\n\nWhich <b>theatre</b>? (e.g. Sandhya)`);
      break;
    case 3:
      session.theatre = msg.text.trim(); session.step = 4;
      sendMsg(chatId, `✅ Theatre: <code>${session.theatre}</code>\n\nWhat <b>date</b>? (YYYY-MM-DD)`);
      break;
    case 4:
      if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.text.trim())) {
        sendMsg(chatId, `⚠️ Use YYYY-MM-DD format (e.g. 2026-07-15)`); break;
      }
      session.date = msg.text.trim(); session.step = 5;
      sendMsg(chatId, `✅ Date: <code>${session.date}</code>\n\nTime ranges? (e.g. <code>17-20,21-23</code>)`);
      break;
    case 5: {
      const parsed = msg.text.trim().split(',').map(r => {
        const [from, to] = r.trim().split('-').map(Number);
        return { from, to: isNaN(to) ? from : to };
      });
      if (parsed.some(r => isNaN(r.from))) { sendMsg(chatId, `⚠️ Try: <code>17-20,21-23</code>`); break; }
      session.ranges = parsed; session.step = 6;
      sendMsg(chatId, `✅ Time ranges set.\n\nFor how many <b>hours</b> should I check? (e.g. <code>6</code>)`);
      break;
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
            await sendMsg(chatId, `⏰ Time's up! No shows found for <b>${session.movie}</b>. Use /start to try again.`);
            clearInterval(session.interval); delete sessions[chatId];
          } else {
            await checkShowForUser(chatId);
          }
        }, 3 * 60 * 1000);
      }
      session.step = 7;
      break;
    }
  }
});

setInterval(() => { axios.get(HOST_URL).catch(() => {}); }, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`✅ BMS Alerts running on port ${PORT}`);
  console.log(`   Webhook: ${HOST_URL}/bot${BOT_TOKEN}`);
});
