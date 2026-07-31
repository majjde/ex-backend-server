# Extension Backend Server & Telegram Bot Service

Express.js REST API & Telegram Bot backend for license management, automated UPI payments via Macrodroid SMS webhook, course invite delivery, and single-machine license binding.

---

## 🚀 Features

1. **License Management & Single-Machine Binding**:
   - `POST /api/activate` verifies keys and binds hardware fingerprint (`hwFingerprint`) upon first activation.
   - Restricts key usage to a single machine/device.

2. **Automated Payment SMS Webhook**:
   - `POST /api/payment-sms` receives bank SMS notifications sent by Macrodroid.
   - Extract 12-digit RRN/UTR and received amount using regex.
   - Matches against pending transactions in database.
   - Auto-generates and delivers License Key via Telegram for key purchases.
   - Auto-generates single-use private channel invite link for course purchases.
   - Handles partial payment scenarios and prevents UTR double-claiming.

3. **Mandatory Telegram Channel Verification**:
   - Restricts non-admin users until they join the specified Telegram channel.
   - Interactive `Join Channel` and `Verify` buttons.

4. **Main User Telegram Menu**:
   - `Buy Key`: QR code, UPI ID, and price payment workflow.
   - `Learn website creation with AI`: Course paywall workflow.
   - `Download Extension`: Delivers extension `.zip` document.
   - `How to Use`: Custom guide text.
   - `Support`: Direct link to support handle.
   - `My Key`: View purchased license keys.

5. **Admin Panel (`/admin`)**:
   - Restricted to designated `ADMIN_CHAT_ID`.
   - Update welcome message, license payment info, course payment info (with private channel ID), upload extension `.zip`, and custom guide message.

---

## 🛠️ Environment Variables

Add the following to your environment (or `.env` file):

| Variable | Description | Example |
|---|---|---|
| `PORT` | Server HTTP Port | `3000` |
| `DATABASE_URL` | PostgreSQL Connection String | `postgresql://...` |
| `EXTENSION_API_KEY` | Secret Key for Extension Authorization | `freeflow-be-key-2008` |
| `TELEGRAM_BOT_TOKEN` | Bot Father Token | `123456:ABC...` |
| `ADMIN_CHAT_ID` | Telegram User ID of Admin | `123456789` |
| `FORCE_JOIN_CHANNEL_ID` | Telegram Channel ID or Username | `-1001234567890` or `@channelname` |
| `FORCE_JOIN_CHANNEL_LINK` | Invite link for Force Join button | `https://t.me/channelname` |
| `SUPPORT_USERNAME` | Support Telegram Username | `@support_agent` |

---

## 📱 Macrodroid Webhook Setup

Configure Macrodroid HTTP POST request:
- **URL**: `https://your-domain.railway.app/api/payment-sms`
- **Content Type**: `application/json`
- **Body**:
  ```json
  {
    "sms": "[sms_body]"
  }
  ```

---

## 💻 API Endpoints

### 1. License Activation (`POST /api/activate`)
**Headers:**
`apikey: freeflow-be-key-2008`

**Body:**
```json
{
  "license_key": "ATM-XXXX-XXXX-XXXX-XXXX",
  "token_lovable": "user_session_token",
  "hwFingerprint": "unique_machine_fingerprint_hash"
}
```

---

## 📝 License
ISC
