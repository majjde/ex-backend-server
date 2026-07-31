const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const { pool, initDb } = require('./db');
const { generateLicenseKey } = require('./keyGenerator');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'apikey', 'x-api-key', 'Authorization'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());

// --- Helper Functions ---
function isAuthorizedAdmin(msg) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) {
    console.warn('⚠️ ADMIN_CHAT_ID environment variable is not configured.');
    return false;
  }
  const chatId = String(msg.chat.id);
  const senderId = msg.from ? String(msg.from.id) : '';
  const targetAdminId = String(adminId).trim();

  return chatId === targetAdminId || senderId === targetAdminId;
}

// --- Express API Router ---

// Health Check Route
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'License Activation API & Admin Bot' });
});

// Activation Endpoint
app.post('/api/activate', async (req, res) => {
  try {
    // Header Authentication Check
    const expectedApiKey = process.env.EXTENSION_API_KEY || 'freeflow-be-key-2008';
    const apiKey = req.headers.apikey || req.headers['apikey'] || req.headers['x-api-key'];
    if (!apiKey || apiKey !== expectedApiKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    const { license_key, token_lovable } = req.body || {};

    if (!license_key || !String(license_key).trim()) {
      return res.status(400).json({ error: 'Missing required parameter: license_key' });
    }

    const cleanKey = String(license_key).trim();
    const userToken = (token_lovable && String(token_lovable).trim()) ? String(token_lovable).trim() : 'session_active';

    // Query license key
    const queryResult = await pool.query('SELECT * FROM licenses WHERE key = $1', [cleanKey]);

    if (queryResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or revoked key' });
    }

    const license = queryResult.rows[0];

    // Status: Revoked
    if (license.status === 'revoked') {
      return res.status(401).json({ error: 'Invalid or revoked key' });
    }

    // Status: Unused -> Activate and bind to user ID
    if (license.status === 'unused') {
      await pool.query(
        "UPDATE licenses SET status = 'active', lovable_user_id = $1 WHERE key = $2",
        [userToken, cleanKey]
      );
      return res.status(200).json({
        success: true,
        message: 'License activated successfully!',
        status: 'active'
      });
    }

    // Status: Active -> Verify device binding
    if (license.status === 'active') {
      if (!license.lovable_user_id || license.lovable_user_id === 'session_active' || license.lovable_user_id === userToken || userToken === 'session_active') {
        if (userToken !== 'session_active' && license.lovable_user_id !== userToken) {
          await pool.query(
            "UPDATE licenses SET lovable_user_id = $1 WHERE key = $2",
            [userToken, cleanKey]
          );
        }
        return res.status(200).json({
          success: true,
          message: 'License verified successfully!',
          status: 'active'
        });
      } else {
        return res.status(401).json({ error: 'Key already bound to another device' });
      }
    }

    return res.status(401).json({ error: 'Invalid or revoked key' });
  } catch (error) {
    console.error('Error during license activation:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Telegram Bot Admin Panel ---
let bot = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('polling_error', (error) => {
    console.error('Telegram bot polling error:', error.message);
  });

  // Listener for text messages
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    if (!isAuthorizedAdmin(msg)) {
      console.warn(`Unauthorized message attempt from chat ID: ${msg.chat.id}`);
      return; // Ignore unauthorized users completely
    }

    const text = msg.text.trim();
    const chatId = msg.chat.id;

    // /start command
    if (text.startsWith('/start')) {
      const welcomeMsg = `🤖 *License Admin Management Bot*\n\nAvailable Commands:\n• \`/start\` - Show this help menu\n• \`/newkey\` - Generate a new key (Format: \`ATM-XXXX-XXXX-XXXX-XXXX\`)\n• \`/list\` - View statistics of active, unused, and revoked keys\n• \`/revoke [key]\` - Revoke a specific license key`;
      return bot.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });
    }

    // /newkey command
    if (text.startsWith('/newkey')) {
      try {
        const key = generateLicenseKey();
        await pool.query('INSERT INTO licenses (key, status) VALUES ($1, $2)', [key, 'unused']);
        const reply = `✅ *New License Key Generated:*\n\n\`${key}\`\n\nStatus: \`unused\``;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error generating key:', err);
        return bot.sendMessage(chatId, '❌ Failed to generate key due to a database error.');
      }
    }

    // /list command
    if (text.startsWith('/list')) {
      try {
        const result = await pool.query(
          'SELECT status, COUNT(*)::int as count FROM licenses GROUP BY status'
        );

        const counts = { active: 0, unused: 0, revoked: 0 };
        let total = 0;

        result.rows.forEach((row) => {
          counts[row.status] = parseInt(row.count, 10);
          total += parseInt(row.count, 10);
        });

        const reply = `📊 *License Key Statistics:*\n\n🟢 *Active:* ${counts.active || 0}\n🟡 *Unused:* ${counts.unused || 0}\n🔴 *Revoked:* ${counts.revoked || 0}\n\n📦 *Total Keys:* ${total}`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error querying key list:', err);
        return bot.sendMessage(chatId, '❌ Failed to fetch key statistics.');
      }
    }

    // /revoke command
    if (text.startsWith('/revoke')) {
      const parts = text.split(/\s+/);
      const keyToRevoke = parts[1] ? parts[1].trim() : null;

      if (!keyToRevoke) {
        return bot.sendMessage(
          chatId,
          '⚠️ Please provide a key to revoke.\nExample: \`/revoke ATM-PUM8-ALT2-XJ6G-FMBX\`',
          { parse_mode: 'Markdown' }
        );
      }

      try {
        const result = await pool.query(
          "UPDATE licenses SET status = 'revoked' WHERE key = $1 RETURNING *",
          [keyToRevoke]
        );

        if (result.rowCount > 0) {
          return bot.sendMessage(
            chatId,
            `🛑 License key \`${keyToRevoke}\` has been successfully *revoked*.`,
            { parse_mode: 'Markdown' }
          );
        } else {
          return bot.sendMessage(
            chatId,
            `❌ License key \`${keyToRevoke}\` was not found in the database.`,
            { parse_mode: 'Markdown' }
          );
        }
      } catch (err) {
        console.error('Error revoking key:', err);
        return bot.sendMessage(chatId, '❌ Database error while revoking key.');
      }
    }
  });

  console.log('🤖 Telegram Bot polling started.');
} else {
  console.warn('⚠️ TELEGRAM_BOT_TOKEN is missing in environment variables. Telegram Bot features are disabled.');
}

// --- App Start ---
const PORT = process.env.PORT || 3000;

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`🚀 Express API server running on port ${PORT}`);
  });
}

startServer();
