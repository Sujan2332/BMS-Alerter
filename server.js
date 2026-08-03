require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const puppeteer = require('puppeteer-extra');

const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const AnonymizeUAPlugin = require('puppeteer-extra-plugin-anonymize-ua');

puppeteer.use(StealthPlugin());
puppeteer.use(AnonymizeUAPlugin());

// ===== CONFIG =====
const BOT_TOKEN = process.env.BOT_TOKEN;
const PROXY = process.env.PROXY;

const bot = new TelegramBot(BOT_TOKEN, {
    polling: { interval: 300, autoStart: true }
});

// ===== MEMORY =====
const sessions = {};
const jobs = {};
let browser;

// ===== UTIL =====
const delay = (min = 2000, max = 5000) =>
    new Promise(r => setTimeout(r, Math.random() * (max - min) + min));

// ===== SAFE MESSAGE =====
async function sendTelegramMessage(chatId, message) {
    try {
        await bot.sendMessage(chatId, message);
    } catch (err) {
        console.error('Telegram error:', err.message);
    }
}

// ===== BROWSER =====
const path = require('path');

async function getBrowser() {
    if (!browser) {
        browser = await puppeteer.launch({
            headless: false, // IMPORTANT: less detectable than true
            userDataDir: path.join(__dirname, 'profile'), // session reuse
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled'
            ]
        });
    }
    return browser;
}

