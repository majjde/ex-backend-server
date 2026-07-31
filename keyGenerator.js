const crypto = require('crypto');

/**
 * Generates a random uppercase alphanumeric chunk of specified length.
 * @param {number} length 
 * @returns {string}
 */
function generateChunk(length = 4) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Generates a license key in the format: ATM-XXXX-XXXX-XXXX-XXXX
 * - Starting prefix 'ATM' is fixed.
 * - Followed by 4 blocks of 4 random uppercase alphanumeric characters.
 * @returns {string} Example: ATM-PUM8-ALT2-XJ6G-FMBX
 */
function generateLicenseKey() {
  const prefix = 'ATM';
  const c1 = generateChunk(4);
  const c2 = generateChunk(4);
  const c3 = generateChunk(4);
  const c4 = generateChunk(4);
  return `${prefix}-${c1}-${c2}-${c3}-${c4}`;
}

module.exports = {
  generateLicenseKey,
};
