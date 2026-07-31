const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const { pool, initDb, getSetting, setSetting, getAllSettings } = require('./db');
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
app.use(express.urlencoded({ extended: true }));

// --- Admin Authorization Helper ---
function isAuthorizedAdmin(msgOrId) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) {
    console.warn('⚠️ ADMIN_CHAT_ID environment variable is not configured.');
    return false;
  }
  const targetAdminId = String(adminId).trim();

  if (typeof msgOrId === 'object' && msgOrId !== null) {
    const chatId = String(msgOrId.chat ? msgOrId.chat.id : '');
    const senderId = msgOrId.from ? String(msgOrId.from.id) : '';
    return chatId === targetAdminId || senderId === targetAdminId;
  }

  return String(msgOrId).trim() === targetAdminId;
}

// --- Regex Helpers for SMS & UTR Extraction ---
function extractRrnAndAmount(smsText) {
  if (!smsText || typeof smsText !== 'string') {
    return { rrn: null, amount: null };
  }

  // 1. Extract RRN / UTR (12 digits)
  // Look for RRN-XXXX... or UTR-XXXX... or 12 digit string
  let rrnMatch = smsText.match(/RRN-?\s*(\d{12})/i) ||
                 smsText.match(/UTR-?\s*(\d{12})/i) ||
                 smsText.match(/Ref-?\s*(\d{12})/i) ||
                 smsText.match(/\b(\d{12})\b/);

  const rrn = rrnMatch ? rrnMatch[1] : null;

  // 2. Extract Amount
  // Examples: "Rs. 5.00", "Rs 500", "INR 100.50", "received Rs. 5.00"
  let amountMatch = smsText.match(/(?:Rs\.?|INR)\s*([\d,]+(?:\.\d{1,2})?)/i) ||
                    smsText.match(/received\s*(?:Rs\.?|INR)?\s*([\d,]+(?:\.\d{1,2})?)/i);

  let amount = null;
  if (amountMatch) {
    const cleaned = amountMatch[1].replace(/,/g, '');
    const parsed = parseFloat(cleaned);
    if (!isNaN(parsed)) {
      amount = parsed;
    }
  }

  return { rrn, amount };
}

function extractUtrFromUserText(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/RRN-?\s*(\d{12})/i) ||
                text.match(/UTR-?\s*(\d{12})/i) ||
                text.match(/\b(\d{12})\b/);
  return match ? match[1] : null;
}

// --- In-Memory Conversation State Machines ---
// admin_states[chatId] = { action: 'awaiting_...' }
const adminStates = {};
// user_states[chatId] = { action: 'awaiting_utr', intent: 'license' | 'course' }
const userStates = {};

// --- Express API Router ---

// Health Check Route
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'License Activation API & Telegram Bot' });
});

