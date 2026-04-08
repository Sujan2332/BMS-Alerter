const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
// const chromium = require('@sparticuz/chromium');

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

  try {
    const response = await axios.get(
      `https://in.bookmyshow.com/api/movies-data/showtimes-by-event`, {
      params: {
        appCode: 'MOBAND2',
        appVersion: '14.3.4',
        language: 'en',
        eventCode: 'SATB',
        regionCode: city.toUpperCase(),
        subRegion: city.toUpperCase(),
        bmsId: '1.21.0',
        token: '67x1xa33b4x422b361ba',
        lat: '12.9716',
        lon: '77.5946',
      },
      headers: {
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 13)',
        'x-region-code': city.toUpperCase(),
        'x-subregion-code': city.toUpperCase(),
      }
    });

    const bodyText = JSON.stringify(response.data);
    const movieFound = bodyText.toLowerCase().includes(movie.toLowerCase());

    console.log('API result:', { movieFound });
    console.log('Preview:', bodyText.slice(0, 500));

    // rest of your matching logic...

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
  axios.get(HOST_URL).catch(() => {});
}, 5 * 60 * 1000);

// ===== Start Express server =====
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));