/**
 * Credential encryption/decryption
 * Uses AES-256-GCM with key from environment variable
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

// Get encryption key from env (32 bytes hex string)
function getKey() {
  const keyHex = process.env.CRED_ENCRYPTION_KEY;
  if (!keyHex) {
    console.warn('CRED_ENCRYPTION_KEY not set — credentials will not be encrypted. SET THIS IN RAILWAY!');
    return null;
  }
  return Buffer.from(keyHex, 'hex');
}

// Encrypt a string, returns "iv:authTag:ciphertext" (all hex)
function encrypt(text) {
  if (!text) return '';

  const key = getKey();
  if (!key) {
    throw new Error('Encryption key not configured. Set CRED_ENCRYPTION_KEY in Railway environment variables (32-byte hex).');
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();

    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  } catch (err) {
    console.error('Encryption error:', err.message);
    throw new Error('Failed to encrypt sensitive data');
  }
}

// Decrypt string back to plaintext
function decrypt(encryptedText) {
  if (!encryptedText) return '';

  const key = getKey();
  if (!key) {
    console.warn('CRED_ENCRYPTION_KEY not set — cannot decrypt credentials');
    return null;
  }

  try {
    const parts = encryptedText.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted credentials format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (err) {
    console.error('Decryption error:', err.message);
    return null;
  }
}

module.exports = { encrypt, decrypt, getKey };
