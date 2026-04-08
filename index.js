const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const PORT = process.env.PORT || 3000;
const HOST_URL = process.env.HOST_URL || 'https://bms-alerter.onrender.com';

// ===== Express setup =====
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.send('Bot is running!'));

// ===== Telegram bot setup =====
const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${HOST_URL}/bot${BOT_TOKEN}`);

app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== User sessions =====
const sessions = {};

// ===== Helper Functions =====
async function sendTelegramMessage(chatId, message, firstName = '') {
  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
  } catch (err) {
    console.error('Telegram send error:', err);
  }
}

function parseShowTimes(text) {
  const regex = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
  const times = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    let hour = parseInt(match[1], 10);
    const period = match[3].toUpperCase();
    if (period === 'PM' && hour !== 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    times.push({ hour24: hour, text: match[0] });
  }
  return times;
}

function hasTargetShowtime(text, ranges) {
  const showtimes = parseShowTimes(text);
  return showtimes.filter(({ hour24 }) =>
    ranges.some(({ from, to }) => hour24 >= from && hour24 <= to)
  );
}

async function checkShowForUser(chatId) {
  const session = sessions[chatId];
  if (!session) return;

  const { movie, theatre, city, date, ranges, firstName } = session;
  const citySlug = city.toLowerCase().replace(/\s+/g, '-');
  const theatreSlug = theatre.toLowerCase().replace(/\s+/g, '-');
  const dateSlug = date.replace(/-/g, '');
  const url = `https://in.bookmyshow.com/cinemas/${citySlug}/${theatreSlug}/buytickets/SATB/${dateSlug}`;

  let browser;
  try {
    console.log('Checking show:', { chatId, movie, theatre, city, date, url });

    const { connect } = require('puppeteer-real-browser');

    const { browser: realBrowser, page } = await connect({
      headless: 'auto',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--single-process',
      ],
      customConfig: {},
      skipTarget: [],
      fingerprint: true,
      turnstile: true,
      connectOption: {},
    });

    browser = realBrowser;

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 10000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const matchedTimes = hasTargetShowtime(bodyText, ranges);
    const movieFound = bodyText.toLowerCase().includes(movie.toLowerCase());
    const blocked = /blocked|cloudflare|security service|just a moment|enable javascript/i.test(bodyText);

    console.log('Scrape result:', { movieFound, blocked, matchedTimes });
    console.log('Body preview:', bodyText.slice(0, 300));

    if (blocked) {
      console.log('Still blocked, retrying next interval...');
      return;
    }

    if (movieFound && matchedTimes.length > 0) {
      await sendTelegramMessage(
        chatId,
        `🎬 <b>${movie}</b> is now available!\nShowtimes: ${matchedTimes.map(t => t.text).join(', ')}\n🔗 <a href="${url}">Book Now</a>`,
        firstName
      );
      clearInterval(session.interval);
      delete sessions[chatId];
    } else if (!movieFound) {
      console.log(`Movie not listed yet: ${movie}`);
    } else {
      const allTimes = parseShowTimes(bodyText);
      if (allTimes.length > 0) {
        console.log(`No match in range. Available: ${allTimes.map(t => t.text).join(', ')}`);
      }
    }
  } catch (err) {
    console.error('Error checking show:', err.message);
    if (browser) await browser.close().catch(() => {});
  }
}

// ===== Telegram Interaction =====
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'Friend';
  sessions[chatId] = { step: 1, firstName };
  sendTelegramMessage(chatId, `<b>🎬 Welcome to BookMyShow Alerts, ${firstName}!</b>\nWhich movie would you like to track?`, firstName);
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const session = sessions[chatId];
  if (!session || msg.text.startsWith('/start')) return;

  session.firstName = msg.from.first_name || session.firstName;

  switch (session.step) {
    case 1:
      session.movie = msg.text.trim();
      session.step = 2;
      sendTelegramMessage(chatId, `✅ Movie: <code>${session.movie}</code>\nWhich city?`, session.firstName);
      break;
    case 2:
      session.city = msg.text.trim();
      session.step = 3;
      sendTelegramMessage(chatId, `✅ City: <code>${session.city}</code>\nWhich theatre?`, session.firstName);
      break;
    case 3:
      session.theatre = msg.text.trim();
      session.step = 4;
      sendTelegramMessage(chatId, `✅ Theatre: <code>${session.theatre}</code>\nWhat date? (YYYY-MM-DD)`, session.firstName);
      break;
    case 4:
      session.date = msg.text.trim();
      session.step = 5;
      sendTelegramMessage(chatId, `✅ Date: <code>${session.date}</code>\nTime ranges? (e.g., 17-20,21-23)`, session.firstName);
      break;
    case 5:
      session.ranges = msg.text.split(',').map(r => {
        const [from, to] = r.split('-').map(Number);
        return { from, to: to || from };
      });
      session.step = 6;
      sendTelegramMessage(chatId, `✅ Time range set. How many hours should I check?`, session.firstName);
      break;
    case 6:
      const hours = parseInt(msg.text.trim());
      const intervalMs = 2 * 60 * 1000;
      const endTime = Date.now() + hours * 60 * 60 * 1000;
      sendTelegramMessage(chatId, `🎯 Tracking started for ${hours} hours!`, session.firstName);

      await checkShowForUser(chatId);

      session.interval = setInterval(async () => {
        if (Date.now() > endTime) {
          await sendTelegramMessage(chatId, `⏰ Time's up! No shows found for <code>${session.movie}</code>.`, session.firstName);
          clearInterval(session.interval);
          delete sessions[chatId];
        } else {
          await checkShowForUser(chatId);
        }
      }, intervalMs);

      session.step = 7;
      break;
  }
});

// ===== Keep Render app awake =====
setInterval(() => {
  axios.get(HOST_URL).catch(() => {});
}, 5 * 60 * 1000);

// ===== Start Express server =====
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));