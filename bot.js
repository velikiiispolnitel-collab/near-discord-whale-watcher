/**
 * Discord NEAR Whale Watcher Bot
 * 
 * Monitors large NEAR transactions in real-time and posts rich alert embeds
 * to a configured Discord channel. Supports configurable thresholds,
 * account pattern filtering, and historical whale activity tracking.
 * 
 * Usage:
 *   DISCORD_BOT_TOKEN=xxx ALERT_CHANNEL_ID=xxx node bot.js
 */

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ],
});

// ─── Configuration ───────────────────────────────────────────────────────────

const CONFIG = {
  token: process.env.DISCORD_BOT_TOKEN || '',
  threshold: parseFloat(process.env.WHALE_THRESHOLD || '1000'),
  checkInterval: parseInt(process.env.CHECK_INTERVAL || '30000'),
  channelId: process.env.ALERT_CHANNEL_ID || '',
  nearRpcUrl: process.env.NEAR_RPC_URL || 'https://rpc.mainnet.near.org',
  maxCacheSize: 50000,
  minAlertInterval: 5000, // minimum ms between alerts to avoid spam
  // Account pattern filtering (comma-separated, supports wildcards)
  // Example: "*.near,*.pool.near" or exclude: "!hotmail.com"
  includePatterns: (process.env.INCLUDE_PATTERNS || '').split(',').map(s => s.trim()).filter(Boolean),
  excludePatterns: (process.env.EXCLUDE_PATTERNS || '').split(',').map(s => s.trim()).filter(Boolean),
};

// ─── State ───────────────────────────────────────────────────────────────────

const processedBlocks = new Set();
const whaleHistory = []; // last N whale alerts for !whale history
const MAX_HISTORY = 100;
let lastAlertTime = 0;
let totalAlerts = 0;

// ─── NEAR RPC Helpers ────────────────────────────────────────────────────────

async function nearRpc(method, params) {
  const res = await fetch(CONFIG.nearRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'whale-watcher', method, params }),
  });
  return res.json();
}

async function fetchLatestBlock() {
  try {
    const data = await nearRpc('block', { finality: 'final' });
    return data?.result || null;
  } catch (err) {
    console.error('[RPC] Block fetch error:', err.message);
    return null;
  }
}

async function fetchChunk(chunkHash) {
  try {
    const data = await nearRpc('chunk', { chunk_id: chunkHash });
    return data?.result || null;
  } catch (err) {
    console.error('[RPC] Chunk fetch error:', err.message);
    return null;
  }
}

async function fetchTransaction(txHash, signerId) {
  try {
    const data = await nearRpc('tx', [txHash, signerId]);
    return data?.result || null;
  } catch (err) {
    console.error('[RPC] TX fetch error:', err.message);
    return null;
  }
}

// ─── Account Pattern Filtering ──────────────────────────────────────────────

function matchesPattern(accountId, pattern) {
  if (!pattern || !accountId) return false;
  // Convert glob-style pattern to regex
  const regex = new RegExp(
    '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$',
    'i'
  );
  return regex.test(accountId);
}

function shouldIncludeAccount(accountId) {
  const { includePatterns, excludePatterns } = CONFIG;

  // If exclude patterns match, skip
  if (excludePatterns.length > 0) {
    for (const pattern of excludePatterns) {
      if (matchesPattern(accountId, pattern)) return false;
    }
  }

  // If include patterns are set, at least one must match
  if (includePatterns.length > 0) {
    return includePatterns.some(p => matchesPattern(accountId, p));
  }

  // No filters = include all
  return true;
}

// ─── Whale Detection ─────────────────────────────────────────────────────────

/**
 * Extract large transfers from a chunk's transactions.
 * Returns array of { signerId, receiverId, amount, txHash } for transfers
 * exceeding the threshold.
 */
function extractWhaleTransfers(chunk, blockHeight) {
  const whales = [];

  if (!chunk?.transactions) return whales;

  for (const tx of chunk.transactions) {
    const actions = tx.actions || [];
    const signerId = tx.signer_id || 'unknown';
    const txHash = tx.hash || 'unknown';

    for (const action of actions) {
      // Direct Transfer action
      if (action.Transfer) {
        const depositYocto = action.Transfer.deposit || '0';
        const amountNear = Number(BigInt(depositYocto)) / 1e24;

        if (amountNear >= CONFIG.threshold) {
          // Apply account pattern filtering
          if (!shouldIncludeAccount(signerId) && !shouldIncludeAccount(tx.receiver_id || '')) {
            continue;
          }
          whales.push({
            type: 'Transfer',
            signerId,
            receiverId: tx.receiver_id || 'unknown',
            amount: amountNear,
            amountYocto: depositYocto,
            txHash,
            blockHeight,
          });
        }
      }

      // FunctionCall that might be a transfer (e.g., ft_transfer)
      if (action.FunctionCall) {
        const methodName = action.FunctionCall.method_name || '';
        const depositYocto = action.FunctionCall.deposit || '0';
        const amountNear = Number(BigInt(depositYocto)) / 1e24;

        // Flag large function call deposits too
        if (amountNear >= CONFIG.threshold) {
          whales.push({
            type: 'FunctionCall',
            signerId,
            receiverId: tx.receiver_id || 'unknown',
            amount: amountNear,
            amountYocto: depositYocto,
            txHash,
            blockHeight,
            methodName,
          });
        }
      }
    }
  }

  return whales;
}