// ===== PAGE SETUP =====
async function setupPage(page) {
  await page.setExtraHTTPHeaders({
    'accept-language': 'en-IN,en;q=0.9'
  });

  await page.setViewport({
    width: 1366,
    height: 768
  });

  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false
    });
  });

  await page.setRequestInterception(true);

  page.on('request', req => {
    const type = req.resourceType();

    if (['image', 'font'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });
}

// ===== TIME PARSER =====
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

async function humanize(page) {
  await page.mouse.move(100 + Math.random()*200, 200 + Math.random()*200);
  await new Promise(resolve => setTimeout(resolve, 1000 + Math.random()*2000));

  await page.evaluate(() => {
    window.scrollBy(0, window.innerHeight / 2);
  });

  await new Promise(resolve => setTimeout(resolve, 1500 + Math.random()*2000));
}

// ===== MAIN CHECK =====
async function checkShow(job) {
  const { chatId, movie, city } = job;

  try {
    const browser = await getBrowser();

    if (!job.page) {
      job.page = await browser.newPage();
      await setupPage(job.page);
    }

    const page = job.page;

    // STEP 1: Open homepage
    await page.goto('https://in.bookmyshow.com/', {
      waitUntil: 'domcontentloaded'
    });

    await humanize(page);

    // STEP 2: Select city (important for accuracy)
    if (city) {
      try {
        await page.waitForSelector('input[type="text"]', { timeout: 5000 });
        await page.click('input[type="text"]');
        await page.type('input[type="text"]', city, { delay: 120 });
        await page.keyboard.press('Enter');
        await new Promise(resolve => setTimeout(resolve, 3000))
      } catch {}
    }

    await humanize(page);

    // STEP 3: Search movie
    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.click('input[type="text"]', { clickCount: 3 });

    await page.type('input[type="text"]', movie, { delay: 120 });
    await new Promise(resolve => setTimeout(resolve, 2000))

    await page.keyboard.press('Enter');

    await new Promise(resolve => setTimeout(resolve, 4000))

    await humanize(page);

    // STEP 4: Detect block properly
    const isBlocked = await page.evaluate(() => {
      return document.body.innerText.toLowerCase().includes('captcha') ||
             document.body.innerText.toLowerCase().includes('blocked') ||
             document.title.toLowerCase().includes('attention required');
    });

    if (isBlocked) {
      await sendTelegramMessage(chatId, '⚠️ Blocked / CAPTCHA detected');
      return false;
    }

    // STEP 5: Extract text
    const bodyText = await page.evaluate(() => document.body.innerText);

    if (bodyText.toLowerCase().includes(movie.toLowerCase())) {
      await sendTelegramMessage(chatId, `🎬 ${movie} found on listing page`);
      return true;
    }

    return false;

  } catch (err) {
    console.error('Check error:', err.message);
    return false;
  }
}

// ===== JOB =====
async function startJob(job) {
    const interval = 5 * 60 * 1000;
    const endTime = Date.now() + job.hours * 3600000;

    const found = await checkShow(job);
    if (found) return;

    job.interval = setInterval(async () => {
        if (Date.now() > endTime) {
            await sendTelegramMessage(job.chatId, '⏰ Time expired.');
            clearInterval(job.interval);
            delete jobs[job.chatId];
            return;
        }

        const found = await checkShow(job);

        if (found) {
            clearInterval(job.interval);
            delete jobs[job.chatId];
        }
    }, interval);
}

// ===== BOT FLOW =====
bot.onText(/\/start/, msg => {
    const chatId = msg.chat.id;

    sessions[chatId] = {
        step: 1,
        name: msg.from.first_name || 'User'
    };

    sendTelegramMessage(chatId, `Hi ${sessions[chatId].name}! Enter movie name`);
});

bot.on('message', async msg => {
    const chatId = msg.chat.id;

    if (!sessions[chatId] || msg.text.startsWith('/start')) return;

    const s = sessions[chatId];

    switch (s.step) {
        case 1:
            s.movie = msg.text;
            s.step = 2;
            sendTelegramMessage(chatId, 'Enter city');
            break;

        case 2:
            s.city = msg.text;
            s.step = 3;
            sendTelegramMessage(chatId, 'Enter theatre');
            break;

        case 3:
            s.theatre = msg.text;
            s.step = 4;
            sendTelegramMessage(chatId, 'Enter date YYYY-MM-DD');
            break;

        case 4:
            s.date = msg.text;
            s.step = 5;
            sendTelegramMessage(chatId, 'Enter time range (17-20)');
            break;

        case 5:
            s.ranges = msg.text.split(',').map(r => {
                const [from, to] = r.split('-').map(Number);
                return { from, to };
            });
            s.step = 6;
            sendTelegramMessage(chatId, 'Enter hours to track');
            break;

        case 6:
            s.hours = parseInt(msg.text);

            const job = { ...s, chatId };
            jobs[chatId] = job;

            sendTelegramMessage(chatId, `Tracking ${s.movie} for ${s.hours} hours`);

            await startJob(job);
            delete sessions[chatId];
            break;
    }
});

// ===== ERROR =====
bot.on('polling_error', err => {
    console.error('Polling error:', err.message);
});

// &&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&7

// const puppeteer = require('puppeteer');
// const axios = require('axios');
// const TelegramBot = require('node-telegram-bot-api');

// // ===== CONFIG =====
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// let SESSION = {
//   headers: {},
//   params: {}
// };

// async function refreshSession() {
//   console.log('🔄 Refreshing session...');

//   const browser = await puppeteer.launch({
//     headless: true,
//     args: ['--no-sandbox']
//   });

//   const page = await browser.newPage();
//   await page.setUserAgent('Mozilla/5.0');

//   const url = 'https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/SATB/20260408';

//   // Intercept request
//   page.on('request', (request) => {
//     const reqUrl = request.url();

//     if (reqUrl.includes('/api/v3/mobile/showtimes/byvenue')) {
//       const headers = request.headers();

//       SESSION.headers = headers;

//       const urlObj = new URL(reqUrl);
//       SESSION.params = Object.fromEntries(urlObj.searchParams.entries());

//       console.log('✅ Captured FULL session');
//     }
//   });

//   await page.goto(url, { waitUntil: 'networkidle2' });
//   await new Promise(resolve => setTimeout(resolve, 6000))

//   await browser.close();
// }

// // ===== STEP 2: API CALL =====
// async function fetchShows() {
//   try {
//     const res = await axios.get(
//       'https://in.bookmyshow.com/api/v3/mobile/showtimes/byvenue',
//       {
//         params: SESSION.params,
//         headers: SESSION.headers
//       }
//     );

//     return res.data;

//   } catch (err) {
//     console.error('❌ API Error:', err.response?.status);
//     return null;
//   }
// }

// // ===== PARSER =====
// function convertTo24(timeStr) {
//   let [time, modifier] = timeStr.split(' ');
//   let [hours] = time.split(':');

//   hours = parseInt(hours);

//   if (modifier === 'PM' && hours !== 12) hours += 12;
//   if (modifier === 'AM' && hours === 12) hours = 0;

//   return hours;
// }

// function extractShows(data) {
//   const shows = [];

//   if (!data?.ShowDetails) return shows;

//   data.ShowDetails.forEach(day => {
//     day.Event.forEach(event => {
//       event.ChildEvents.forEach(child => {
//         child.ShowTimes.forEach(show => {
//           shows.push({
//             movie: child.EventName,
//             time: show.ShowTime,
//             hour: convertTo24(show.ShowTime),
//             available: show.AvailStatus === "3"
//           });
//         });
//       });
//     });
//   });

//   return shows;
// }

// // ===== CHECK =====
// async function checkShows(job) {
//   const { chatId, movie, dateCode, venueCode, regionCode, ranges } = job;

//   const data = await fetchShows(dateCode, venueCode, regionCode);
//   if (!data) return false;

//   const shows = extractShows(data);

//   const matched = shows.filter(s =>
//     s.movie.toLowerCase().includes(movie.toLowerCase()) &&
//     s.available &&
//     ranges.some(r => s.hour >= r.from && s.hour <= r.to)
//   );

//   if (matched.length > 0) {
//     await bot.sendMessage(
//       chatId,
//       `🎬 ${movie} Available!\n🕒 ${matched.map(s => s.time).join(', ')}`
//     );
//     return true;
//   }

//   return false;
// }

// // ===== JOB SYSTEM =====
// const sessions = {};
// const jobs = {};

// async function startJob(job) {
//   const interval = 10 * 60 * 1000;
//   const endTime = Date.now() + job.hours * 3600000;

//   const found = await checkShows(job);
//   if (found) return;

//   job.interval = setInterval(async () => {
//     if (Date.now() > endTime) {
//       bot.sendMessage(job.chatId, '⏰ Time expired');
//       clearInterval(job.interval);
//       delete jobs[job.chatId];
//       return;
//     }

//     const found = await checkShows(job);
//     if (found) {
//       clearInterval(job.interval);
//       delete jobs[job.chatId];
//     }

//   }, interval);
// }

// // ===== BOT FLOW =====
// bot.onText(/\/start/, msg => {
//   const chatId = msg.chat.id;
//   sessions[chatId] = { step: 1 };
//   bot.sendMessage(chatId, 'Enter movie name');
// });

// bot.on('message', msg => {
//   const chatId = msg.chat.id;
//   if (!sessions[chatId] || msg.text.startsWith('/start')) return;

//   const s = sessions[chatId];

//   switch (s.step) {
//     case 1:
//       s.movie = msg.text;
//       s.step = 2;
//       bot.sendMessage(chatId, 'Enter DateCode (20260408)');
//       break;

//     case 2:
//       s.dateCode = msg.text;
//       s.step = 3;
//       bot.sendMessage(chatId, 'Enter VenueCode (SATB)');
//       break;

//     case 3:
//       s.venueCode = msg.text;
//       s.step = 4;
//       bot.sendMessage(chatId, 'Enter RegionCode (BANG)');
//       break;

//     case 4:
//       s.regionCode = msg.text;
//       s.step = 5;
//       bot.sendMessage(chatId, 'Enter time range (17-22)');
//       break;

//     case 5:
//       s.ranges = msg.text.split(',').map(r => {
//         const [from, to] = r.split('-').map(Number);
//         return { from, to };
//       });

//       s.step = 6;
//       bot.sendMessage(chatId, 'Enter hours');
//       break;

//     case 6:
//       s.hours = parseInt(msg.text);

//       const job = { ...s, chatId };
//       jobs[chatId] = job;

//       bot.sendMessage(chatId, `Tracking ${s.movie}`);
//       startJob(job);

//       delete sessions[chatId];
//       break;
//   }
// });

// // ===== AUTO REFRESH LOOP =====
// (async () => {
//   await refreshSession();

//   setInterval(async () => {
//     await refreshSession();
//   }, 25 * 60 * 1000); // every 25 min
// })();

// &&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&&7


// const TelegramBot = require('node-telegram-bot-api');
// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// const axios = require('axios');

// puppeteer.use(StealthPlugin());

// // ===== CONFIG =====
// const BOT_TOKEN = process.env.BOT_TOKEN;
// const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// // ===== User sessions =====
// const sessions = {};

// // ===== Helper Functions =====
// async function sendTelegramMessage(chatId, message) {
//   await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
// }

// function parseShowTimes(text) {
//   const regex = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
//   const times = [];
//   let match;
//   while ((match = regex.exec(text)) !== null) {
//     let hour = parseInt(match[1], 10);
//     const minute = parseInt(match[2], 10);
//     const period = match[3].toUpperCase();
//     if (period === 'PM' && hour !== 12) hour += 12;
//     if (period === 'AM' && hour === 12) hour = 0;
//     times.push({ hour24: hour, text: match[0] });
//   }
//   return times;
// }

// function hasTargetShowtime(text, ranges) {
//   const showtimes = parseShowTimes(text);
//   const matches = showtimes.filter(({ hour24 }) =>
//     ranges.some(({ from, to }) => hour24 >= from && hour24 <= to)
//   );
//   return matches;
// }

// async function checkShowForUser(chatId) {
//   const session = sessions[chatId];

//   if (!session) return;

//   const { movie, theatre, city, date, ranges } = session;
//   const citySlug = city.toLowerCase()?.replace(/\s+/g, '-');
//   const theatreSlug = theatre.toLowerCase()?.replace(/\s+/g, '-');
//   const dateSlug = date?.replace(/-/g, '');

//   const url = `https://in.bookmyshow.com/cinemas/${citySlug}/${theatreSlug}/buytickets/SATB/${dateSlug}`;

//   try {
//     console.log('Checking show for', { chatId, movie, city, theatre, date, ranges, url });
//     const browser = await puppeteer.launch({
//       headless: true,
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-web-security',
//         '--disable-features=IsolateOrigins,site-per-process'
//       ]
//     });
//     const page = await browser.newPage();
//     await page.setUserAgent(
//       'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
//     );
//     await page.setExtraHTTPHeaders({
//       'accept-language': 'en-US,en;q=0.9',
//       'dnt': '1'
//     });
//     await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
//     await new Promise(resolve => setTimeout(resolve, 8000));

//     const bodyText = await page.evaluate(() => document.body.innerText);
//     await browser.close();

//     const matchedTimes = hasTargetShowtime(bodyText, ranges);
//     const movieFound = bodyText.toLowerCase().includes(movie.toLowerCase());
//     const blocked = /blocked|cloudflare|security service/i.test(bodyText);
//     console.log('Scrape result', { movieFound, blocked, matchedTimes, bodyTextExcerpt: bodyText.slice(0, 1000) });

//     if (blocked) {
//       console.log('Cloudflare block detected.');
//       await sendTelegramMessage(chatId, '⚠️ BookMyShow blocked the request. Try again later or use a proxy/VPN.');
//       return;
//     }

//     if (movieFound && matchedTimes.length > 0) {
//       await sendTelegramMessage(chatId, `🎬 *${movie}* is available at: ${matchedTimes.map(t => t.text).join(', ')}`);
//       clearInterval(session.interval); // stop checking
//       delete sessions[chatId];
//     } else if (!movieFound) {
//       console.log(`Movie not found on page: ${movie}`);
//     } else if (matchedTimes.length === 0) {
//       console.log(`Movie found but no showtime matched for ranges`, ranges);
//       // Optional: send message to user about available times
//       const allTimes = parseShowTimes(bodyText);
//       if (allTimes.length > 0) {
//         await sendTelegramMessage(chatId, `🎥 *${movie}* found, but no shows in your range (${ranges.map(r => `${r.from}-${r.to}`).join(', ')}). Available times: ${allTimes.map(t => t.text).join(', ')}`);
//       }
//     }
//   } catch (err) {
//     console.error('Error in checkShowForUser:', err);
//   }
// }

// // ===== Telegram Interaction =====
// bot.onText(/\/start/, msg => {
//   const chatId = msg.chat.id;
//   sessions[chatId] = { step: 1, data: {} };
//   bot.sendMessage(chatId, 'Welcome! What movie do you want to track?');
// });

// bot.on('message', async msg => {
//   const chatId = msg.chat.id;
//   if (!sessions[chatId] || msg.text.startsWith('/start')) return;

//   const session = sessions[chatId];

//   switch (session.step) {
//     case 1:
//       session.movie = msg.text.trim();
//       session.step = 2;
//       bot.sendMessage(chatId, 'Enter the city:');
//       break;
//     case 2:
//       session.city = msg.text.trim();
//       session.step = 3;
//       bot.sendMessage(chatId, 'Enter the theatre name:');
//       break;
//     case 3:
//       session.theatre = msg.text.trim();
//       session.step = 4;
//       bot.sendMessage(chatId, 'Enter the date (YYYY-MM-DD):');
//       break;
//     case 4:
//       session.date = msg.text.trim();
//       session.step = 5;
//       bot.sendMessage(chatId, 'Enter showtime ranges (e.g., 17-20,21-23):');
//       break;
//     case 5:
//       // parse ranges
//       session.ranges = msg.text.split(',').map(r => {
//         const parts = r.split('-').map(Number);
//         if (parts.length === 1 || Number.isNaN(parts[1])) {
//           return { from: parts[0], to: parts[0] };
//         }
//         return { from: parts[0], to: parts[1] };
//       });
//       session.step = 6;
//       bot.sendMessage(chatId, 'How many hours should I check?');
//       break;
//     case 6:
//       const hours = parseInt(msg.text.trim());
//       const intervalMs = 2 * 60 * 1000; // 2 mins
//       const endTime = Date.now() + hours * 60 * 60 * 1000;

//       bot.sendMessage(chatId, `✅ Started tracking *${session.movie}* for next ${hours} hours.`);

//       // ✅ RUN FIRST CHECK IMMEDIATELY
//       await checkShowForUser(chatId);

//       // ✅ THEN START INTERVAL
//       session.interval = setInterval(async () => {
//         if (Date.now() > endTime) {
//           await sendTelegramMessage(chatId, '⏰ Time expired, no shows found.');
//           clearInterval(session.interval);
//           delete sessions[chatId];
//         } else {
//           try {
//             await checkShowForUser(chatId);
//           } catch (err) {
//             console.error(err);
//             await sendTelegramMessage(chatId, '❌ Error checking show. Retrying...');
//           }
//         }
//       }, intervalMs);

//       session.step = 7;
//       break;
//   }
// });