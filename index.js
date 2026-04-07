const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// ===== CONFIG =====
const BOT_TOKEN = '8685438592:AAG-6incTzVBB85eXgu9KNT2t06m3dxlaUY';
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ===== User sessions =====
const sessions = {};

// ===== Helper Functions =====
async function sendTelegramMessage(chatId, message, firstName = '') {
  await bot.sendMessage(chatId, message, { parse_mode: 'HTML' });
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
  const matches = showtimes.filter(({ hour24 }) =>
    ranges.some(({ from, to }) => hour24 >= from && hour24 <= to)
  );
  return matches;
}

async function checkShowForUser(chatId) {
  const session = sessions[chatId];
  if (!session) return;

  const { movie, theatre, city, date, ranges, firstName } = session;
  const citySlug = city.toLowerCase()?.replace(/\s+/g, '-');
  const theatreSlug = theatre.toLowerCase()?.replace(/\s+/g, '-');
  const dateSlug = date?.replace(/-/g, '');

  const url = `https://in.bookmyshow.com/cinemas/${citySlug}/${theatreSlug}/buytickets/SATB/${dateSlug}`;

  try {
    console.log('Checking show for', { chatId, movie, city, theatre, date, ranges, url });
    const browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'accept-language': 'en-US,en;q=0.9',
      'dnt': '1'
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(resolve => setTimeout(resolve, 8000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    const matchedTimes = hasTargetShowtime(bodyText, ranges);
    const movieFound = bodyText.toLowerCase().includes(movie.toLowerCase());
    const blocked = /blocked|cloudflare|security service/i.test(bodyText);

    if (blocked) {
      const blockedMsg = `<b>🚫 Access Blocked</b>\n\nBookMyShow temporarily blocked our request.\n<i>This is likely a rate limit. Please try again in a few minutes.</i>`;
      await sendTelegramMessage(chatId, blockedMsg, firstName);
      return;
    }

    if (movieFound && matchedTimes.length > 0) {
      const successMsg = `<b>🎉 SHOW FOUND!</b>\n\n<b>${movie}</b>\n🎬 ${matchedTimes.map(t => `<code>${t.text}</code>`).join(', ')}\n\n📍 ${theatre}, ${city}\n📅 ${date}\n\n<i>Book now on BookMyShow!</i>`;
      await sendTelegramMessage(chatId, successMsg, firstName);
      clearInterval(session.interval);
      delete sessions[chatId];
    } else if (!movieFound) {
      console.log(`Movie not found on page: ${movie}`);
    } else if (matchedTimes.length === 0) {
      const allTimes = parseShowTimes(bodyText);
      if (allTimes.length > 0) {
        const rangeStr = ranges.map(r => r.from === r.to ? r.from : `${r.from}-${r.to}`).join(', ');
        const availableMsg = `<b>📽️ Movie Found!</b>\n\n<b>${movie}</b> is showing, but not in your preferred time range.\n\n⏰ <b>Your Range:</b> <code>${rangeStr}</code>\n\n✨ <b>Available Times:</b>\n${allTimes.map(t => `  • <code>${t.text}</code>`).join('\n')}\n\n<i>Checking again in 2 minutes...</i>`;
        await sendTelegramMessage(chatId, availableMsg, firstName);
      }
    }
  } catch (err) {
    console.error('Error in checkShowForUser:', err);
  }
}

// ===== Telegram Interaction =====
bot.onText(/\/start/, msg => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || 'Friend';
  sessions[chatId] = { step: 1, data: {}, firstName };
  const welcomeMsg = `<b>🎬 Welcome to BookMyShow Alerts, ${firstName}!</b>\n\nI'll help you track movie showtimes.\n\n<i>Let's get started...</i>\n\n<b>What movie would you like to track?</b>`;
  sendTelegramMessage(chatId, welcomeMsg, firstName);
});

bot.on('message', async msg => {
  const chatId = msg.chat.id;
  const firstName = msg.from.first_name || '';

  if (!sessions[chatId] || msg.text.startsWith('/start')) return;

  const session = sessions[chatId];
  session.firstName = firstName; // always keep user name

  switch (session.step) {
    case 1:
      session.movie = msg.text.trim();
      session.step = 2;
      const movieMsg = `<b>✅ Movie Selected:</b> <code>${session.movie}</code>\n\n<b>Now, which city?</b>\n<i>(e.g., Bengaluru, Mumbai, Delhi)</i>`;
      sendTelegramMessage(chatId, movieMsg, firstName);
      break;
    case 2:
      session.city = msg.text.trim();
      session.step = 3;
      const cityMsg = `<b>✅ City Selected:</b> <code>${session.city}</code>\n\n<b>Which theatre?</b>\n<i>(e.g., Sandhya Cinema, PVR, IMAX)</i>`;
      sendTelegramMessage(chatId, cityMsg, firstName);
      break;
    case 3:
      session.theatre = msg.text.trim();
      session.step = 4;
      const theatreMsg = `<b>✅ Theatre Selected:</b> <code>${session.theatre}</code>\n\n<b>What date?</b>\n<i>Format: YYYY-MM-DD (e.g., 2026-04-10)</i>`;
      sendTelegramMessage(chatId, theatreMsg, firstName);
      break;
    case 4:
      session.date = msg.text.trim();
      session.step = 5;
      const dateMsg = `<b>✅ Date Selected:</b> <code>${session.date}</code>\n\n<b>What time ranges?</b>\n<i>Format: 17-20,21-23 (24-hour)</i>\n<i>Examples:</i>\n  • <code>17-23</code> (5 PM - 11 PM)\n  • <code>9-12,17-23</code> (Morning & Evening)`;
      sendTelegramMessage(chatId, dateMsg, firstName);
      break;
    case 5:
      session.ranges = msg.text.split(',').map(r => {
        const parts = r.split('-').map(Number);
        if (parts.length === 1 || Number.isNaN(parts[1])) {
          return { from: parts[0], to: parts[0] };
        }
        return { from: parts[0], to: parts[1] };
      });
      session.step = 6;
      const rangesMsg = `<b>✅ Time Range Selected:</b> <code>${msg.text.trim()}</code>\n\n<b>How many hours should I check?</b>\n<i>(e.g., 1, 2, 6, 24)</i>`;
      sendTelegramMessage(chatId, rangesMsg, firstName);
      break;
    case 6:
      const hours = parseInt(msg.text.trim());
      const intervalMs = 2 * 60 * 1000; // 2 mins
      const endTime = Date.now() + hours * 60 * 60 * 1000;

      const startMsg = `<b>🎯 Tracking Started!</b>\n\n<b>Details:</b>\n🎬 <code>${session.movie}</code>\n🏨 <code>${session.theatre}, ${session.city}</code>\n📅 <code>${session.date}</code>\n⏰ <code>${session.ranges.map(r => r.from === r.to ? r.from : `${r.from}-${r.to}`).join(', ')}</code>\n\n⌛ Checking for ${hours} hour(s)...\n<i>I'll notify you when ${session.movie} is available in your time range!</i>`;
      sendTelegramMessage(chatId, startMsg, firstName);

      // RUN FIRST CHECK IMMEDIATELY
      await checkShowForUser(chatId);

      // START INTERVAL
      session.interval = setInterval(async () => {
        if (Date.now() > endTime) {
          const expiredMsg = `<b>⏰ Time's Up!</b>\n\n😔 No shows found for <code>${session.movie}</code> in your time range.\n\nTry /start to search again!`;
          await sendTelegramMessage(chatId, expiredMsg, firstName);
          clearInterval(session.interval);
          delete sessions[chatId];
        } else {
          try {
            await checkShowForUser(chatId);
          } catch (err) {
            console.error(err);
            const errorMsg = `<b>⚠️ Oops!</b>\n\nTemporary error checking shows. Retrying...`;
            await sendTelegramMessage(chatId, errorMsg, firstName);
          }
        }
      }, intervalMs);

      session.step = 7;
      break;
  }
});

// Add this at the bottom of your bot code
const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('Bot is running!');
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const axios = require('axios');
setInterval(() => {
  axios.get(`https://bms-alerter.onrender.com`).catch(() => { });
}, 5 * 60 * 1000); // every 5 minutes