-- Database Schema for License Management Service

CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'unused',
    lovable_user_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookup by key
CREATE INDEX IF NOT EXISTS idx_licenses_key ON licenses(key);
