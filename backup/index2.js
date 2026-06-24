require('dotenv').config();

const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');

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

// ===== Express setup =====
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('BMS Alerts Bot is running!'));

// ===== Telegram bot setup (webhook) =====
const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${HOST_URL}/bot${BOT_TOKEN}`);
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== User sessions =====
const sessions = {};

// ===== Shared browser instance (reused across checks) =====
let sharedBrowser = null;

async function getBrowser() {
  if (sharedBrowser && sharedBrowser.isConnected()) return sharedBrowser;
  sharedBrowser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
    ],
    userDataDir: path.join(__dirname, 'profile'), // reuse cookies/session
  });
  return sharedBrowser;
}

// ===== Helper =====
async function sendMsg(chatId, message) {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

// Parse "06:15 AM" or "9:30 PM" → 24h integer hour
function parseShowTime(timeStr) {
  const match = timeStr && timeStr.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (!match) return null;
  let hour = parseInt(match[1], 10);
  const period = match[3].toUpperCase();
  if (period === 'PM' && hour !== 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return hour;
}

// Headers that can't be forwarded (browser-controlled or would conflict)
const BLOCKED_HEADERS = new Set([
  'host', 'content-length', 'connection',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest',
  'upgrade-insecure-requests',
]);

function sanitizeHeaders(raw) {
  return Object.fromEntries(
    Object.entries(raw).filter(([k]) => !BLOCKED_HEADERS.has(k.toLowerCase()))
  );
}

// ===== Core: open BMS page in browser, intercept live API call, replay it =====
async function fetchShowtimesViaBrowser(venueCode, regionCode, dateSlug) {
  const pageUrl = `https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue?appCode=MOBAND2&appVersion=14.3.4&language=en&venueCode=${venueCode}&regionCode=${regionCode}&bmsId=1.21.0&token=67x1xa33b4x422b361ba&lat=12.9716&lon=77.5946&dateCode=${dateSlug}`;

  // We load a real BMS cinema page so Cloudflare sees legitimate browser traffic,
  // then intercept the showtimes API call the page makes, and capture its auth headers.
  const bmsPageUrl = `https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/${venueCode}/${dateSlug}`;

  const browser = await getBrowser();
  const page = await browser.newPage();

  let capturedSession = null;

  try {
    await page.setExtraHTTPHeaders({ 'accept-language': 'en-IN,en;q=0.9' });
    await page.setViewport({ width: 1366, height: 768 });

    // Block heavy resources to speed up load
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      const url = req.url();

      // Intercept the showtimes API call to capture live headers & params
      if (url.includes('/api/v3/mobile/showtimes/byvenue')) {
        const parsed = new URL(url);
        capturedSession = {
          params: Object.fromEntries(parsed.searchParams.entries()),
          headers: sanitizeHeaders(req.headers()),
        };
      }

      if (['image', 'font', 'media'].includes(type)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    // Load the real BMS page — this triggers the showtimes API call
    console.log(`[BROWSER] Loading: ${bmsPageUrl}`);
    await page.goto(bmsPageUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Wait up to 10s for the API call to be intercepted
    const deadline = Date.now() + 10000;
    while (!capturedSession && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
    }

    if (!capturedSession) {
      // Fallback: try the API URL directly in-browser (avoids CF for API subdomain)
      console.log('[BROWSER] No session captured via page load, trying direct API fetch...');
      const result = await page.evaluate(async (url) => {
        try {
          const res = await fetch(url, { credentials: 'include' });
          const text = await res.text();
          return { ok: res.ok, status: res.status, body: text };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      }, pageUrl);

      if (result.ok) {
        return JSON.parse(result.body);
      }

      throw new Error('Could not capture BMS session or fetch data directly');
    }

    // Replay the captured API call with live headers (includes CF cookies/tokens)
    console.log('[BROWSER] Session captured, replaying API call...');
    const response = await axios.get('https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue', {
      params: capturedSession.params,
      headers: capturedSession.headers,
      timeout: 20000,
    });

    return response.data;

  } finally {
    await page.close().catch(() => {});
  }
}

// ===== Main check per user =====
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

    if (showDetails.length === 0) {
      console.log('[CHECK] No ShowDetails yet');
      return;
    }

    let movieFound = false;
    const matchedTimes = [];
    const availableTimes = [];

    for (const showDay of showDetails) {
      for (const event of (showDay?.Event || [])) {
        const title = (event?.EventTitle || '').trim();
        if (!title.toLowerCase().includes(movie.toLowerCase())) continue;

        movieFound = true;
        console.log(`[CHECK] Matched movie: "${title}"`);

        for (const child of (event?.ChildEvents || [])) {
          for (const st of (child?.ShowTimes || [])) {
            const timeStr = st?.ShowTime || '';
            if (!timeStr) continue;
            const hour = parseShowTime(timeStr);
            if (hour === null) continue;

            availableTimes.push(timeStr);
            if (ranges.some(({ from, to }) => hour >= from && hour <= to)) {
              matchedTimes.push(timeStr);
            }
          }
        }
      }
    }

    console.log(`[CHECK] found=${movieFound} available=[${availableTimes.join(', ')}] matched=[${matchedTimes.join(', ')}]`);

    if (movieFound && matchedTimes.length > 0) {
      const bookUrl = `https://in.bookmyshow.com/cinemas/${cityKey.replace(/\s+/g, '-')}/${theatreKey.replace(/\s+/g, '-')}/buytickets/${venueCode}/${dateSlug}`;
      await sendMsg(
        chatId,
        `🎬 <b>${movie}</b> is now bookable at <b>${theatre}</b>!\n` +
        `📅 Date: ${date}\n` +
        `🕐 Showtimes in your range: ${matchedTimes.join(', ')}\n` +
        `🔗 <a href="${bookUrl}">Book Now on BMS</a>`
      );
      clearInterval(session.interval);
      delete sessions[chatId];

    } else if (movieFound && availableTimes.length > 0) {
      console.log(`[CHECK] Movie up but not in range. Available: ${availableTimes.join(', ')}`);
    } else if (movieFound) {
      console.log(`[CHECK] Movie found but no showtimes listed yet`);
    } else {
      console.log(`[CHECK] "${movie}" not listed yet at "${venueCode}"`);
    }

  } catch (err) {
    console.error('[CHECK] Error:', err.message);
    if (err.response) {
      console.error('  Status:', err.response.status);
      console.error('  Data:', JSON.stringify(err.response.data).slice(0, 300));
    }
  }
}

