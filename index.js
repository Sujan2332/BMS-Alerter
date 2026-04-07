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
        await axios.post(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            chat_id: TELEGRAM_CHAT_ID,
            text: message,
        });
        console.log("📲 Telegram sent");
    } catch (err) {
        console.error("❌ Telegram failed:", err.message);
    }
}

// ===== FETCH PAGE WITHOUT BROWSER =====
async function checkShow() {
    console.log("🔍 Checking BookMyShow...");

    try {
        const response = await axios.get(CINEMA_URL, {
            headers: {
                "User-Agent": "Mozilla/5.0",
            },
        });

        const bodyText = response.data;

        if (bodyText.includes(MOVIE)) {
            if (!alreadySent) {
                await sendTelegram(`🎬 ${MOVIE} might be available!\n👉 Check BookMyShow`);
                alreadySent = true;
            }
        } else {
            console.log("❌ Not found yet");
        }

    } catch (err) {
        console.error("❌ Fetch error:", err.message);
    }
}

// RUN
checkShow();