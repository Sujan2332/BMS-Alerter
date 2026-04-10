const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN || '8685438592:AAG-6incTzVBB85eXgu9KNT2t06m3dxlaUY';
const PORT = process.env.PORT || 3000;
const HOST_URL = process.env.HOST_URL || 'https://bms-alerter.onrender.com';

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
    console.error('Telegram send error:', err.message);
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
  const dateSlug = date.replace(/-/g, '');

  const theatreKey = theatre.toLowerCase().trim();
  const cityKey = city.toLowerCase().trim();
  const venueCode = VENUE_MAP[theatreKey] || theatre.toUpperCase();
  const regionCode = REGION_MAP[cityKey] || city.toUpperCase();
  const regionSlug = cityKey.replace(/\s+/g, '-');

  try {
    console.log('Checking show:', { movie, theatre, venueCode, regionCode, dateSlug });

    const response = await axios.get(
      'https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue',
      {
        params: {
          dateCode: dateSlug,
          venueCode: venueCode,
          regionCode: regionCode,
          memberId: '',
          bmsId: '1.691911006.1775546869766',
          appCode: 'WEBV2',
          token: '26x3aab5x746514b3b7b',
          lsId: '',
        },
        headers: {
          'accept': 'application/json, text/plain, */*',
          'accept-language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
          'dnt': '1',
          'referer': `https://in.bookmyshow.com/cinemas/${regionSlug}/${theatreKey.replace(/\s+/g, '-')}/buytickets/${venueCode}/${dateSlug}`,
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"',
          'x-advertiser-id': '1329806217061819502',
          'x-app-code': 'WEB',
          'x-bms-id': process.env.BMS_ID || '1.632209197.1775801434584',
          'x-geohash': 'tdr',
          'x-latitude': '12.971599',
          'x-location-selection': 'manual',
          'x-longitude': '77.594563',
          'x-platform': 'WEB',
          'x-platform-code': 'WEB',
          'x-region-code': regionCode,
          'x-region-slug': regionSlug,
          'x-segments': '',
        },
        timeout: 15000,
      }
    );

    const data = response.data;
    console.log('Response keys:', Object.keys(data));
    console.log('Raw:', JSON.stringify(data).slice(0, 2000));

    const showDetails = data?.ShowDetails || data?.showDetails || [];

    if (showDetails.length === 0) {
      console.log('ShowDetails empty');
      console.log('Full response:', JSON.stringify(data, null, 2));
      return;
    }

    let movieFound = false;
    let allMatchedTimes = [];
    let allAvailableTimes = [];

    for (const show of showDetails) {
      const events = show?.Event || show?.events || [];
      for (const event of events) {
        const title = event?.EventTitle || event?.eventTitle || '';
        if (!title.toLowerCase().includes(movie.toLowerCase())) continue;

        movieFound = true;
        console.log('Matched movie:', title);

        const childEvents = event?.ChildEvents || event?.childEvents || [];
        for (const child of childEvents) {
          const showTime = child?.EventShowTime || child?.showTime || child?.ShowTime || '';
          if (!showTime) continue;

          const times = parseShowTimes(showTime);
          allAvailableTimes.push(...times);

          const matched = times.filter(({ hour24 }) =>
            ranges.some(({ from, to }) => hour24 >= from && hour24 <= to)
          );
          allMatchedTimes.push(...matched);
          console.log(`Showtime: ${showTime} — in range: ${matched.length > 0}`);
        }
      }
    }

    console.log('Final result:', {
      movieFound,
      available: allAvailableTimes.map(t => t.text),
      matched: allMatchedTimes.map(t => t.text),
    });

    if (movieFound && allMatchedTimes.length > 0) {
      const bookUrl = `https://in.bookmyshow.com/cinemas/${regionSlug}/${theatreKey.replace(/\s+/g, '-')}/buytickets/${venueCode}/${dateSlug}`;
      await sendTelegramMessage(
        chatId,
        `🎬 <b>${movie}</b> is now available at <b>${theatre}</b>!\n` +
        `📅 Date: ${date}\n` +
        `🕐 Showtimes: ${allMatchedTimes.map(t => t.text).join(', ')}\n` +
        `🔗 <a href="${bookUrl}">Book Now</a>`,
        firstName
      );
      clearInterval(session.interval);
      delete sessions[chatId];
    } else if (movieFound) {
      console.log(`Movie found but not in range. Available: ${allAvailableTimes.map(t => t.text).join(', ')}`);
    } else {
      console.log(`Movie "${movie}" not listed yet at "${theatre}"`);
    }

  } catch (err) {
    console.error('Error checking show:', err.message);
    if (err.response) {
      console.error('Status:', err.response.status);
      console.error('Data:', JSON.stringify(err.response.data).slice(0, 500));
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