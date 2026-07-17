# BMS Alerter 🎬

A Telegram bot that watches [BookMyShow](https://in.bookmyshow.com) for a specific movie, theatre, and showtime — and pings you the moment tickets go live, so you don't have to keep refreshing the page.

## Try it now

No setup needed — the bot is already live on Telegram. Just message [@bms_Alerter_Bot](https://t.me/bms_Alerter_Bot) and send `/start` to begin tracking a show.

## How it works

1. You start a chat with the bot and answer a few prompts: movie name, city, theatre, date, and preferred time ranges.
2. The bot polls BookMyShow's showtimes API every 3 minutes using a headless Chrome browser (via Puppeteer, with stealth plugins to avoid bot detection).
3. As soon as your movie appears at the chosen theatre within your preferred time window, the bot sends you a Telegram message with the showtimes and a direct booking link — then stops checking.
4. If nothing turns up within the time limit you set, the bot lets you know and stops.

## Tech stack

- **Node.js** + **Express** — lightweight server, also used to keep the free-tier host awake
- **node-telegram-bot-api** — Telegram bot integration (webhook-based)
- **Puppeteer** + **puppeteer-extra** (stealth plugin) — headless browser automation to get past Cloudflare and capture live API sessions
- **Axios** — replaying captured API requests directly once a session is established

## Prerequisites

- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A publicly reachable URL for the webhook (e.g. a [Render](https://render.com) deployment, ngrok tunnel, etc.)

## Setup

```bash
git clone https://github.com/Sujan2332/BMS-Alerter.git
cd BMS-Alerter
npm install
```

Create a `.env` file in the project root:

```env
BOT_TOKEN=your-telegram-bot-token
PORT=3000
HOST_URL=https://your-deployed-url.com
```

Install headless Chrome for Puppeteer (this also runs automatically via the `build` script on most hosting platforms):

```bash
npm run build
```

Start the bot:

```bash
npm start
```

## Usage

1. Open Telegram and start a chat with [@bms_Alerter_Bot](https://t.me/bms_Alerter_Bot) (or your own deployed bot).
2. Send `/start`.
3. Answer the prompts in order:
   - Movie name
   - City
   - Theatre
   - Date (`YYYY-MM-DD`)
   - Time ranges you're interested in, e.g. `17-20,21-23`
   - How many hours to keep checking for, e.g. `6`
4. The bot checks immediately, then every 3 minutes until it finds a match or the time limit is reached.

## Project structure

```
.
├── index.js              # Main entry point — webhook-based Telegram bot (used by `npm start`)
├── server.js             # Earlier polling-based version of the bot (kept for reference)
├── apicall.js            # Standalone script for testing the BookMyShow API capture/scrape flow
├── install-chrome.js     # Ensures headless Chrome is installed before the bot starts
├── puppeteerrc.cjs       # Puppeteer cache/config
└── backup/                # Older iterations of the bot, kept for reference
```

## Notes & limitations

- Only tested for BookMyShow's Indian site (`in.bookmyshow.com`). Venue and region codes for a handful of cities/theatres are hardcoded in `index.js` (`VENUE_MAP`, `REGION_MAP`) — theatres outside that list are guessed from their name and may not resolve correctly.
- Relies on scraping/replaying BookMyShow's internal API, so it may break if BookMyShow changes its site or adds stronger bot protection.
- This project is for personal/educational use. Automated scraping of BookMyShow may be against their Terms of Service — use at your own discretion.
