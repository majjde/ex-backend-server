const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

const { pool, initDb, getSetting, setSetting, getAllSettings, getAdminKeyStats, getActiveLicensesWithUsers } = require('./db');
const { generateLicenseKey, generateTrialKey } = require('./keyGenerator');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'apikey', 'x-api-key', 'Authorization', 'x-macrodroid-secret', 'macrodroid-secret'],
  credentials: true
}));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Admin Authorization Helper ---
function isAuthorizedAdmin(msgOrId) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!adminId) {
    return false;
  }
  const targetAdminId = String(adminId).trim();

  let chatId = null;
  if (typeof msgOrId === 'object' && msgOrId !== null) {
    chatId = String(msgOrId.chat ? msgOrId.chat.id : (msgOrId.from ? msgOrId.from.id : ''));
  } else {
    chatId = String(msgOrId).trim();
  }

  return chatId === targetAdminId;
}

// --- Admin Telegram Notification Helper ---
// Escape special Markdown characters in user-provided strings
function escapeMd(str) {
  if (!str) return '';
  return String(str).replace(/[_*[\]()~`>#+\-=|{}.!]/g, '\\$&');
}

async function notifyAdmin(msgText) {
  const adminId = process.env.ADMIN_CHAT_ID;
  if (!bot || !adminId || !String(adminId).trim()) return;
  try {
    await bot.sendMessage(String(adminId).trim(), msgText, { parse_mode: 'Markdown' });
  } catch (err) {
    console.error('Error sending admin notification:', err?.message || err);
    // Retry without parse_mode if Markdown parsing fails
    try {
      const plainText = msgText.replace(/[*`_~]/g, '');
      await bot.sendMessage(String(adminId).trim(), plainText);
    } catch (retryErr) {
      console.error('Error sending admin notification (plain retry):', retryErr?.message || retryErr);
    }
  }
}

function notifyAdminPaymentSession(fromUser, productName) {
  if (!fromUser) return;
  // Escape user-provided strings to prevent Markdown parse errors
  const usernameStr = fromUser.username ? `@${escapeMd(fromUser.username)}` : 'None';
  const fullName = escapeMd([fromUser.first_name, fromUser.last_name].filter(Boolean).join(' ') || 'N/A');
  const timeStr = new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }) + ' IST';

  const notice = `💳 *Payment Session Initiated*\n\n` +
    `👤 *Telegram Username:* ${usernameStr}\n` +
    `📛 *Full Name:* ${fullName}\n` +
    `🆔 *Telegram User ID:* \`${fromUser.id}\`\n` +
    `📦 *Selected Product:* ${productName}\n` +
    `⏰ *Timestamp:* ${timeStr}`;
  notifyAdmin(notice);
}

