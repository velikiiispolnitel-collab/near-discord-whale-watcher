# 🐋 Discord NEAR Whale Watcher Bot

Real-time Discord bot that monitors large NEAR transactions and posts rich alert embeds to your server.

## Features

- **Real-time monitoring** — Scans NEAR blocks every 30 seconds (configurable)
- **Rich embeds** — Color-coded alerts with amount, from/to, block height, explorer link
- **Configurable threshold** — Set minimum NEAR amount via Discord command
- **Whale history** — View recent large transactions with `!whale history`
- **Rate limiting** — Prevents alert spam
- **Status commands** — Check bot health and statistics

## Quick Start

```bash
# 1. Install dependencies
npm install discord.js

# 2. Set environment variables
cp .env.example .env
# Edit .env with your Discord bot token and channel ID

# 3. Start the bot
node bot.js
```

## Discord Bot Setup

1. Go to https://discord.com/developers/applications
2. Create New Application → Bot → Add Bot
3. Copy the bot token
4. Enable **Message Content Intent** in Bot settings
5. Invite bot to your server with `bot` and `Send Messages` scopes
6. Copy the channel ID where you want alerts

## Commands

| Command | Description |
|---------|-------------|
| `!whale status` | Show bot status, uptime, stats |
| `!whale threshold 5000` | Set alert threshold to 5000 NEAR |
| `!whale history 10` | Show last 10 whale alerts |
| `!whale help` | Show all commands |

## Alert Levels

| Amount | Emoji | Color |
|--------|-------|-------|
| ≥ 10,000 NEAR | 🐳 | Red |
| ≥ 5,000 NEAR | 🐋 | Orange |
| ≥ threshold | 🐟 | Blue |

## Deployment

### PM2 (recommended)
```bash
pm2 start bot.js --name whale-watcher
pm2 save
pm2 startup
```

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY . .
CMD ["node", "bot.js"]
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | — | Discord bot token (required) |
| `ALERT_CHANNEL_ID` | — | Channel ID for alerts (required) |
| `WHALE_THRESHOLD` | 1000 | Minimum NEAR to trigger alert |
| `CHECK_INTERVAL` | 30000 | Block check interval (ms) |
| `NEAR_RPC_URL` | mainnet | NEAR RPC endpoint |