// Extension Activation Endpoint (/api/activate)
app.post('/api/activate', async (req, res) => {
  try {
    const expectedApiKey = process.env.EXTENSION_API_KEY || 'freeflow-be-key-2008';
    const apiKey = req.headers.apikey || req.headers['apikey'] || req.headers['x-api-key'];
    if (!apiKey || apiKey !== expectedApiKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    const { license_key, token_lovable, hwFingerprint, hw_fingerprint } = req.body || {};

    if (!license_key || !String(license_key).trim()) {
      return res.status(400).json({ error: 'Missing required parameter: license_key' });
    }

    const cleanKey = String(license_key).trim();
    const userToken = (token_lovable && String(token_lovable).trim()) ? String(token_lovable).trim() : 'session_active';
    const requestFingerprint = (hwFingerprint || hw_fingerprint || '').trim();

    const queryResult = await pool.query('SELECT * FROM licenses WHERE key = $1', [cleanKey]);

    if (queryResult.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid or revoked key' });
    }

    const license = queryResult.rows[0];

    // Check status: Revoked
    if (license.status === 'revoked') {
      return res.status(401).json({ error: 'Invalid or revoked key' });
    }

    // Check status: Unused -> Activate and bind hardware fingerprint
    if (license.status === 'unused') {
      await pool.query(
        "UPDATE licenses SET status = 'active', lovable_user_id = $1, hw_fingerprint = $2 WHERE key = $3",
        [userToken, requestFingerprint || null, cleanKey]
      );
      return res.status(200).json({
        success: true,
        message: 'License activated successfully!',
        status: 'active'
      });
    }

    // Check status: Active -> Verify hardware fingerprint and user device
    if (license.status === 'active') {
      // 1. Hardware Fingerprint Validation
      if (license.hw_fingerprint) {
        if (requestFingerprint && license.hw_fingerprint !== requestFingerprint) {
          return res.status(401).json({ error: 'Key already bound to another machine/device' });
        }
      } else if (requestFingerprint) {
        // Bind legacy key without fingerprint to this first fingerprint
        await pool.query(
          "UPDATE licenses SET hw_fingerprint = $1 WHERE key = $2",
          [requestFingerprint, cleanKey]
        );
      }

      // 2. User session binding update if needed
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
        return res.status(401).json({ error: 'Key already bound to another user session' });
      }
    }

    return res.status(401).json({ error: 'Invalid or revoked key' });
  } catch (error) {
    console.error('Error during license activation:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Macrodroid Payment SMS Webhook Endpoint (/api/payment-sms)
app.post('/api/payment-sms', async (req, res) => {
  try {
    const payload = req.body || {};
    // Extract text from common Macrodroid body structures
    const smsText = typeof payload === 'string'
      ? payload
      : (payload.sms || payload.text || payload.body || payload.message || JSON.stringify(payload));

    console.log('📱 Received SMS Webhook:', smsText);

    const { rrn, amount } = extractRrnAndAmount(smsText);

    if (!rrn) {
      console.warn('⚠️ Webhook SMS could not extract 12-digit RRN/UTR');
      return res.status(400).json({ error: 'Could not extract valid RRN/UTR from SMS body', smsText });
    }

    console.log(`🔎 Extracted RRN: ${rrn}, Amount Received: ${amount !== null ? amount : 'Not specified'}`);

    // Query pending transactions for this UTR that are waiting for verification or partial paid
    const txResult = await pool.query(
      "SELECT * FROM pending_transactions WHERE utr = $1 AND status IN ('pending_verification', 'partial_paid')",
      [rrn]
    );

    if (txResult.rows.length === 0) {
      console.log(`ℹ️ No pending transaction matching UTR: ${rrn}`);
      return res.status(200).json({
        success: false,
        message: 'No pending transaction found matching this UTR',
        rrn,
        amount
      });
    }

    const pendingTx = txResult.rows[0];
    const intent = pendingTx.intent; // 'license' or 'course'
    const telegramId = pendingTx.telegram_id;

    // Get expected target price from admin settings
    const priceSettingKey = intent === 'course' ? 'course_price' : 'license_price';
    const targetPriceStr = await getSetting(priceSettingKey, '0');
    const targetPrice = parseFloat(targetPriceStr) || 0;

    const currentPaid = parseFloat(pendingTx.paid_amount || 0);
    const newPayment = amount !== null ? amount : targetPrice; // Fallback to target price if SMS did not specify amount
    const totalPaid = currentPaid + newPayment;

    // Handle Partial Payment
    if (totalPaid < targetPrice) {
      const remaining = targetPrice - totalPaid;
      await pool.query(
        "UPDATE pending_transactions SET paid_amount = $1, status = 'partial_paid', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [totalPaid, pendingTx.id]
      );

      if (bot && telegramId) {
        const msgText = `⚠️ *Partial Payment Received*\n\n` +
          `💰 Received Amount: *Rs. ${newPayment.toFixed(2)}*\n` +
          `💵 Total Paid So Far: *Rs. ${totalPaid.toFixed(2)}*\n` +
          `🎯 Required Price: *Rs. ${targetPrice.toFixed(2)}*\n` +
          `🔻 Remaining Balance: *Rs. ${remaining.toFixed(2)}*\n\n` +
          `Please pay the remaining amount of *Rs. ${remaining.toFixed(2)}* and resubmit your UTR.`;
        bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err.message));
      }

      return res.status(200).json({
        success: true,
        status: 'partial_paid',
        paid_amount: totalPaid,
        remaining_amount: remaining
      });
    }

    // Full Payment Verified!
    await pool.query(
      "UPDATE pending_transactions SET paid_amount = $1, status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
      [totalPaid, pendingTx.id]
    );

    if (intent === 'license') {
      // Generate Key for User
      const newKey = generateLicenseKey();
      await pool.query(
        "INSERT INTO licenses (key, status, telegram_id) VALUES ($1, 'unused', $2)",
        [newKey, telegramId]
      );

      if (bot && telegramId) {
        const msgText = `🎉 *Payment Verified Successfully!*\n\n` +
          `Thank you for your purchase. Here is your Extension License Key:\n\n` +
          `\`${newKey}\`\n\n` +
          `You can activate this key in the extension. View your keys anytime under the *My Key* menu option.`;
        bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err.message));
      }
    } else if (intent === 'course') {
      // Create single-use invite link for private channel
      const courseChannelId = (await getSetting('course_channel_id', '')) || process.env.FORCE_JOIN_CHANNEL_ID || '';
      let inviteLinkUrl = '';

      if (bot && courseChannelId) {
        try {
          const invite = await bot.createChatInviteLink(courseChannelId, {
            member_limit: 1,
            expire_date: Math.floor(Date.now() / 1000) + (86400 * 7) // 7 days expiration
          });
          inviteLinkUrl = invite.invite_link;
        } catch (inviteErr) {
          console.error('Error generating course channel invite link:', inviteErr.message);
        }
      }

      if (bot && telegramId) {
        let msgText = `🎉 *Payment Verified Successfully!*\n\n` +
          `Welcome to the *Learn Website Creation with AI* course!`;

        if (inviteLinkUrl) {
          msgText += `\n\nHere is your private, single-use channel invite link:\n${inviteLinkUrl}`;
        } else {
          msgText += `\n\nPlease contact support to get added to the private course channel.`;
        }

        bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err.message));
      }
    }

    return res.status(200).json({
      success: true,
      status: 'verified',
      intent,
      utr: rrn,
      total_paid: totalPaid
    });

  } catch (error) {
    console.error('Error handling payment SMS webhook:', error);
    return res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

// --- Telegram Bot Implementation ---
let bot = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  bot.on('polling_error', (error) => {
    console.error('Telegram bot polling error:', error.message);
  });

  // --- Mandatory Channel Verification Helper ---
  async function checkUserMembership(userId) {
    if (isAuthorizedAdmin(userId)) return true;

    const channelId = (await getSetting('force_join_channel_id', '')) || process.env.FORCE_JOIN_CHANNEL_ID || process.env.FORCE_JOIN_CHANNEL;
    if (!channelId) return true; // Verification not configured

    try {
      const member = await bot.getChatMember(channelId, userId);
      const validStatuses = ['creator', 'administrator', 'member'];
      return validStatuses.includes(member.status);
    } catch (err) {
      console.warn(`Could not verify channel membership for user ${userId}:`, err.message);
      // If channel ID check fails due to bot not being admin in channel, allow passage or log
      return true;
    }
  }

  async function sendForceJoinPrompt(chatId) {
    const channelLink = (await getSetting('force_join_channel_link', '')) || process.env.FORCE_JOIN_CHANNEL_LINK || 'https://t.me';

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📢 Join Channel to Continue', url: channelLink }],
          [{ text: '✅ Verify Membership', callback_data: 'verify_membership' }]
        ]
      }
    };

    const text = `⚠️ *Mandatory Channel Verification Required*\n\n` +
      `To access this bot, you must join our official Telegram channel.\n\n` +
      `1. Click *Join Channel to Continue* below.\n` +
      `2. After joining, click *Verify Membership*.`;

    return bot.sendMessage(chatId, text, opts);
  }

  // --- Main User Menu Helper ---
  async function sendMainUserMenu(chatId) {
    const customWelcome = await getSetting('welcome_msg', 'Welcome! Choose an option from the menu below:');

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔑 Buy Key', callback_data: 'user_buy_key' },
            { text: '🎓 Learn website creation with AI', callback_data: 'user_buy_course' }
          ],
          [
            { text: '📦 Download Extension', callback_data: 'user_download_ext' },
            { text: '📖 How to Use', callback_data: 'user_how_to_use' }
          ],
          [
            { text: '💬 Support', callback_data: 'user_support' },
            { text: '🔐 My Key', callback_data: 'user_my_key' }
          ]
        ]
      }
    };

    return bot.sendMessage(chatId, `🤖 *Main Menu*\n\n${customWelcome}`, opts);
  }

  // --- Admin Menu Helper ---
  async function sendAdminPanel(chatId) {
    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Set Welcome Message', callback_data: 'admin_set_welcome' }],
          [{ text: '💳 Set License Payment Info', callback_data: 'admin_set_license_pay' }],
          [{ text: '🎓 Set Course Payment Info', callback_data: 'admin_set_course_pay' }],
          [{ text: '📦 Upload Extension (.zip)', callback_data: 'admin_upload_ext' }],
          [{ text: '📖 Set "How to Use" Msg', callback_data: 'admin_set_how_to_use' }],
          [
            { text: '➕ Generate New Key', callback_data: 'admin_new_key' },
            { text: '📊 Key Statistics', callback_data: 'admin_key_stats' }
          ]
        ]
      }
    };

    return bot.sendMessage(chatId, `⚙️ *Admin Management Panel*\n\nSelect an option below to manage bot settings or keys:`, opts);
  }

  // --- Callback Query Listener ---
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    const userId = query.from.id;

    bot.answerCallbackQuery(query.id).catch(() => {});

    // Verification Callback
    if (data === 'verify_membership') {
      const isMember = await checkUserMembership(userId);
      if (isMember) {
        bot.sendMessage(chatId, '✅ *Verification Successful!* Access granted.', { parse_mode: 'Markdown' });
        return sendMainUserMenu(chatId);
      } else {
        return bot.sendMessage(
          chatId,
          '❌ *Verification Failed!* You have not joined the channel yet. Please join and try again.',
          { parse_mode: 'Markdown' }
        );
      }
    }

    // Check membership for all non-admin user callback buttons
    if (!isAuthorizedAdmin(userId)) {
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }
    }

    // --- User Callback Handlers ---
    if (data === 'user_buy_key') {
      const price = await getSetting('license_price', '0');
      const upiId = await getSetting('license_upi_id', 'Not Set');
      const qrPhoto = await getSetting('license_qr_file_id', '');
      const customMsg = await getSetting('license_custom_msg', 'Scan the QR code or send payment to the UPI ID.');

      userStates[chatId] = { action: 'awaiting_utr', intent: 'license' };

      const caption = `🔑 *Buy Extension License Key*\n\n` +
        `💰 *Price:* Rs. ${price}\n` +
        `🆔 *UPI ID:* \`${upiId}\`\n\n` +
        `${customMsg}\n\n` +
        `👇 *After payment, reply with your 12-digit UTR (RRN) number.*`;

      if (qrPhoto) {
        return bot.sendPhoto(chatId, qrPhoto, { caption, parse_mode: 'Markdown' }).catch(() => {
          bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
        });
      } else {
        return bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
      }
    }

    if (data === 'user_buy_course') {
      const price = await getSetting('course_price', '0');
      const upiId = await getSetting('course_upi_id', 'Not Set');
      const qrPhoto = await getSetting('course_qr_file_id', '');
      const customMsg = await getSetting('course_custom_msg', 'Scan the QR code or pay via UPI to enroll.');

      userStates[chatId] = { action: 'awaiting_utr', intent: 'course' };

      const caption = `🎓 *Learn Website Creation with AI Course*\n\n` +
        `💰 *Price:* Rs. ${price}\n` +
        `🆔 *UPI ID:* \`${upiId}\`\n\n` +
        `${customMsg}\n\n` +
        `👇 *After payment, reply with your 12-digit UTR (RRN) number.*`;

      if (qrPhoto) {
        return bot.sendPhoto(chatId, qrPhoto, { caption, parse_mode: 'Markdown' }).catch(() => {
          bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
        });
      } else {
        return bot.sendMessage(chatId, caption, { parse_mode: 'Markdown' });
      }
    }

    if (data === 'user_download_ext') {
      const extFileId = await getSetting('extension_file_id', '');
      if (extFileId) {
        return bot.sendDocument(chatId, extFileId, { caption: '📦 *Extension Zip File*', parse_mode: 'Markdown' });
      } else {
        return bot.sendMessage(chatId, '⚠️ Extension package is not currently available for download. Please check back later.');
      }
    }

    if (data === 'user_how_to_use') {
      const guideText = await getSetting('how_to_use_msg', '📖 *How to Use Guide:*\n\n1. Download the extension zip.\n2. Load unpacked in Chrome extensions.\n3. Buy a license key and activate it inside the extension sidepanel.');
      return bot.sendMessage(chatId, guideText, { parse_mode: 'Markdown' });
    }

    if (data === 'user_support') {
      const supportUser = (await getSetting('support_username', '')) || process.env.SUPPORT_USERNAME || '@support';
      const cleanSupport = supportUser.startsWith('@') ? supportUser : `@${supportUser}`;
      return bot.sendMessage(
        chatId,
        `💬 *Customer Support*\n\nFor assistance or issues, please contact our support team:\n👉 ${cleanSupport}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'user_my_key') {
      try {
        const res = await pool.query(
          'SELECT key, status, created_at FROM licenses WHERE telegram_id = $1 ORDER BY id DESC',
          [String(chatId)]
        );

        if (res.rows.length === 0) {
          return bot.sendMessage(chatId, '❌ No license keys associated with your Telegram account.');
        }

        let reply = `🔐 *Your License Keys:*\n\n`;
        res.rows.forEach((row, idx) => {
          reply += `${idx + 1}. \`${row.key}\` (Status: *${row.status}*)\n`;
        });

        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error fetching user keys:', err);
        return bot.sendMessage(chatId, '❌ Failed to fetch your license keys.');
      }
    }

    // --- Admin Callback Handlers ---
    if (!isAuthorizedAdmin(userId)) return;

    if (data === 'admin_set_welcome') {
      adminStates[chatId] = { action: 'awaiting_welcome_msg' };
      return bot.sendMessage(chatId, '📝 *Please send the new Custom Welcome Message:*', { parse_mode: 'Markdown' });
    }

    if (data === 'admin_set_license_pay') {
      adminStates[chatId] = { action: 'awaiting_license_pay_info' };
      return bot.sendMessage(
        chatId,
        `💳 *Set License Payment Info*\n\nPlease reply with text in this format:\n\n\`UPI_ID | Price | Custom Message\`\n\nExample:\n\`pay@upi | 499 | Instant key delivery after payment.\`\n\n*(To update the QR Code photo, send an image in your next message)*`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_set_course_pay') {
      adminStates[chatId] = { action: 'awaiting_course_pay_info' };
      return bot.sendMessage(
        chatId,
        `🎓 *Set Course Payment Info*\n\nPlease reply with text in this format:\n\n\`UPI_ID | Price | Channel_ID | Custom Message\`\n\nExample:\n\`course@upi | 999 | -100123456789 | Get instant private channel invite link.\`\n\n*(To update the QR Code photo, send an image in your next message)*`,
        { parse_mode: 'Markdown' }
      );
    }

    if (data === 'admin_upload_ext') {
      adminStates[chatId] = { action: 'awaiting_extension_file' };
      return bot.sendMessage(chatId, '📦 *Please upload the Extension .zip file now:*', { parse_mode: 'Markdown' });
    }

    if (data === 'admin_set_how_to_use') {
      adminStates[chatId] = { action: 'awaiting_how_to_use_msg' };
      return bot.sendMessage(chatId, '📖 *Please send the new "How to Use" guide message:*', { parse_mode: 'Markdown' });
    }

    if (data === 'admin_new_key') {
      try {
        const key = generateLicenseKey();
        await pool.query('INSERT INTO licenses (key, status) VALUES ($1, $2)', [key, 'unused']);
        return bot.sendMessage(chatId, `✅ *New License Key Generated:*\n\n\`${key}\`\n\nStatus: \`unused\``, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error generating key:', err);
        return bot.sendMessage(chatId, '❌ Failed to generate key due to database error.');
      }
    }

    if (data === 'admin_key_stats') {
      try {
        const result = await pool.query(
          'SELECT status, COUNT(*)::int as count FROM licenses GROUP BY status'
        );
        const counts = { active: 0, unused: 0, revoked: 0 };
        let total = 0;
        result.rows.forEach(r => {
          counts[r.status] = parseInt(r.count, 10);
          total += parseInt(r.count, 10);
        });
        const reply = `📊 *License Key Statistics:*\n\n🟢 *Active:* ${counts.active || 0}\n🟡 *Unused:* ${counts.unused || 0}\n🔴 *Revoked:* ${counts.revoked || 0}\n\n📦 *Total Keys:* ${total}`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error getting stats:', err);
        return bot.sendMessage(chatId, '❌ Failed to query key statistics.');
      }
    }
  });

  // --- Document Listener for Extension Upload ---
  bot.on('document', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorizedAdmin(msg)) return;

    const state = adminStates[chatId];
    if (state && state.action === 'awaiting_extension_file') {
      const fileId = msg.document.file_id;
      const fileName = msg.document.file_name || 'extension.zip';

      await setSetting('extension_file_id', fileId);
      delete adminStates[chatId];

      return bot.sendMessage(chatId, `✅ *Extension file standard saved successfully!*\n\nFile Name: \`${fileName}\`\nFile ID: \`${fileId}\``, { parse_mode: 'Markdown' });
    }
  });

  // --- Photo Listener for Admin QR Uploads ---
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorizedAdmin(msg)) return;

    const state = adminStates[chatId];
    if (!state) return;

    // Largest photo size is last in array
    const photos = msg.photo;
    const fileId = photos[photos.length - 1].file_id;

    if (state.action === 'awaiting_license_pay_info') {
      await setSetting('license_qr_file_id', fileId);
      return bot.sendMessage(chatId, `✅ *License QR Code photo saved successfully!*`, { parse_mode: 'Markdown' });
    }

    if (state.action === 'awaiting_course_pay_info') {
      await setSetting('course_qr_file_id', fileId);
      return bot.sendMessage(chatId, `✅ *Course QR Code photo saved successfully!*`, { parse_mode: 'Markdown' });
    }
  });

  // --- Main Message Listener ---
  bot.on('message', async (msg) => {
    if (!msg.text) return;
    const text = msg.text.trim();
    const chatId = msg.chat.id;
    const userId = msg.from ? msg.from.id : chatId;
    const isAdmin = isAuthorizedAdmin(msg);

    // Command: /start
    if (text.startsWith('/start')) {
      if (isAdmin) {
        const helpMsg = `🤖 *License Admin Management Bot*\n\n` +
          `Available Commands:\n` +
          `• \`/start\` - Help message\n` +
          `• \`/admin\` - Open Admin Panel\n` +
          `• \`/newkey\` - Generate a new license key\n` +
          `• \`/list\` - Key statistics\n` +
          `• \`/revoke [key]\` - Revoke a license key`;
        return bot.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
      }

      // Non-admin user membership check
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }

      return sendMainUserMenu(chatId);
    }

    // Command: /admin
    if (text.startsWith('/admin')) {
      if (!isAdmin) return;
      return sendAdminPanel(chatId);
    }

    // Command: /newkey
    if (text.startsWith('/newkey') && isAdmin) {
      try {
        const key = generateLicenseKey();
        await pool.query('INSERT INTO licenses (key, status) VALUES ($1, $2)', [key, 'unused']);
        return bot.sendMessage(chatId, `✅ *New License Key Generated:*\n\n\`${key}\`\n\nStatus: \`unused\``, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error generating key:', err);
        return bot.sendMessage(chatId, '❌ Failed to generate key due to a database error.');
      }
    }

    // Command: /list
    if (text.startsWith('/list') && isAdmin) {
      try {
        const result = await pool.query('SELECT status, COUNT(*)::int as count FROM licenses GROUP BY status');
        const counts = { active: 0, unused: 0, revoked: 0 };
        let total = 0;
        result.rows.forEach((row) => {
          counts[row.status] = parseInt(row.count, 10);
          total += parseInt(row.count, 10);
        });
        const reply = `📊 *License Key Statistics:*\n\n🟢 *Active:* ${counts.active || 0}\n🟡 *Unused:* ${counts.unused || 0}\n🔴 *Revoked:* ${counts.revoked || 0}\n\n📦 *Total Keys:* ${total}`;
        return bot.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error querying list:', err);
        return bot.sendMessage(chatId, '❌ Failed to fetch key statistics.');
      }
    }

    // Command: /revoke [key]
    if (text.startsWith('/revoke') && isAdmin) {
      const parts = text.split(/\s+/);
      const keyToRevoke = parts[1] ? parts[1].trim() : null;

      if (!keyToRevoke) {
        return bot.sendMessage(chatId, '⚠️ Please provide a key to revoke.\nExample: `/revoke ATM-PUM8-ALT2-XJ6G-FMBX`', { parse_mode: 'Markdown' });
      }

      try {
        const result = await pool.query("UPDATE licenses SET status = 'revoked' WHERE key = $1 RETURNING *", [keyToRevoke]);
        if (result.rowCount > 0) {
          return bot.sendMessage(chatId, `🛑 License key \`${keyToRevoke}\` has been successfully *revoked*.`, { parse_mode: 'Markdown' });
        } else {
          return bot.sendMessage(chatId, `❌ License key \`${keyToRevoke}\` was not found.`, { parse_mode: 'Markdown' });
        }
      } catch (err) {
        console.error('Error revoking key:', err);
        return bot.sendMessage(chatId, '❌ Database error while revoking key.');
      }
    }

    // --- Admin Input State Machine ---
    if (isAdmin && adminStates[chatId]) {
      const state = adminStates[chatId];

      if (state.action === 'awaiting_welcome_msg') {
        await setSetting('welcome_msg', text);
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ *Welcome Message updated successfully!*', { parse_mode: 'Markdown' });
      }

      if (state.action === 'awaiting_how_to_use_msg') {
        await setSetting('how_to_use_msg', text);
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ *"How to Use" guide message updated successfully!*', { parse_mode: 'Markdown' });
      }

      if (state.action === 'awaiting_license_pay_info') {
        const parts = text.split('|').map(s => s.trim());
        if (parts.length >= 2) {
          await setSetting('license_upi_id', parts[0]);
          await setSetting('license_price', parts[1]);
          if (parts[2]) await setSetting('license_custom_msg', parts[2]);
          delete adminStates[chatId];
          return bot.sendMessage(
            chatId,
            `✅ *License Payment Info updated!*\n\nUPI ID: \`${parts[0]}\`\nPrice: \`Rs. ${parts[1]}\`\nCustom Msg: \`${parts[2] || 'Default'}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          return bot.sendMessage(chatId, '⚠️ Invalid format. Use: `UPI_ID | Price | Custom Message`');
        }
      }

      if (state.action === 'awaiting_course_pay_info') {
        const parts = text.split('|').map(s => s.trim());
        if (parts.length >= 3) {
          await setSetting('course_upi_id', parts[0]);
          await setSetting('course_price', parts[1]);
          await setSetting('course_channel_id', parts[2]);
          if (parts[3]) await setSetting('course_custom_msg', parts[3]);
          delete adminStates[chatId];
          return bot.sendMessage(
            chatId,
            `✅ *Course Payment Info updated!*\n\nUPI ID: \`${parts[0]}\`\nPrice: \`Rs. ${parts[1]}\`\nChannel ID: \`${parts[2]}\`\nCustom Msg: \`${parts[3] || 'Default'}\``,
            { parse_mode: 'Markdown' }
          );
        } else {
          return bot.sendMessage(chatId, '⚠️ Invalid format. Use: `UPI_ID | Price | Channel_ID | Custom Message`');
        }
      }
    }

    // --- Non-Admin User Channel Membership Check for General Messages ---
    if (!isAdmin) {
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }
    }

    // --- Extract User UTR Submissions ---
    const extractedUtr = extractUtrFromUserText(text);
    if (extractedUtr) {
      // Check if user is in userStates or if text is a standalone UTR submission
      const userState = userStates[chatId] || { intent: 'license' };
      const intent = userState.intent || 'license';

      try {
        // Check if UTR already exists in DB
        const existingTx = await pool.query('SELECT * FROM pending_transactions WHERE utr = $1', [extractedUtr]);

        if (existingTx.rows.length > 0) {
          const tx = existingTx.rows[0];
          if (tx.status === 'verified') {
            return bot.sendMessage(
              chatId,
              `❌ *This UTR (${extractedUtr}) has already been verified and claimed.*`,
              { parse_mode: 'Markdown' }
            );
          } else if (tx.status === 'pending_verification') {
            return bot.sendMessage(
              chatId,
              `⏳ *Payment verification is already in progress for UTR (${extractedUtr}). Please wait up to 2 minutes...*`,
              { parse_mode: 'Markdown' }
            );
          }
        }

        // Insert new pending transaction
        const targetPriceStr = await getSetting(intent === 'course' ? 'course_price' : 'license_price', '0');
        const targetPrice = parseFloat(targetPriceStr) || 0;

        await pool.query(
          `INSERT INTO pending_transactions (telegram_id, intent, utr, amount, paid_amount, status)
           VALUES ($1, $2, $3, $4, 0, 'pending_verification')
           ON CONFLICT (utr) DO UPDATE SET telegram_id = EXCLUDED.telegram_id, intent = EXCLUDED.intent, status = 'pending_verification'`,
          [String(chatId), intent, extractedUtr, targetPrice]
        );

        delete userStates[chatId];

        return bot.sendMessage(
          chatId,
          `⏳ *Payment is verifying for UTR: \`${extractedUtr}\`. Please wait up to 2 minutes...*`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error('Error saving pending transaction UTR:', err);
        return bot.sendMessage(chatId, '❌ Failed to process your UTR submission. Please try again.');
      }
    }
  });

  console.log('🤖 Telegram Bot started with Channel Verification & Payment Paywall support.');
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
