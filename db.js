const { Pool } = require('pg');
require('dotenv').config();

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: connectionString && (connectionString.includes('railway') || process.env.NODE_ENV === 'production' || connectionString.includes('sslmode=require'))
    ? { rejectUnauthorized: false }
    : false,
});

async function initDb() {
  if (!process.env.DATABASE_URL) {
    console.warn('⚠️ DATABASE_URL is not set. Database initialization skipped.');
    return;
  }

  try {
    const client = await pool.connect();
    try {
      // Create licenses table if not existing
      await client.query(`
        CREATE TABLE IF NOT EXISTS licenses (
          id SERIAL PRIMARY KEY,
          key VARCHAR(255) UNIQUE NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'unused',
          lovable_user_id VARCHAR(255),
          hw_fingerprint VARCHAR(255),
          telegram_id VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Ensure new columns exist on licenses table if already existed
      await client.query(`
        ALTER TABLE licenses ADD COLUMN IF NOT EXISTS hw_fingerprint VARCHAR(255);
        ALTER TABLE licenses ADD COLUMN IF NOT EXISTS telegram_id VARCHAR(255);
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
        CREATE INDEX IF NOT EXISTS idx_licenses_telegram_id ON licenses(telegram_id);
      `);

      // Create admin_settings table
      await client.query(`
        CREATE TABLE IF NOT EXISTS admin_settings (
          key VARCHAR(255) PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      // Create pending_transactions table
      await client.query(`
        CREATE TABLE IF NOT EXISTS pending_transactions (
          id SERIAL PRIMARY KEY,
          telegram_id VARCHAR(255) NOT NULL,
          intent VARCHAR(50) NOT NULL,
          utr VARCHAR(255) UNIQUE NOT NULL,
          amount NUMERIC(10, 2) DEFAULT 0,
          paid_amount NUMERIC(10, 2) DEFAULT 0,
          status VARCHAR(50) NOT NULL DEFAULT 'pending_verification',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_pending_tx_utr ON pending_transactions(utr);
      `);

      // Create received_sms_payments table to cache SMS payments received before UTR submission
      await client.query(`
        CREATE TABLE IF NOT EXISTS received_sms_payments (
          id SERIAL PRIMARY KEY,
          rrn VARCHAR(255) UNIQUE NOT NULL,
          amount NUMERIC(10, 2),
          sms_text TEXT,
          received_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
        );
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_received_sms_rrn ON received_sms_payments(rrn);
      `);

      console.log('✅ Database schema initialized successfully.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Error initializing database schema:', err?.message || err);
  }
}

async function getSetting(key, defaultValue = '') {
  try {
    const res = await pool.query('SELECT value FROM admin_settings WHERE key = $1', [key]);
    if (res.rows.length > 0) {
      return res.rows[0].value;
    }
    return defaultValue;
  } catch (err) {
    console.error(`Error fetching setting ${key}:`, err?.message || err);
    return defaultValue;
  }
}

async function setSetting(key, value) {
  try {
    await pool.query(
      `INSERT INTO admin_settings (key, value, updated_at)
       VALUES ($1, $2, CURRENT_TIMESTAMP)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
      [key, String(value)]
    );
    return true;
  } catch (err) {
    console.error(`Error setting ${key}:`, err?.message || err);
    return false;
  }
}

async function getAllSettings() {
  try {
    const res = await pool.query('SELECT key, value FROM admin_settings');
    const settings = {};
    res.rows.forEach(r => {
      settings[r.key] = r.value;
    });
    return settings;
  } catch (err) {
    console.error('Error fetching all settings:', err?.message || err);
    return {};
  }
}

async function getAdminKeyStats() {
  try {
    const statusRes = await pool.query(
      'SELECT status, COUNT(*)::int as count FROM licenses GROUP BY status'
    );
    const counts = { active: 0, unused: 0, revoked: 0 };
    let totalKeys = 0;
    statusRes.rows.forEach(r => {
      counts[r.status] = parseInt(r.count, 10);
      totalKeys += parseInt(r.count, 10);
    });

    const courseRes = await pool.query(
      "SELECT COUNT(*)::int as count FROM pending_transactions WHERE intent = 'course' AND status = 'verified'"
    );
    const totalCourseAccesses = courseRes.rows[0]?.count || 0;

    const uniqueBuyersRes = await pool.query(`
      SELECT COUNT(DISTINCT telegram_id)::int as count FROM (
        SELECT telegram_id FROM licenses WHERE telegram_id IS NOT NULL AND telegram_id != ''
        UNION
        SELECT telegram_id FROM pending_transactions WHERE status = 'verified' AND telegram_id IS NOT NULL AND telegram_id != ''
      ) AS buyers
    `);
    const uniqueBuyers = uniqueBuyersRes.rows[0]?.count || 0;

    return {
      active: counts.active || 0,
      unused: counts.unused || 0,
      revoked: counts.revoked || 0,
      totalKeys,
      totalCourseAccesses,
      uniqueBuyers
    };
  } catch (err) {
    console.error('Error fetching admin key stats:', err?.message || err);
    return {
      active: 0,
      unused: 0,
      revoked: 0,
      totalKeys: 0,
      totalCourseAccesses: 0,
      uniqueBuyers: 0
    };
  }
}

async function getActiveLicensesWithUsers() {
  try {
    const res = await pool.query(
      "SELECT key, status, telegram_id, lovable_user_id, hw_fingerprint, created_at FROM licenses WHERE status = 'active' ORDER BY id DESC"
    );
    return res.rows;
  } catch (err) {
    console.error('Error fetching active licenses:', err?.message || err);
    return [];
  }
}

module.exports = {
  pool,
  initDb,
  getSetting,
  setSetting,
  getAllSettings,
  getAdminKeyStats,
  getActiveLicensesWithUsers,
};