// ─── Discord Alerting ────────────────────────────────────────────────────────

function formatNearAmount(near) {
  if (near >= 1_000_000) return `${(near / 1_000_000).toFixed(2)}M NEAR`;
  if (near >= 1_000) return `${(near / 1_000).toFixed(1)}K NEAR`;
  return `${near.toFixed(2)} NEAR`;
}

function createWhaleEmbed(whale) {
  const amount = formatNearAmount(whale.amount);
  const emoji = whale.amount >= 10000 ? '🐳' : whale.amount >= 5000 ? '🐋' : '🐟';

  const embed = new EmbedBuilder()
    .setTitle(`${emoji} NEAR Whale Alert — ${amount}`)
    .setColor(whale.amount >= 10000 ? 0xFF4444 : whale.amount >= 5000 ? 0xFF8800 : 0x00AAFF)
    .setTimestamp()
    .setFooter({ text: `Block #${whale.blockHeight} • Threshold: ${CONFIG.threshold} NEAR` });

  embed.addFields(
    { name: '💰 Amount', value: `**${amount}**`, inline: true },
    { name: '📤 From', value: `\`${whale.signerId}\``, inline: true },
    { name: '📥 To', value: `\`${whale.receiverId}\``, inline: true },
  );

  if (whale.type === 'FunctionCall' && whale.methodName) {
    embed.addFields({ name: '⚙️ Method', value: `\`${whale.methodName}()\``, inline: true });
  }

  embed.addFields({
    name: '🔗 Explorer',
    value: `[View Transaction](https://nearblocks.io/txns/${whale.txHash})`,
    inline: false,
  });

  return embed;
}

async function sendWhaleAlert(whale) {
  if (!CONFIG.channelId) return;

  // Rate limiting
  const now = Date.now();
  if (now - lastAlertTime < CONFIG.minAlertInterval) return;
  lastAlertTime = now;

  try {
    const channel = await client.channels.fetch(CONFIG.channelId);
    if (!channel) {
      console.error('[Alert] Channel not found:', CONFIG.channelId);
      return;
    }

    const embed = createWhaleEmbed(whale);
    await channel.send({ embeds: [embed] });

    // Track history
    whaleHistory.unshift({ ...whale, alertedAt: new Date().toISOString() });
    if (whaleHistory.length > MAX_HISTORY) whaleHistory.pop();

    totalAlerts++;
    console.log(`[Alert] Sent: ${formatNearAmount(whale.amount)} from ${whale.signerId}`);
  } catch (err) {
    console.error('[Alert] Send error:', err.message);
  }
}

// ─── Monitor Loop ────────────────────────────────────────────────────────────

async function checkForWhales() {
  if (!CONFIG.token || !CONFIG.channelId) return;

  const block = await fetchLatestBlock();
  if (!block?.header) return;

  const blockHeight = block.header.height;
  const blockHash = block.header.hash;

  // Skip already processed blocks
  if (processedBlocks.has(blockHash)) return;
  processedBlocks.add(blockHash);

  // Manage cache
  if (processedBlocks.size > CONFIG.maxCacheSize) {
    const arr = [...processedBlocks];
    for (let i = 0; i < arr.length - CONFIG.maxCacheSize / 2; i++) {
      processedBlocks.delete(arr[i]);
    }
  }

  // Process each chunk
  const chunkHashes = (block.chunks || []).map(c => c.chunk_hash);
  for (const chunkHash of chunkHashes) {
    const chunk = await fetchChunk(chunkHash);
    if (!chunk) continue;

    const whales = extractWhaleTransfers(chunk, blockHeight);
    for (const whale of whales) {
      await sendWhaleAlert(whale);
    }
  }

  console.log(`[Monitor] Block #${blockHeight} | Chunks: ${chunkHashes.length} | Cache: ${processedBlocks.size}`);
}

