const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const chromium = require('@sparticuz/chromium');

// At the top of your file after imports
const fs = require('fs');
['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome'].forEach(p => {
  console.log(`${p} exists:`, fs.existsSync(p));
});
puppeteer.use(StealthPlugin());

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || '8685438592:AAG-6incTzVBB85eXgu9KNT2t06m3dxlaUY';
const PORT = process.env.PORT || 3000;
const HOST_URL = process.env.HOST_URL || 'https://bms-alerter.onrender.com'; // Render app URL

// ===== Express setup =====
const app = express();
app.use(express.json());

// Keep alive route
app.get('/', (req, res) => res.send('Bot is running!'));

// ===== Telegram bot setup using Webhook =====
const bot = new TelegramBot(BOT_TOKEN);
bot.setWebHook(`${HOST_URL}/bot${BOT_TOKEN}`);

// Telegram webhook endpoint
app.post(`/bot${BOT_TOKEN}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// ===== User sessions =====
const sessions = {};


// async function launchBrowser() {
//   try {
//     const executablePath = await puppeteer.executablePath();
//     console.log('Puppeteer executable path:', executablePath);

//     const browser = await puppeteer.launch({
//       headless: true,
//       executablePath,
//     });

//     console.log('Browser launched!');
//     await browser.close();
//   } catch (error) {
//     console.error('Error launching browser:', error);
//   }
// }

// launchBrowser();

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
    const minute = parseInt(match[2], 10);
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

  try {
    console.log('Checking show:', { chatId, movie, theatre, city, date, url });

    const executablePath = await chromium.executablePath();
    console.log('Chrome path:', executablePath);

    const browser = await puppeteer.launch({
      headless: chromium.headless,
      executablePath,
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'dnt': '1',
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 8000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const matchedTimes = hasTargetShowtime(bodyText, ranges);
    const movieFound = bodyText.toLowerCase().includes(movie.toLowerCase());
    const blocked = /blocked|cloudflare|security service/i.test(bodyText);

    console.log('Scrape result:', { movieFound, blocked, matchedTimes });

    if (blocked) {
      await sendTelegramMessage(chatId, '⚠️ BookMyShow blocked the request. Retrying later...', firstName);
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
        console.log(`Movie found but no match in range. Available: ${allTimes.map(t => t.text).join(', ')}`);
      }
    }
  } catch (err) {
    console.error('Error checking show:', err.message);
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
  axios.get(HOST_URL).catch(() => { });
}, 5 * 60 * 1000);

// ===== Start Express server =====
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
