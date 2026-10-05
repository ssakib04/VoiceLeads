// scrypt password hashing + AES-256-GCM encryption for provider keys at rest.
// No native deps beyond node:crypto. bcrypt would be fine too; scrypt ships with Node.
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const KEY_LEN = 32;

export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = (await scrypt(pw, salt, KEY_LEN)).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export async function verifyPassword(pw, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const derived = (await scrypt(pw, salt, KEY_LEN)).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(derived, 'hex'));
}

function aesKey() {
  const hex = process.env.AES_KEY;
  if (!hex || hex.length < 64) throw new Error('AES_KEY must be 64 hex chars (32 bytes). Generate one — see .env.example');
  return Buffer.from(hex.slice(0, 64), 'hex');
}

// returns "iv:tag:ciphertext" all hex
export function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${enc.toString('hex')}`;
}

export function decryptSecret(blob) {
  const [ivHex, tagHex, dataHex] = String(blob).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]).toString('utf8');
}

export function constantEqual(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