// --- Regex Helpers for SMS & UTR Extraction ---
function extractRrnAndAmount(smsText) {
  if (!smsText || typeof smsText !== 'string') {
    return { rrn: null, amount: null };
  }

  let rrnMatch = smsText.match(/RRN-?\s*(\d{12})/i) ||
                 smsText.match(/UTR-?\s*(\d{12})/i) ||
                 smsText.match(/Ref-?\s*(\d{12})/i) ||
                 smsText.match(/\b(\d{12})\b/);

  const rrn = rrnMatch ? rrnMatch[1] : null;

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
const adminStates = {};
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
        status: 'active',
        is_trial: license.is_trial === true,
        remaining_prompts: license.remaining_prompts
      });
    }

    // Check status: Active -> Verify hardware fingerprint and user device
    if (license.status === 'active') {
      if (license.is_trial && (license.remaining_prompts ?? 0) <= 0) {
        return res.status(401).json({ error: 'This key is used , get a new one' });
      }

      if (license.hw_fingerprint) {
        if (requestFingerprint && license.hw_fingerprint !== requestFingerprint) {
          return res.status(401).json({ error: 'Key already bound to another machine/device' });
        }
      } else if (requestFingerprint) {
        await pool.query(
          "UPDATE licenses SET hw_fingerprint = $1 WHERE key = $2",
          [requestFingerprint, cleanKey]
        );
      }

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
          status: 'active',
          is_trial: license.is_trial === true,
          remaining_prompts: license.remaining_prompts
        });
      } else {
        return res.status(401).json({ error: 'Key already bound to another user session' });
      }
    }

    return res.status(401).json({ error: 'Invalid or revoked key' });
  } catch (error) {
    console.error('Error during license activation:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Trial key prompt usage endpoint (/api/trial/use)
app.post('/api/trial/use', async (req, res) => {
  try {
    const expectedApiKey = process.env.EXTENSION_API_KEY || 'freeflow-be-key-2008';
    const apiKey = req.headers.apikey || req.headers['apikey'] || req.headers['x-api-key'];
    if (!apiKey || apiKey !== expectedApiKey) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }

    const { license_key } = req.body || {};
    if (!license_key || !String(license_key).trim()) {
      return res.status(400).json({ error: 'Missing required parameter: license_key' });
    }

    const cleanKey = String(license_key).trim();
    const row = await pool.query('SELECT * FROM licenses WHERE key = $1', [cleanKey]);
    if (row.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }
    const lic = row.rows[0];
    if (!lic.is_trial) {
      return res.status(400).json({ error: 'Not a trial key' });
    }
    if ((lic.remaining_prompts ?? 0) <= 0) {
      return res.status(402).json({ can_send: false, error: 'This key is used , get a new one' });
    }
    await pool.query('UPDATE licenses SET remaining_prompts = 0 WHERE key = $1', [cleanKey]);
    return res.status(200).json({ can_send: true, remaining_prompts: 0 });
  } catch (error) {
    console.error('Error in /api/trial/use:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Get tab visibility settings endpoint (/api/tab-settings)
app.get('/api/tab-settings', async (req, res) => {
  try {
    const showFreeTrial = (await getSetting('tab_show_free_trial', 'true')) === 'true';
    const showBuyKey = (await getSetting('tab_show_buy_key', 'true')) === 'true';
    const showCourse = (await getSetting('tab_show_course', 'true')) === 'true';
    const showDownloadExt = (await getSetting('tab_show_download_ext', 'true')) === 'true';
    const showHowToUse = (await getSetting('tab_show_how_to_use', 'true')) === 'true';
    const showSupport = (await getSetting('tab_show_support', 'true')) === 'true';
    const showMyKey = (await getSetting('tab_show_my_key', 'true')) === 'true';

    return res.status(200).json({
      success: true,
      tabs: {
        free_trial: showFreeTrial,
        buy_key: showBuyKey,
        course: showCourse,
        download_ext: showDownloadExt,
        how_to_use: showHowToUse,
        support: showSupport,
        my_key: showMyKey
      }
    });
  } catch (error) {
    console.error('Error in /api/tab-settings:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Macrodroid Payment SMS Webhook Endpoint (/api/payment-sms)
app.post('/api/payment-sms', async (req, res) => {
  try {
    // 1. Strict Webhook Authorization Check via MACRODROID_SECRET
    const expectedMacrodroidSecret = process.env.MACRODROID_SECRET;
    if (expectedMacrodroidSecret && String(expectedMacrodroidSecret).trim() !== '') {
      const clientSecret = req.headers['x-macrodroid-secret'] ||
                           req.headers['macrodroid-secret'] ||
                           req.headers['authorization'] ||
                           req.query.secret ||
                           (req.body && req.body.secret);

      if (!clientSecret || String(clientSecret).trim() !== String(expectedMacrodroidSecret).trim()) {
        console.warn('⚠️ Webhook unauthorized: Invalid or missing MACRODROID_SECRET');
        return res.status(401).json({ error: 'Unauthorized: Invalid Macrodroid secret' });
      }
    }

    const payload = req.body || {};
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

    // --- Core payment fulfillment logic (shared by webhook & UTR submission) ---
    async function fulfillPayment(pendingTx, receivedAmount, rrn) {
      const intent = pendingTx.intent;
      const telegramId = pendingTx.telegram_id;
      const priceSettingKey = intent === 'course' ? 'course_price' : 'license_price';
      const targetPriceStr = await getSetting(priceSettingKey, '0');
      const targetPrice = parseFloat(targetPriceStr) || 0;

      const currentPaid = parseFloat(pendingTx.paid_amount || 0);
      const newPayment = receivedAmount !== null ? receivedAmount : targetPrice;
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
          bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err?.message || err));
        }
        return { status: 'partial_paid', paid_amount: totalPaid, remaining_amount: remaining };
      }

      // Full Payment Verified!
      await pool.query(
        "UPDATE pending_transactions SET paid_amount = $1, status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
        [totalPaid, pendingTx.id]
      );

      if (intent === 'license') {
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
          bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err?.message || err));
        }

        const adminMsg = `✅ *Payment Verification Success*\n\n` +
          `👤 *Telegram ID:* \`${telegramId}\`\n` +
          `📦 *Product:* Extension License Key\n` +
          `💳 *UTR:* \`${rrn}\`\n` +
          `💰 *Amount Paid:* Rs. ${totalPaid.toFixed(2)}\n` +
          `🔑 *Generated Key:* \`${newKey}\``;
        notifyAdmin(adminMsg);
        return { status: 'verified', intent, utr: rrn, total_paid: totalPaid };

      } else if (intent === 'course') {
        const courseChannelId = (await getSetting('course_channel_id', '')) || process.env.FORCE_JOIN_CHANNEL_ID || '';
        let inviteLinkUrl = '';

        if (bot && courseChannelId) {
          try {
            const invite = await bot.createChatInviteLink(courseChannelId, {
              member_limit: 1,
              expire_date: Math.floor(Date.now() / 1000) + (86400 * 7)
            });
            inviteLinkUrl = invite.invite_link;
          } catch (inviteErr) {
            console.error('Error generating course channel invite link:', inviteErr?.message || inviteErr);
          }
        }

        if (bot && telegramId) {
          let msgText = `🎉 *Payment Verified Successfully!*\n\n` +
            `Welcome to the *Learn Website Creation with AI* course!`;
          if (inviteLinkUrl) {
            msgText += `\n\nHere is your private, single\-use channel invite link:\n${inviteLinkUrl}`;
          } else {
            msgText += `\n\nPlease contact support to get added to the private course channel.`;
          }
          bot.sendMessage(telegramId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err?.message || err));
        }

        const adminMsg = `✅ *Payment Verification Success*\n\n` +
          `👤 *Telegram ID:* \`${telegramId}\`\n` +
          `📦 *Product:* Learn Website Creation with AI Course\n` +
          `💳 *UTR:* \`${rrn}\`\n` +
          `💰 *Amount Paid:* Rs. ${totalPaid.toFixed(2)}`;
        notifyAdmin(adminMsg);
        return { status: 'verified', intent, utr: rrn, total_paid: totalPaid };
      }

      return { status: 'verified', intent, utr: rrn, total_paid: totalPaid };
    }

    const txResult = await pool.query(
      "SELECT * FROM pending_transactions WHERE utr = $1 AND status IN ('pending_verification', 'partial_paid')",
      [rrn]
    );

    if (txResult.rows.length === 0) {
      // No pending transaction yet — store the received SMS payment for later matching
      // when user submits UTR via bot
      console.log(`ℹ️ No pending transaction matching UTR: ${rrn}. Storing received payment for later matching.`);
      try {
        await pool.query(
          `INSERT INTO received_sms_payments (rrn, amount, sms_text, received_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
           ON CONFLICT (rrn) DO UPDATE SET amount = EXCLUDED.amount, sms_text = EXCLUDED.sms_text, received_at = CURRENT_TIMESTAMP`,
          [rrn, amount, smsText]
        );
      } catch (storeErr) {
        console.error('Error storing received SMS payment:', storeErr?.message || storeErr);
      }
      return res.status(200).json({
        success: false,
        message: 'No pending transaction found. Payment stored for matching when UTR is submitted.',
        rrn,
        amount
      });
    }

    const pendingTx = txResult.rows[0];
    const fulfillResult = await fulfillPayment(pendingTx, amount, rrn);

    return res.status(200).json({ success: true, ...fulfillResult });

  } catch (error) {
    console.error('Error handling payment SMS webhook:', error?.message || error);
    return res.status(500).json({ error: 'Internal server error processing webhook' });
  }
});

// --- Telegram Bot Implementation ---
let bot = null;

if (process.env.TELEGRAM_BOT_TOKEN) {
  bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

  // Rate-limit safe polling error handler (never log full err object)
  bot.on('polling_error', (error) => {
    console.log(error?.message || 'Telegram bot polling error');
  });

  // --- Mandatory Channel Verification Helper ---
  async function checkUserMembership(userId) {
    if (isAuthorizedAdmin(userId)) return true;

    const channelId = (await getSetting('force_join_channel_id', '')) || process.env.FORCE_JOIN_CHANNEL_ID || process.env.FORCE_JOIN_CHANNEL;
    if (!channelId) return true;

    try {
      const member = await bot.getChatMember(channelId, userId);
      const validStatuses = ['creator', 'administrator', 'member'];
      return validStatuses.includes(member.status);
    } catch (err) {
      console.warn(`Could not verify channel membership for user ${userId}:`, err?.message || err);
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

    return bot.sendMessage(chatId, text, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
  }

  // --- Support URL Helper ---
  async function getSupportUrl() {
    const supportUser = (await getSetting('support_username', '')) || process.env.SUPPORT_USERNAME || 'support';
    const cleanUsername = String(supportUser).replace(/^@/, '').trim();
    return `https://t.me/${cleanUsername}`;
  }

  // --- Main User Menu Helpers ---
  async function getMainUserKeyboard() {
    const supportUrl = await getSupportUrl();

    const showFreeTrial = (await getSetting('tab_show_free_trial', 'true')) === 'true';
    const showBuyKey = (await getSetting('tab_show_buy_key', 'true')) === 'true';
    const showCourse = (await getSetting('tab_show_course', 'true')) === 'true';
    const showDownloadExt = (await getSetting('tab_show_download_ext', 'true')) === 'true';
    const showHowToUse = (await getSetting('tab_show_how_to_use', 'true')) === 'true';
    const showSupport = (await getSetting('tab_show_support', 'true')) === 'true';
    const showMyKey = (await getSetting('tab_show_my_key', 'true')) === 'true';

    const inline_keyboard = [];

    if (showFreeTrial) {
      inline_keyboard.push([{ text: '🆓 Get Trial Key', callback_data: 'user_free_trial' }]);
    }
    if (showBuyKey) {
      inline_keyboard.push([{ text: '🔑 Buy Key', callback_data: 'user_buy_key' }]);
    }
    if (showCourse) {
      inline_keyboard.push([{ text: '🎓 Learn website creation with AI', callback_data: 'user_course_intro' }]);
    }

    const row4 = [];
    if (showDownloadExt) {
      row4.push({ text: '📥 Get Extension', callback_data: 'user_download_ext' });
    }
    if (showHowToUse) {
      row4.push({ text: '📖 How to Use', callback_data: 'user_how_to_use' });
    }
    if (row4.length > 0) {
      inline_keyboard.push(row4);
    }

    const row5 = [];
    if (showSupport) {
      row5.push({ text: '💬 Support', url: supportUrl });
    }
    if (showMyKey) {
      row5.push({ text: '🔐 My Key', callback_data: 'user_my_key' });
    }
    if (row5.length > 0) {
      inline_keyboard.push(row5);
    }

    return { inline_keyboard };
  }

  async function getMainUserText() {
    const customWelcome = await getSetting('welcome_msg', 'Welcome! Choose an option from the menu below:');
    return `🤖 *Main Menu*\n\n${customWelcome}`;
  }

  async function sendMainUserMenu(chatId) {
    const text = await getMainUserText();
    const keyboard = await getMainUserKeyboard();
    const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
    return bot.sendMessage(chatId, text, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
  }

  async function editToMainUserMenu(chatId, messageId) {
    const text = await getMainUserText();
    const keyboard = await getMainUserKeyboard();
    const opts = { parse_mode: 'Markdown', reply_markup: keyboard };
    return safeEditMessage(chatId, messageId, text, opts);
  }

  // --- Safe Dynamic Message Editing Helper ---
  async function safeEditMessage(chatId, messageId, text, opts = {}) {
    if (!bot) return;
    try {
      return await bot.editMessageText(text, {
        chat_id: chatId,
        message_id: messageId,
        ...opts
      });
    } catch (err) {
      if (err?.message && err.message.includes('message is not modified')) {
        return;
      }
      try {
        if (messageId) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
        }
      } catch (_) {}
      return await bot.sendMessage(chatId, text, opts).catch(e => console.error('Telegram sendMessage error:', e?.message || e));
    }
  }

  async function safeSendOrEditWithPhoto(chatId, messageId, caption, photoUrlOrId, opts = {}) {
    if (!bot) return;
    if (photoUrlOrId) {
      try {
        if (messageId) {
          await bot.deleteMessage(chatId, messageId).catch(() => {});
        }
      } catch (_) {}
      return await bot.sendPhoto(chatId, photoUrlOrId, { caption, ...opts }).catch(async (err) => {
        console.error('Telegram sendPhoto error, falling back to message:', err?.message || err);
        return await bot.sendMessage(chatId, caption, opts).catch(e => console.error('Telegram sendMessage error:', e?.message || e));
      });
    } else {
      return safeEditMessage(chatId, messageId, caption, opts);
    }
  }

  // --- Admin Menu Helper ---
  async function sendAdminPanel(chatId, messageId = null) {
    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📝 Set Welcome Message', callback_data: 'admin_set_welcome' }],
          [{ text: '💳 Set License Payment Info', callback_data: 'admin_set_license_pay' }],
          [{ text: '🎓 Set Course Payment Info', callback_data: 'admin_set_course_pay' }],
          [{ text: '🎓 Set Course Intro Msg', callback_data: 'admin_set_course_intro' }],
          [{ text: '📦 Upload Extension (.zip)', callback_data: 'admin_upload_ext' }],
          [{ text: '📖 Set "How to Use" Msg', callback_data: 'admin_set_how_to_use' }],
          [{ text: '🎛️ Toggle User Tabs', callback_data: 'admin_toggle_tabs' }],
          [
            { text: '➕ Generate New Key', callback_data: 'admin_new_key' },
            { text: '📊 Key Statistics', callback_data: 'admin_key_stats' }
          ],
          [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
        ]
      }
    };

    const text = `⚙️ *Admin Management Panel*\n\nSelect an option below to manage bot settings or keys:`;
    if (messageId) {
      return safeEditMessage(chatId, messageId, text, opts);
    } else {
      return bot.sendMessage(chatId, text, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
    }
  }

  // --- Admin Tab Visibility Control Helper ---
  async function sendAdminTabToggleMenu(chatId, messageId = null) {
    const showFreeTrial = (await getSetting('tab_show_free_trial', 'true')) === 'true';
    const showBuyKey = (await getSetting('tab_show_buy_key', 'true')) === 'true';
    const showCourse = (await getSetting('tab_show_course', 'true')) === 'true';
    const showDownloadExt = (await getSetting('tab_show_download_ext', 'true')) === 'true';
    const showHowToUse = (await getSetting('tab_show_how_to_use', 'true')) === 'true';
    const showSupport = (await getSetting('tab_show_support', 'true')) === 'true';
    const showMyKey = (await getSetting('tab_show_my_key', 'true')) === 'true';

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `🆓 Trial Key: ${showFreeTrial ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_free_trial' }],
          [{ text: `🔑 Buy Key: ${showBuyKey ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_buy_key' }],
          [{ text: `🎓 Learn Course: ${showCourse ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_course' }],
          [{ text: `📥 Extension Download: ${showDownloadExt ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_download_ext' }],
          [{ text: `📖 How to Use: ${showHowToUse ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_how_to_use' }],
          [{ text: `💬 Support: ${showSupport ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_support' }],
          [{ text: `🔐 My Key: ${showMyKey ? '✅ Visible' : '❌ Hidden'}`, callback_data: 'toggle_tab_my_key' }],
          [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
        ]
      }
    };

    const text = `🎛️ *User UI Tab Visibility Control*\n\nClick any tab button below to toggle whether it is shown (✅) or hidden (❌) to final users in the bot and API:`;
    if (messageId) {
      return safeEditMessage(chatId, messageId, text, opts);
    } else {
      return bot.sendMessage(chatId, text, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
    }
  }

  // --- Callback Query Listener ---
  bot.on('callback_query', async (query) => {
    const chatId = query.message ? query.message.chat.id : query.from.id;
    const messageId = query.message ? query.message.message_id : null;
    const data = query.data;
    const userId = query.from.id;

    bot.answerCallbackQuery(query.id).catch(() => {});

    // Verification Callback
    if (data === 'verify_membership') {
      const isMember = await checkUserMembership(userId);
      if (isMember) {
        return editToMainUserMenu(chatId, messageId);
      } else {
        return safeEditMessage(
          chatId,
          messageId,
          '❌ *Verification Failed!* You have not joined the channel yet. Please join and try again.',
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '📢 Join Channel', url: (await getSetting('force_join_channel_link', '')) || process.env.FORCE_JOIN_CHANNEL_LINK || 'https://t.me' }],
                [{ text: '✅ Verify Membership', callback_data: 'verify_membership' }]
              ]
            }
          }
        );
      }
    }

    // Back to Main User Menu Callback
    if (data === 'back_to_main') {
      delete userStates[chatId];
      return editToMainUserMenu(chatId, messageId);
    }

    // Back to Admin Dashboard Callback
    if (data === 'back_to_admin') {
      delete adminStates[chatId];
      if (isAuthorizedAdmin(userId)) {
        return sendAdminPanel(chatId, messageId);
      } else {
        return editToMainUserMenu(chatId, messageId);
      }
    }

    // Cancel Payment Callback
    if (data === 'cancel_payment') {
      delete userStates[chatId];
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };
      return safeEditMessage(chatId, messageId, 'Transaction canceled.', opts);
    }

    // Admin Toggle User Tabs Submenu Callback
    if (data === 'admin_toggle_tabs') {
      if (!isAuthorizedAdmin(userId)) return;
      return sendAdminTabToggleMenu(chatId, messageId);
    }

    // Toggle specific tab callback
    if (data.startsWith('toggle_tab_')) {
      if (!isAuthorizedAdmin(userId)) return;
      const tabName = data.replace('toggle_tab_', '');
      const keyMap = {
        'free_trial': 'tab_show_free_trial',
        'buy_key': 'tab_show_buy_key',
        'course': 'tab_show_course',
        'download_ext': 'tab_show_download_ext',
        'how_to_use': 'tab_show_how_to_use',
        'support': 'tab_show_support',
        'my_key': 'tab_show_my_key'
      };

      const settingKey = keyMap[tabName];
      if (settingKey) {
        const currentVal = await getSetting(settingKey, 'true');
        const newVal = currentVal === 'true' ? 'false' : 'true';
        await setSetting(settingKey, newVal);
      }
      return sendAdminTabToggleMenu(chatId, messageId);
    }

    // Check membership for all non-admin user callback buttons
    if (!isAuthorizedAdmin(userId)) {
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }
    }

    // Guard: Verify if targeted tab is enabled before serving user callbacks
    const tabCheckMap = {
      'user_free_trial': 'tab_show_free_trial',
      'user_buy_key': 'tab_show_buy_key',
      'user_course_intro': 'tab_show_course',
      'user_buy_course': 'tab_show_course',
      'user_download_ext': 'tab_show_download_ext',
      'user_how_to_use': 'tab_show_how_to_use',
      'user_my_key': 'tab_show_my_key'
    };

    if (tabCheckMap[data]) {
      const isEnabled = (await getSetting(tabCheckMap[data], 'true')) === 'true';
      if (!isEnabled) {
        return safeEditMessage(chatId, messageId, '⚠️ *This feature is currently disabled by administrator.*', {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]]
          }
        });
      }
    }

    // --- User Callback Handlers ---

    // 1. Buy License Key (Active Payment State: ONLY Cancel Payment button)
    if (data === 'user_buy_key') {
      const price = await getSetting('license_price', '0');
      const upiId = await getSetting('license_upi_id', 'Not Set');
      const qrPhoto = await getSetting('license_qr_file_id', '');
      const customMsg = await getSetting('license_custom_msg', 'Scan the QR code or send payment to the UPI ID.');

      userStates[chatId] = { action: 'awaiting_utr', intent: 'license' };
      notifyAdminPaymentSession(query.from, 'Extension License Key');

      const caption = `🔑 *Buy Extension License Key*\n\n` +
        `💰 *Price:* Rs. ${price}\n` +
        `🆔 *UPI ID:* \`${upiId}\`\n\n` +
        `${customMsg}\n\n` +
        `👇 *After payment, reply with your 12-digit UTR (RRN) number.*`;

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Cancel Payment', callback_data: 'cancel_payment' }]
          ]
        }
      };

      return safeSendOrEditWithPhoto(chatId, messageId, caption, qrPhoto, opts);
    }

    // 2. Course Intermediate Intro View
    if (data === 'user_course_intro') {
      const defaultIntro = `🎓 *Learn Website Creation with AI Course*\n\n` +
        `Master building modern web applications with AI tools! Gain instant access to video guides, templates, and full source code.\n\n` +
        `Click *Get Access* below to enroll.`;
      const introMsg = await getSetting('course_intro_message', defaultIntro);

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🚀 Get Access', callback_data: 'user_buy_course' }],
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };

      return safeEditMessage(chatId, messageId, introMsg, opts);
    }

    // 3. Buy Course / Get Access (Active Payment State: ONLY Cancel Payment button)
    if (data === 'user_buy_course') {
      const price = await getSetting('course_price', '0');
      const upiId = await getSetting('course_upi_id', 'Not Set');
      const qrPhoto = await getSetting('course_qr_file_id', '');
      const customMsg = await getSetting('course_custom_msg', 'Scan the QR code or pay via UPI to enroll.');

      userStates[chatId] = { action: 'awaiting_utr', intent: 'course' };
      notifyAdminPaymentSession(query.from, 'Learn Website Creation with AI Course');

      const caption = `🎓 *Learn Website Creation with AI Course*\n\n` +
        `💰 *Price:* Rs. ${price}\n` +
        `🆔 *UPI ID:* \`${upiId}\`\n\n` +
        `${customMsg}\n\n` +
        `👇 *After payment, reply with your 12-digit UTR (RRN) number.*`;

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Cancel Payment', callback_data: 'cancel_payment' }]
          ]
        }
      };

      return safeSendOrEditWithPhoto(chatId, messageId, caption, qrPhoto, opts);
    }

    if (data === 'user_download_ext') {
      const extFileId = await getSetting('extension_file_id', '');
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };

      if (extFileId) {
        if (messageId) {
          bot.deleteMessage(chatId, messageId).catch(() => {});
        }
        return bot.sendDocument(chatId, extFileId, { caption: '📦 *Extension Zip File*', ...opts }).catch(err => console.error('Telegram sendDocument error:', err?.message || err));
      } else {
        return safeEditMessage(chatId, messageId, '⚠️ Extension package is not currently available for download. Please check back later.', opts);
      }
    }

    if (data === 'user_how_to_use') {
      const guideText = await getSetting('how_to_use_msg', '📖 *How to Use Guide:*\n\n1. Download the extension zip.\n2. Load unpacked in Chrome extensions.\n3. Buy a license key and activate it inside the extension sidepanel.');
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };
      return safeEditMessage(chatId, messageId, guideText, opts);
    }

    if (data === 'user_support') {
      const supportUrl = await getSupportUrl();
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '💬 Contact Support', url: supportUrl }],
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };
      return safeEditMessage(
        chatId,
        messageId,
        `💬 *Customer Support*\n\nFor assistance or issues, please contact our support team:\n👉 ${supportUrl}`,
        opts
      );
    }

    if (data === 'user_my_key') {
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };

      try {
        const res = await pool.query(
          'SELECT key, status, created_at FROM licenses WHERE telegram_id = $1 ORDER BY id DESC',
          [String(chatId)]
        );

        if (res.rows.length === 0) {
          return safeEditMessage(chatId, messageId, '❌ No license keys associated with your Telegram account.', opts);
        }

        let reply = `🔐 *Your License Keys:*\n\n`;
        res.rows.forEach((row, idx) => {
          reply += `${idx + 1}. \`${row.key}\` (Status: *${row.status}*)\n`;
        });

        return safeEditMessage(chatId, messageId, reply, opts);
      } catch (err) {
        console.error('Error fetching user keys:', err?.message || err);
        return safeEditMessage(chatId, messageId, '❌ Failed to fetch your license keys.', opts);
      }
    }

    if (data === 'user_free_trial') {
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Menu', callback_data: 'back_to_main' }]
          ]
        }
      };

      try {
        const userTelegramId = String(userId);
        const res = await pool.query(
          'SELECT * FROM licenses WHERE telegram_id = $1 AND is_trial = true',
          [userTelegramId]
        );

        if (res.rows.length > 0) {
          const existingKey = res.rows[0].key;
          const reply = `⚠️ *You have already claimed a Free Trial Key!*\n\nYour Trial Key:\n\`${existingKey}\`\n\n*Note:* Only 1 free trial key is allowed per user. Please copy and paste this key into the Freeflow extension login screen to activate your trial.`;
          return safeEditMessage(chatId, messageId, reply, opts);
        }

        const newTrialKey = generateTrialKey();
        await pool.query(
          "INSERT INTO licenses (key, status, is_trial, remaining_prompts, telegram_id) VALUES ($1, 'unused', true, 1, $2)",
          [newTrialKey, userTelegramId]
        );

        const reply = `🎉 *Free Trial Key Generated!*\n\nYour Free Trial Key:\n\`${newTrialKey}\`\n\n👉 Copy and paste this key into the Freeflow extension login screen to get started!`;
        return safeEditMessage(chatId, messageId, reply, opts);
      } catch (err) {
        console.error('Error in user_free_trial:', err?.message || err);
        return safeEditMessage(chatId, messageId, '❌ Failed to generate your free trial key.', opts);
      }
    }

    // --- Admin Callback Handlers (Use back_to_admin for navigation) ---
    if (!isAuthorizedAdmin(userId)) return;

    const adminOpts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
        ]
      }
    };

    if (data === 'admin_set_welcome') {
      adminStates[chatId] = { action: 'awaiting_welcome_msg' };
      return safeEditMessage(chatId, messageId, '📝 *Please send the new Custom Welcome Message:*', adminOpts);
    }

    if (data === 'admin_set_license_pay') {
      adminStates[chatId] = { action: 'awaiting_license_pay_info' };
      return safeEditMessage(
        chatId,
        messageId,
        `💳 *Set License Payment Info*\n\nPlease reply with text in this format:\n\n\`UPI_ID | Price | Custom Message\`\n\nExample:\n\`pay@upi | 499 | Instant key delivery after payment.\`\n\n*(To update the QR Code photo, send an image in your next message)*`,
        adminOpts
      );
    }

    if (data === 'admin_set_course_pay') {
      adminStates[chatId] = { action: 'awaiting_course_pay_info' };
      return safeEditMessage(
        chatId,
        messageId,
        `🎓 *Set Course Payment Info*\n\nPlease reply with text in this format:\n\n\`UPI_ID | Price | Channel_ID | Custom Message\`\n\nExample:\n\`course@upi | 999 | -100123456789 | Get instant private channel invite link.\`\n\n*(To update the QR Code photo, send an image in your next message)*`,
        adminOpts
      );
    }

    if (data === 'admin_set_course_intro') {
      adminStates[chatId] = { action: 'awaiting_course_intro_msg' };
      return safeEditMessage(
        chatId,
        messageId,
        `🎓 *Set Course Intro Message*\n\nPlease send the intro text for the course (displayed when user clicks the Course menu button):`,
        adminOpts
      );
    }

    if (data === 'admin_upload_ext') {
      adminStates[chatId] = { action: 'awaiting_extension_file' };
      return safeEditMessage(chatId, messageId, '📦 *Please upload the Extension .zip file now:*', adminOpts);
    }

    if (data === 'admin_set_how_to_use') {
      adminStates[chatId] = { action: 'awaiting_how_to_use_msg' };
      return safeEditMessage(chatId, messageId, '📖 *Please send the new "How to Use" guide message:*', adminOpts);
    }

    if (data === 'admin_new_key') {
      try {
        const key = generateLicenseKey();
        await pool.query('INSERT INTO licenses (key, status) VALUES ($1, $2)', [key, 'unused']);
        return safeEditMessage(chatId, messageId, `✅ *New License Key Generated:*\n\n\`${key}\`\n\nStatus: \`unused\``, adminOpts);
      } catch (err) {
        console.error('Error generating key:', err?.message || err);
        return safeEditMessage(chatId, messageId, '❌ Failed to generate key due to database error.', adminOpts);
      }
    }

    if (data === 'admin_key_stats') {
      try {
        const stats = await getAdminKeyStats();
        const reply = `📊 *License Key Statistics & Overview:*\n\n` +
          `🟢 *Active Keys:* ${stats.active}\n` +
          `🟡 *Unused Keys:* ${stats.unused}\n` +
          `🔴 *Revoked Keys:* ${stats.revoked}\n\n` +
          `📦 *Product Sales Breakdown:*\n` +
          `• Total Extension Keys Generated: *${stats.totalKeys}*\n` +
          `• Total Course Accesses Granted: *${stats.totalCourseAccesses}*\n\n` +
          `👥 *Total Unique Purchasing Users:* *${stats.uniqueBuyers}*`;

        const statsOpts = {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔑 Get All Active Keys', callback_data: 'admin_get_active_keys' }],
              [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
            ]
          }
        };

        return safeEditMessage(chatId, messageId, reply, statsOpts);
      } catch (err) {
        console.error('Error getting stats:', err?.message || err);
        return safeEditMessage(chatId, messageId, '❌ Failed to query key statistics.', adminOpts);
      }
    }

    if (data === 'admin_get_active_keys') {
      try {
        const activeKeys = await getActiveLicensesWithUsers();
        if (activeKeys.length === 0) {
          return safeEditMessage(chatId, messageId, 'ℹ️ *No currently active license keys found.*', adminOpts);
        }

        let reply = `🔑 *All Currently Active License Keys (${activeKeys.length}):*\n\n`;
        activeKeys.forEach((k, idx) => {
          const tgUser = k.telegram_id ? `\`${k.telegram_id}\`` : 'Not Bound';
          const lovableUser = k.lovable_user_id ? `\`${k.lovable_user_id}\`` : 'N/A';
          const hw = k.hw_fingerprint ? `\`${k.hw_fingerprint}\`` : 'Not Bound';
          const dateStr = k.created_at ? new Date(k.created_at).toISOString().split('T')[0] : 'N/A';

          reply += `*${idx + 1}. Key:* \`${k.key}\`\n` +
            `   👤 *TG User ID:* ${tgUser}\n` +
            `   💻 *HW Fingerprint:* ${hw}\n` +
            `   🆔 *Lovable Session:* ${lovableUser}\n` +
            `   📅 *Created:* ${dateStr}\n\n`;
        });

        if (reply.length > 4000) {
          const chunks = reply.match(/[\s\S]{1,3800}(?=\n\n|\s|$)/g) || [reply];
          await safeEditMessage(chatId, messageId, chunks[0], adminOpts);
          for (let i = 1; i < chunks.length; i++) {
            await bot.sendMessage(chatId, chunks[i], adminOpts);
          }
          return;
        }

        return safeEditMessage(chatId, messageId, reply, adminOpts);
      } catch (err) {
        console.error('Error getting active keys:', err?.message || err);
        return safeEditMessage(chatId, messageId, '❌ Failed to fetch active keys.', adminOpts);
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

      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
          ]
        }
      };
      return bot.sendMessage(chatId, `✅ *Extension file standard saved successfully!*\n\nFile Name: \`${fileName}\`\nFile ID: \`${fileId}\``, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
    }
  });

  // --- Photo Listener for Admin QR Uploads ---
  bot.on('photo', async (msg) => {
    const chatId = msg.chat.id;
    if (!isAuthorizedAdmin(msg)) return;

    const state = adminStates[chatId];
    if (!state) return;

    const photos = msg.photo;
    const fileId = photos[photos.length - 1].file_id;

    const opts = {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
        ]
      }
    };

    if (state.action === 'awaiting_license_pay_info') {
      await setSetting('license_qr_file_id', fileId);
      delete adminStates[chatId];
      return bot.sendMessage(chatId, `✅ *License QR Code photo saved successfully!*`, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
    }

    if (state.action === 'awaiting_course_pay_info') {
      await setSetting('course_qr_file_id', fileId);
      delete adminStates[chatId];
      return bot.sendMessage(chatId, `✅ *Course QR Code photo saved successfully!*`, opts).catch(err => console.error('Telegram sendMessage error:', err?.message || err));
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
    if (text === '/start' || text.startsWith('/start ')) {
      if (isAdmin) {
        return sendAdminPanel(chatId);
      }

      // Non-admin user membership check
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }

      return sendMainUserMenu(chatId);
    }

    // Command: /admin
    if (text === '/admin' || text.startsWith('/admin ')) {
      if (!isAdmin) {
        return bot.sendMessage(chatId, 'Unauthorized. Please send /start to continue.', { parse_mode: 'Markdown' })
          .catch(err => console.error('Telegram sendMessage error:', err?.message || err));
      }
      return sendAdminPanel(chatId);
    }

    // Command: /newkey
    if (text === '/newkey' || text.startsWith('/newkey ')) {
      if (!isAdmin) {
        return bot.sendMessage(chatId, 'Unauthorized. Please send /start to continue.').catch(err => console.error('Telegram sendMessage error:', err?.message || err));
      }
      try {
        const key = generateLicenseKey();
        await pool.query('INSERT INTO licenses (key, status) VALUES ($1, $2)', [key, 'unused']);
        return bot.sendMessage(chatId, `✅ *New License Key Generated:*\n\n\`${key}\`\n\nStatus: \`unused\``, { parse_mode: 'Markdown' });
      } catch (err) {
        console.error('Error generating key:', err?.message || err);
        return bot.sendMessage(chatId, '❌ Failed to generate key due to a database error.');
      }
    }

    // Command: /list
    if (text === '/list' || text.startsWith('/list ')) {
      if (!isAdmin) {
        return bot.sendMessage(chatId, 'Unauthorized. Please send /start to continue.').catch(err => console.error('Telegram sendMessage error:', err?.message || err));
      }
      try {
        const stats = await getAdminKeyStats();
        const reply = `📊 *License Key Statistics & Overview:*\n\n` +
          `🟢 *Active Keys:* ${stats.active}\n` +
          `🟡 *Unused Keys:* ${stats.unused}\n` +
          `🔴 *Revoked Keys:* ${stats.revoked}\n\n` +
          `📦 *Product Sales Breakdown:*\n` +
          `• Total Extension Keys Generated: *${stats.totalKeys}*\n` +
          `• Total Course Accesses Granted: *${stats.totalCourseAccesses}*\n\n` +
          `👥 *Total Unique Purchasing Users:* *${stats.uniqueBuyers}*`;

        const statsOpts = {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔑 Get All Active Keys', callback_data: 'admin_get_active_keys' }],
              [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
            ]
          }
        };

        return bot.sendMessage(chatId, reply, statsOpts);
      } catch (err) {
        console.error('Error querying list:', err?.message || err);
        return bot.sendMessage(chatId, '❌ Failed to fetch key statistics.');
      }
    }

    // Command: /revoke [key]
    if (text.startsWith('/revoke')) {
      if (!isAdmin) {
        return bot.sendMessage(chatId, 'Unauthorized. Please send /start to continue.').catch(err => console.error('Telegram sendMessage error:', err?.message || err));
      }
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
        console.error('Error revoking key:', err?.message || err);
        return bot.sendMessage(chatId, '❌ Database error while revoking key.');
      }
    }

    // Admin Input State Machine
    if (isAdmin && adminStates[chatId]) {
      const state = adminStates[chatId];
      const opts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Back to Admin', callback_data: 'back_to_admin' }]
          ]
        }
      };

      if (state.action === 'awaiting_welcome_msg') {
        await setSetting('welcome_msg', text);
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ *Welcome Message updated successfully!*', opts);
      }

      if (state.action === 'awaiting_how_to_use_msg') {
        await setSetting('how_to_use_msg', text);
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ *"How to Use" guide message updated successfully!*', opts);
      }

      if (state.action === 'awaiting_course_intro_msg') {
        await setSetting('course_intro_message', text);
        delete adminStates[chatId];
        return bot.sendMessage(chatId, '✅ *Course Intro Message updated successfully!*', opts);
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
            opts
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
            opts
          );
        } else {
          return bot.sendMessage(chatId, '⚠️ Invalid format. Use: `UPI_ID | Price | Channel_ID | Custom Message`');
        }
      }
    }

    // Non-Admin User Channel Membership Check for General Messages
    if (!isAdmin) {
      const isMember = await checkUserMembership(userId);
      if (!isMember) {
        return sendForceJoinPrompt(chatId);
      }
    }

    // User AWAITING_UTR State Handling (Payment State UX: ONLY Cancel Payment button during active payment)
    if (userStates[chatId] && userStates[chatId].action === 'awaiting_utr') {
      const extractedUtr = extractUtrFromUserText(text);

      const cancelOpts = {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '❌ Cancel Payment', callback_data: 'cancel_payment' }]
          ]
        }
      };

      if (!extractedUtr) {
        return bot.sendMessage(chatId, 'Please send a valid 12-digit UTR/RRN number.', cancelOpts);
      }

      const intent = userStates[chatId].intent || 'license';

      try {
        const existingTx = await pool.query('SELECT * FROM pending_transactions WHERE utr = $1', [extractedUtr]);

        if (existingTx.rows.length > 0) {
          const tx = existingTx.rows[0];
          if (tx.status === 'verified') {
            return bot.sendMessage(
              chatId,
              `❌ *This UTR (${extractedUtr}) has already been verified and claimed.*`,
              cancelOpts
            );
          } else if (tx.status === 'pending_verification') {
            return bot.sendMessage(
              chatId,
              `⏳ *Payment verification is already in progress for UTR (${extractedUtr}). Please wait up to 2 minutes...*`,
              cancelOpts
            );
          }
        }

        const targetPriceStr = await getSetting(intent === 'course' ? 'course_price' : 'license_price', '0');
        const targetPrice = parseFloat(targetPriceStr) || 0;

        // Insert or reset pending transaction
        await pool.query(
          `INSERT INTO pending_transactions (telegram_id, intent, utr, amount, paid_amount, status)
           VALUES ($1, $2, $3, $4, 0, 'pending_verification')
           ON CONFLICT (utr) DO UPDATE SET telegram_id = EXCLUDED.telegram_id, intent = EXCLUDED.intent,
             amount = EXCLUDED.amount, paid_amount = 0, status = 'pending_verification', updated_at = CURRENT_TIMESTAMP`,
          [String(chatId), intent, extractedUtr, targetPrice]
        );

        // Check if this payment was already received via SMS webhook (race-condition fix)
        let alreadyReceived = null;
        try {
          const rcvResult = await pool.query(
            'SELECT rrn, amount FROM received_sms_payments WHERE rrn = $1',
            [extractedUtr]
          );
          if (rcvResult.rows.length > 0) {
            alreadyReceived = rcvResult.rows[0];
          }
        } catch (_) { /* table may not exist yet on first run */ }

        if (alreadyReceived) {
          // Payment was already received — fulfill now!
          const pendingTxResult = await pool.query('SELECT * FROM pending_transactions WHERE utr = $1', [extractedUtr]);
          if (pendingTxResult.rows.length > 0) {
            const receivedAmt = alreadyReceived.amount !== null ? parseFloat(alreadyReceived.amount) : null;
            // Import fulfillPayment is not available here — inline the logic
            const pendingTx = pendingTxResult.rows[0];
            const txIntent = pendingTx.intent;
            const txTelegramId = pendingTx.telegram_id;
            const priceKey = txIntent === 'course' ? 'course_price' : 'license_price';
            const txPriceStr = await getSetting(priceKey, '0');
            const txPrice = parseFloat(txPriceStr) || 0;
            const newPayment = receivedAmt !== null ? receivedAmt : txPrice;
            const totalPaid = newPayment;

            if (totalPaid >= txPrice) {
              // Full payment — verify and deliver
              await pool.query(
                "UPDATE pending_transactions SET paid_amount = $1, status = 'verified', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                [totalPaid, pendingTx.id]
              );
              // Clean up stored SMS payment
              pool.query('DELETE FROM received_sms_payments WHERE rrn = $1', [extractedUtr]).catch(() => {});
              delete userStates[chatId];

              if (txIntent === 'license') {
                const newKey = generateLicenseKey();
                await pool.query(
                  "INSERT INTO licenses (key, status, telegram_id) VALUES ($1, 'unused', $2)",
                  [newKey, txTelegramId]
                );
                await bot.sendMessage(
                  chatId,
                  `🎉 *Payment Verified Successfully!*\n\nYour payment of *Rs. ${totalPaid.toFixed(2)}* was already received.\n\nHere is your Extension License Key:\n\n\`${newKey}\`\n\nYou can activate this key in the extension.`,
                  { parse_mode: 'Markdown' }
                ).catch(err => console.error('Telegram notification error:', err?.message || err));
                const adminMsg = `✅ *Payment Verification Success*\n\n` +
                  `👤 *Telegram ID:* \`${txTelegramId}\`\n` +
                  `📦 *Product:* Extension License Key\n` +
                  `💳 *UTR:* \`${extractedUtr}\`\n` +
                  `💰 *Amount Paid:* Rs. ${totalPaid.toFixed(2)}\n` +
                  `🔑 *Generated Key:* \`${newKey}\``;
                notifyAdmin(adminMsg);
                return;
              } else if (txIntent === 'course') {
                const courseChannelId = (await getSetting('course_channel_id', '')) || process.env.FORCE_JOIN_CHANNEL_ID || '';
                let inviteLinkUrl = '';
                if (courseChannelId) {
                  try {
                    const invite = await bot.createChatInviteLink(courseChannelId, {
                      member_limit: 1,
                      expire_date: Math.floor(Date.now() / 1000) + (86400 * 7)
                    });
                    inviteLinkUrl = invite.invite_link;
                  } catch (inviteErr) {
                    console.error('Error generating course invite link:', inviteErr?.message || inviteErr);
                  }
                }
                let msgText = `🎉 *Payment Verified Successfully!*\n\nWelcome to the *Learn Website Creation with AI* course!`;
                if (inviteLinkUrl) {
                  msgText += `\n\nHere is your private, single\-use channel invite link:\n${inviteLinkUrl}`;
                } else {
                  msgText += `\n\nPlease contact support to get added to the private course channel.`;
                }
                await bot.sendMessage(chatId, msgText, { parse_mode: 'Markdown' }).catch(err => console.error('Telegram notification error:', err?.message || err));
                const adminMsg = `✅ *Payment Verification Success*\n\n` +
                  `👤 *Telegram ID:* \`${txTelegramId}\`\n` +
                  `📦 *Product:* Learn Website Creation with AI Course\n` +
                  `💳 *UTR:* \`${extractedUtr}\`\n` +
                  `💰 *Amount Paid:* Rs. ${totalPaid.toFixed(2)}`;
                notifyAdmin(adminMsg);
                return;
              }
            } else {
              // Partial payment already received
              const remaining = txPrice - totalPaid;
              await pool.query(
                "UPDATE pending_transactions SET paid_amount = $1, status = 'partial_paid', updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                [totalPaid, pendingTx.id]
              );
              await bot.sendMessage(
                chatId,
                `⚠️ *Partial Payment Detected*\n\n💰 Received: *Rs. ${totalPaid.toFixed(2)}*\n🎯 Required: *Rs. ${txPrice.toFixed(2)}*\n🔻 Remaining: *Rs. ${remaining.toFixed(2)}*\n\nPlease pay the remaining amount and resubmit your UTR.`,
                cancelOpts
              ).catch(err => console.error('Telegram notification error:', err?.message || err));
              return;
            }
          }
        }

        return bot.sendMessage(
          chatId,
          `⏳ *Payment is verifying for UTR: \`${extractedUtr}\`. Please wait up to 2 minutes...*`,
          cancelOpts
        );
      } catch (err) {
        console.error('Error saving pending transaction UTR:', err?.message || err);
        return bot.sendMessage(chatId, '❌ Failed to process your UTR submission. Please try again.', cancelOpts);
      }
    }

    // Catch-All Route for unrecognized text/commands when user is NOT in active input state
    if (!text.startsWith('/')) {
      return bot.sendMessage(chatId, 'Invalid command. Please send /start to open the main menu.', { parse_mode: 'Markdown' })
        .catch(err => console.error('Telegram sendMessage error:', err?.message || err));
    } else {
      // Unrecognized slash command (e.g. /help, /foo)
      return bot.sendMessage(chatId, 'Invalid command. Please send /start to open the main menu.', { parse_mode: 'Markdown' })
        .catch(err => console.error('Telegram sendMessage error:', err?.message || err));
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
