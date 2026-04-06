const puppeteer = require("puppeteer");
const nodemailer = require("nodemailer");
const axios = require("axios");

// ===== CONFIG =====
const MOVIE = "Race Gurram";
const CINEMA_URL = "https://in.bookmyshow.com/cinemas/bengaluru/sandhya-cinema-bengaluru/buytickets/SATB/20260408";
const TELEGRAM_BOT_TOKEN = "8685438592:AAG-6incTzVBB85eXgu9KNT2t06m3dxlaUY";
const TELEGRAM_CHAT_ID = "1120111884";

let alreadySent = false;

// ===== TELEGRAM FUNCTION =====
async function sendTelegram(message) {
    try {
        const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
        });
        console.log("📲 Telegram sent");
    } catch (err) {
        console.error("❌ Telegram failed:", err.message);
    }
}

function parseShowTimes(text) {
    const times = [];
    const regex = /(\d{1,2}):(\d{2})\s*(AM|PM)/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
        const hour = parseInt(match[1], 10);
        const minute = parseInt(match[2], 10);
        const period = match[3].toUpperCase();
        let hour24 = hour % 12;

        if (period === "PM") {
            hour24 += 12;
        }

        times.push({ hour24, minute, text: match[0] });
    }

    return times;
}

function hasTargetShowtime(text) {
    const ranges = [
        { from: 17, to: 20 },
        { from: 21, to: 23 },
    ];

    const showtimes = parseShowTimes(text);
    const matches = showtimes.filter(({ hour24 }) =>
        ranges.some(range => hour24 >= range.from && hour24 <= range.to)
    );

    return { found: matches.length > 0, matches };
}

// ===== CHECK BOOKMYSHOW =====
async function checkShow() {
    console.log("🔍 Checking BookMyShow...");

    const browser = await puppeteer.launch({ headless: true });
    const page = await browser.newPage();

    await page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    );

    await page.goto(CINEMA_URL, { waitUntil: "networkidle2" });
    await new Promise(resolve => setTimeout(resolve, 8000));

    const bodyText = await page.evaluate(() => document.body.innerText);
    await browser.close();

    // ===== DETECTION LOGIC =====
    const showtimeResult = hasTargetShowtime(bodyText);

    if (bodyText.includes(MOVIE) && showtimeResult.found) {
        if (!alreadySent) {
            const timeList = showtimeResult.matches
                .map(item => item.text)
                .filter((value, index, self) => self.indexOf(value) === index)
                .join(", ");

            const msg = `
🎬 Race Gurram is LIVE!

📍 Sandhya RGB Laser Atmos
🕙 Show available at: ${timeList}

👉 Book now on BookMyShow!
`;

            await sendTelegram(msg);
            alreadySent = true;
        }
    } else {
        console.log("❌ Not found yet");
    }
}

// ===== RUN ONCE FOR TESTING =====
checkShow();