// ─── Discord Commands ────────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const content = message.content.trim();

  // !whale status
  if (content === '!whale status') {
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const embed = new EmbedBuilder()
      .setTitle('🐋 Whale Watcher Status')
      .setColor(0x00FF00)
      .addFields(
        { name: 'Status', value: '✅ Active', inline: true },
        { name: 'Threshold', value: `${CONFIG.threshold.toLocaleString()} NEAR`, inline: true },
        { name: 'Check Interval', value: `${CONFIG.checkInterval / 1000}s`, inline: true },
        { name: 'Blocks Scanned', value: `${processedBlocks.size.toLocaleString()}`, inline: true },
        { name: 'Total Alerts', value: `${totalAlerts}`, inline: true },
        { name: 'Uptime', value: `${hours}h ${mins}m`, inline: true },
        { name: 'RPC', value: CONFIG.nearRpcUrl, inline: false },
      )
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // !whale threshold <amount>
  if (content.startsWith('!whale threshold ')) {
    const parts = content.split(' ');
    const newThreshold = parseFloat(parts[2]);
    if (isNaN(newThreshold) || newThreshold <= 0) {
      return message.reply('❌ Invalid threshold. Usage: `!whale threshold 5000`');
    }
    CONFIG.threshold = newThreshold;
    return message.reply(`✅ Threshold updated to **${newThreshold.toLocaleString()} NEAR**`);
  }

  // !whale filter <include|exclude> <pattern>
  if (content.startsWith('!whale filter ')) {
    const parts = content.split(' ');
    const action = parts[2]?.toLowerCase();
    const pattern = parts[3];
    if (!action || !pattern || !['include', 'exclude'].includes(action)) {
      return message.reply('❌ Usage: `!whale filter include *.near` or `!whale filter exclude hotmail.com`');
    }
    if (action === 'include') {
      CONFIG.includePatterns.push(pattern);
      return message.reply(`✅ Added include filter: \`${pattern}\``);
    } else {
      CONFIG.excludePatterns.push(pattern);
      return message.reply(`✅ Added exclude filter: \`${pattern}\``);
    }
  }

  // !whale history [count]
  if (content.startsWith('!whale history')) {
    const parts = content.split(' ');
    const count = Math.min(parseInt(parts[2]) || 10, 25);

    if (whaleHistory.length === 0) {
      return message.reply('📭 No whale alerts recorded yet.');
    }

    const recent = whaleHistory.slice(0, count);
    const lines = recent.map((w, i) => {
      const time = new Date(w.alertedAt).toLocaleTimeString();
      const amount = formatNearAmount(w.amount);
      return `${i + 1}. ${amount} — \`${w.signerId}\` → \`${w.receiverId}\` (${time})`;
    });

    const embed = new EmbedBuilder()
      .setTitle(`🐋 Whale History (last ${recent.length})`)
      .setColor(0x00AAFF)
      .setDescription(lines.join('\n'))
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // !whale help
  if (content === '!whale help') {
    const embed = new EmbedBuilder()
      .setTitle('🐋 NEAR Whale Watcher — Commands')
      .setColor(0x00AAFF)
      .setDescription('Monitors large NEAR transactions and posts alerts in real-time.')
      .addFields(
        { name: '!whale status', value: 'Show bot status and statistics' },
        { name: '!whale threshold <amount>', value: 'Set alert threshold in NEAR' },
        { name: '!whale filter include <pattern>', value: 'Only alert for matching accounts (* wildcard)' },
        { name: '!whale filter exclude <pattern>', value: 'Skip alerts for matching accounts' },
        { name: '!whale history [count]', value: 'Show recent whale alerts (max 25)' },
        { name: '!whale help', value: 'Show this help message' },
      )
      .setFooter({ text: 'NEAR Whale Watcher Bot v1.0' });

    return message.reply({ embeds: [embed] });
  }
});

// ─── Startup ─────────────────────────────────────────────────────────────────

client.once('ready', () => {
  console.log(`✅ Whale Watcher online as ${client.user.tag}`);
  console.log(`   Threshold: ${CONFIG.threshold} NEAR`);
  console.log(`   Check interval: ${CONFIG.checkInterval}ms`);
  console.log(`   Alert channel: ${CONFIG.channelId}`);
  console.log(`   RPC: ${CONFIG.nearRpcUrl}`);

  // Start monitoring
  setInterval(checkForWhales, CONFIG.checkInterval);
  checkForWhales();
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down Whale Watcher...');
  client.destroy();
  process.exit(0);
});

process.on('SIGTERM', () => {
  client.destroy();
  process.exit(0);
});

// Login
if (CONFIG.token) {
  client.login(CONFIG.token);
} else {
  console.log('⚠️  Set DISCORD_BOT_TOKEN environment variable to start the bot');
  console.log('   Example: DISCORD_BOT_TOKEN=xxx ALERT_CHANNEL_ID=xxx node bot.js');
}

module.exports = { client, CONFIG, checkForWhales, extractWhaleTransfers };
