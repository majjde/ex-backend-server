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

  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS licenses (
      id SERIAL PRIMARY KEY,
      key VARCHAR(255) UNIQUE NOT NULL,
      status VARCHAR(50) NOT NULL DEFAULT 'unused',
      lovable_user_id VARCHAR(255),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `;
  try {
    const client = await pool.connect();
    try {
      await client.query(createTableQuery);
      console.log('✅ Database initialized: "licenses" table is ready.');
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('❌ Error initializing database table:', err.message);
  }
}

module.exports = {
  pool,
  initDb,
};
