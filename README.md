# License Management Backend Service (Express + Telegram Bot)

A backend service built with Node.js, Express, PostgreSQL, and `node-telegram-bot-api`. It provides:
1. **Telegram Admin Bot** to generate, list, and revoke license keys.
2. **Express API Endpoint** (`/api/activate`) for Chrome Extension license key activation and device binding.

---

## 🛠️ Features

- **License Key Format**: `ATM-XXXX-XXXX-XXXX-XXXX` (Fixed `ATM` prefix + 4 blocks of 4 uppercase random characters).
- **Admin Restriction**: Telegram Bot ignores commands from anyone except the configured `ADMIN_CHAT_ID`.
- **Auto Database Table Creation**: Automatically creates the `licenses` table in PostgreSQL on application startup if it doesn't exist.
- **Railway Deployment Ready**: Works seamlessly with Railway PostgreSQL (`DATABASE_URL`) and Express `PORT`.

---

## 🚀 Environment Variables

Create a `.env` file in the root directory (refer to `.env.example`):

```env
PORT=3000
DATABASE_URL=postgresql://user:password@host:5432/dbname
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
ADMIN_CHAT_ID=your_telegram_chat_id
EXTENSION_API_KEY=your_extension_secret_api_key
```

---

## 🤖 Telegram Admin Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message & available command list |
| `/newkey` | Generate a new license key with status `unused` |
| `/list` | Show statistics of `active`, `unused`, and `revoked` keys |
| `/revoke [key]` | Revoke a specific license key |

---

## ⚡ Express API Endpoint

### `POST /api/activate`

Activate or verify a license key for a Chrome Extension.

#### Headers Required:
- `apikey`: Must match `EXTENSION_API_KEY` environment variable.

#### Request Body:
```json
{
  "license_key": "ATM-PUM8-ALT2-XJ6G-FMBX",
  "token_lovable": "user_device_id_12345"
}
```

#### Response Cases:
- **Success (200 OK)**:
  ```json
  { "success": true }
  ```
- **Unauthorized (401)** (Invalid API key in headers):
  ```json
  { "error": "Unauthorized" }
  ```
- **Invalid Key or Revoked (401)**:
  ```json
  { "error": "Invalid or revoked key" }
  ```
- **Key Bound to Another Device (401)**:
  ```json
  { "error": "Key already bound to another device" }
  ```

---

## 📦 Database Schema

```sql
CREATE TABLE IF NOT EXISTS licenses (
    id SERIAL PRIMARY KEY,
    key VARCHAR(255) UNIQUE NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'unused',
    lovable_user_id VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);
```

---

## 🏃 Local Setup & Running

```bash
# 1. Install dependencies
npm install

# 2. Run in development/production mode
npm start
```
