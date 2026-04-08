const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { HttpsProxyAgent } = require('https-proxy-agent');

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const PORT = process.env.PORT || 3000;
const HOST_URL = process.env.HOST_URL || 'https://bms-alerter.onrender.com';
const PROXY_URL = process.env.PROXY_URL || 'http://USERNAME:PASSWORD@proxy.webshare.io:80';

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

async function checkShowForUser(chatId) {
  const session = sessions[chatId];
  if (!session) return;

  const { movie, theatre, city, date, ranges, firstName } = session;
  const proxyAgent = new HttpsProxyAgent(PROXY_URL);
  const dateSlug = date.replace(/-/g, '');

  // Try direct quickbook API — this is what BMS website uses
  const url = `https://in.bookmyshow.com/api/movies-data/showtimes-by-event?appCode=MOBAND2&appVersion=14.3.4&language=en&eventCode=SATB&regionCode=${city.toUpperCase()}&subRegion=${city.toUpperCase()}&bmsId=1.21.0&token=67x1xa33b4x422b361ba&dateCode=${dateSlug}`;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Mobile Safari/537.36',
    'Accept': 'application/json',
    'Accept-Language': 'en-IN,en;q=0.9',
    'Referer': 'https://in.bookmyshow.com/',
    'x-bms-id': 'in.bms.web',
    'x-region-code': city.toUpperCase(),
    'x-region-slug': city.toLowerCase(),
    'x-subregion-code': city.toUpperCase(),
    'x-bms-sessionid': Math.random().toString(36).substring(2),
  };

  try {
    console.log('Checking show:', { chatId, movie, theatre, city, date });

    const response = await axios.get(url, {
      headers,
      httpsAgent: proxyAgent,
      timeout: 15000,
    });

    console.log('Raw response:', JSON.stringify(response.data).slice(0, 1000));

    const showDetails = response.data?.ShowDetails || [];

    if (showDetails.length === 0) {
      console.log('No shows found yet');
      return;
    }

    let allMatchedTimes = [];
    let movieFound = false;
    let allAvailableTimes = [];

    for (const show of showDetails) {
      // Check venue name matches
      const venueName = (show.VenueName || '').toLowerCase();
      const venueCode = (show.VenueCode || '').toLowerCase();
      const theatreLower = theatre.toLowerCase();

      if (!venueName.includes(theatreLower) && !venueCode.includes(theatreLower)) {
        continue; // skip other theatres
      }

      console.log('Matched theatre:', show.VenueName);

      const events = show.Event || [];
      for (const event of events) {
        const title = event.EventTitle || '';
        if (title.toLowerCase().includes(movie.toLowerCase())) {
          movieFound = true;
          const childEvents = event.ChildEvents || [];
          for (const child of childEvents) {
            const showTime = child.EventShowTime || child.ShowTime || '';
            console.log(`Showtime found: ${showTime}`);
            const times = parseShowTimes(showTime);
            allAvailableTimes.push(...times);
            const matched = times.filter(({ hour24 }) =>
              ranges.some(({ from, to }) => hour24 >= from && hour24 <= to)
            );
            allMatchedTimes.push(...matched);
          }
        }
      }
    }

    console.log('Result:', { movieFound, allAvailableTimes, allMatchedTimes });

    if (movieFound && allMatchedTimes.length > 0) {
      const bookUrl = `https://in.bookmyshow.com/cinemas/${city.toLowerCase()}/${theatre.toLowerCase()}/buytickets/SATB/${dateSlug}`;
      await sendTelegramMessage(
        chatId,
        `🎬 <b>${movie}</b> is now available!\nShowtimes: ${allMatchedTimes.map(t => t.text).join(', ')}\n🔗 <a href="${bookUrl}">Book Now</a>`,
        firstName
      );
      clearInterval(session.interval);
      delete sessions[chatId];
    } else if (movieFound && allAvailableTimes.length > 0) {
      console.log(`Movie found but not in range. Available: ${allAvailableTimes.map(t => t.text).join(', ')}`);
    } else if (!movieFound) {
      console.log(`Movie "${movie}" not listed yet at "${theatre}"`);
    }

  } catch (err) {
    console.error('Error checking show:', err.message);
    if (err.response) {
      console.error('API response status:', err.response.status);
      console.error('API response data:', JSON.stringify(err.response.data).slice(0, 300));
    }
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