// ===== Bot conversation flow =====
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'Friend';
  sessions[chatId] = { step: 1, firstName };
  sendMsg(chatId,
    `🎬 <b>Welcome to BookMyShow Alerts, ${firstName}!</b>\n\nI'll ping you the moment your show opens for booking.\n\nWhich <b>movie</b> would you like to track?`
  );
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || !msg.text || msg.text.startsWith('/')) return;

  session.firstName = msg.from?.first_name || session.firstName;

  switch (session.step) {
    case 1:
      session.movie = msg.text.trim();
      session.step = 2;
      sendMsg(chatId, `✅ Movie: <code>${session.movie}</code>\n\nWhich <b>city</b>? (e.g. Bengaluru, Mumbai)`);
      break;

    case 2:
      session.city = msg.text.trim();
      session.step = 3;
      sendMsg(chatId, `✅ City: <code>${session.city}</code>\n\nWhich <b>theatre</b>? (e.g. Sandhya, PVR Forum Mall)`);
      break;

    case 3:
      session.theatre = msg.text.trim();
      session.step = 4;
      sendMsg(chatId, `✅ Theatre: <code>${session.theatre}</code>\n\nWhat <b>date</b>? (format: YYYY-MM-DD)`);
      break;

    case 4:
      if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.text.trim())) {
        sendMsg(chatId, `⚠️ Invalid date format. Please use YYYY-MM-DD (e.g. 2026-07-15)`);
        break;
      }
      session.date = msg.text.trim();
      session.step = 5;
      sendMsg(chatId, `✅ Date: <code>${session.date}</code>\n\nWhat <b>time ranges</b> work for you?\n(e.g. <code>17-20,21-23</code> means 5–8 PM or 9–11 PM)`);
      break;

    case 5: {
      const parsed = msg.text.trim().split(',').map(r => {
        const [from, to] = r.trim().split('-').map(Number);
        return { from, to: isNaN(to) ? from : to };
      });
      if (parsed.some(r => isNaN(r.from))) {
        sendMsg(chatId, `⚠️ Invalid format. Try: <code>17-20,21-23</code>`);
        break;
      }
      session.ranges = parsed;
      session.step = 6;
      sendMsg(chatId, `✅ Time ranges set.\n\nFor how many <b>hours</b> should I keep checking? (e.g. <code>6</code>)`);
      break;
    }

    case 6: {
      const hours = parseInt(msg.text.trim());
      if (isNaN(hours) || hours <= 0) {
        sendMsg(chatId, `⚠️ Please enter a valid number of hours (e.g. 6)`);
        break;
      }

      const intervalMs = 3 * 60 * 1000; // check every 3 minutes
      const endTime = Date.now() + hours * 60 * 60 * 1000;
      const rangeStr = session.ranges.map(r => `${r.from}:00–${r.to}:00`).join(', ');

      await sendMsg(
        chatId,
        `🎯 <b>Tracking started!</b>\n\n` +
        `🎬 Movie: <b>${session.movie}</b>\n` +
        `🏛️ Theatre: <b>${session.theatre}</b>, ${session.city}\n` +
        `📅 Date: <b>${session.date}</b>\n` +
        `🕐 Time windows: <b>${rangeStr}</b>\n` +
        `⏱️ Checking every 3 min for ${hours} hour${hours > 1 ? 's' : ''}.`
      );

      // Immediate first check
      await checkShowForUser(chatId);

      if (sessions[chatId]) {
        session.interval = setInterval(async () => {
          if (Date.now() > endTime) {
            await sendMsg(chatId,
              `⏰ Time's up! No matching shows found for <b>${session.movie}</b>.\n\nUse /start to set a new alert.`
            );
            clearInterval(session.interval);
            delete sessions[chatId];
          } else {
            await checkShowForUser(chatId);
          }
        }, intervalMs);
      }

      session.step = 7;
      break;
    }
  }
});

// ===== Keep Render awake =====
setInterval(() => {
  axios.get(HOST_URL).catch(() => {});
}, 5 * 60 * 1000);

// ===== Start =====
app.listen(PORT, () => {
  console.log(`✅ BMS Alerts bot running on port ${PORT}`);
  console.log(`   Webhook: ${HOST_URL}/bot${BOT_TOKEN}`);
});
