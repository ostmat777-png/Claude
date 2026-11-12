'use strict';
// Keeping a password in the settings file. Where the system can encrypt for the
// current user (Windows always can), the file holds only the encrypted form.

const { safeStorage } = require('electron');

async function canEncrypt() {
  try {
    if (typeof safeStorage.isAsyncEncryptionAvailable === 'function') return await safeStorage.isAsyncEncryptionAvailable();
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Text -> what goes into the file. '' stays ''. */
async function seal(text) {
  const value = String(text || '');
  if (!value) return '';
  try {
    if (await canEncrypt()) {
      const buf = typeof safeStorage.encryptStringAsync === 'function'
        ? await safeStorage.encryptStringAsync(value)
        : safeStorage.encryptString(value);
      return 'enc:' + Buffer.from(buf).toString('base64');
    }
  } catch {
    // fall through to the plain form
  }
  // No encryption on this system: kept readable, and marked as such.
  return 'txt:' + Buffer.from(value, 'utf8').toString('base64');
}

/** What is in the file -> text. Anything unreadable gives ''. */
async function open(stored) {
  const s = String(stored || '');
  try {
    if (s.startsWith('txt:')) return Buffer.from(s.slice(4), 'base64').toString('utf8');
    if (s.startsWith('enc:')) {
      const buf = Buffer.from(s.slice(4), 'base64');
      if (typeof safeStorage.decryptStringAsync === 'function') {
        const res = await safeStorage.decryptStringAsync(buf);
        return String(res && typeof res === 'object' ? res.result : res);
      }
      return safeStorage.decryptString(buf);
    }
  } catch {
    return '';
  }
  return '';
}

module.exports = { seal, open };
