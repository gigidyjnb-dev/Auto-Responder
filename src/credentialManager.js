const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;

function getKeyConfigError() {
  const keyHex = process.env.CRED_ENCRYPTION_KEY?.trim();
  if (!keyHex) {
    return 'CRED_ENCRYPTION_KEY_MISSING';
  }

  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    return 'CRED_ENCRYPTION_KEY_INVALID';
  }

  const key = Buffer.from(keyHex, 'hex');
  if (key.length !== KEY_LENGTH) {
    return 'CRED_ENCRYPTION_KEY_INVALID';
  }

  return null;
}

function getKey() {
  const configError = getKeyConfigError();
  if (configError) {
    if (configError === 'CRED_ENCRYPTION_KEY_MISSING') {
      console.warn('CRED_ENCRYPTION_KEY not set — credentials cannot be encrypted. Set this in Railway Variables.');
    } else {
      console.warn('CRED_ENCRYPTION_KEY invalid — expected 64 hex characters (32-byte key).');
    }
    return null;
  }

  return Buffer.from(process.env.CRED_ENCRYPTION_KEY.trim(), 'hex');
}

function encrypt(text) {
  if (!text) return '';

  const key = getKey();
  if (!key) {
    throw new Error('CRED_ENCRYPTION_KEY_INVALID');
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (err) {
    console.error('Encryption error:', err.message);
    throw new Error('CREDENTIAL_ENCRYPTION_FAILED');
  }
}

function decrypt(encryptedText) {
  if (!encryptedText) return '';

  const key = getKey();
  if (!key) {
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

module.exports = { encrypt, decrypt, getKey, getKeyConfigError };
