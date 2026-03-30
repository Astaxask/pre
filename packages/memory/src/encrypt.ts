// TODO: Integrate SQLCipher layer (better-sqlite3-sqlcipher) for full-database encryption.
// Currently only field-level encryption via libsodium secretbox is implemented.
// The SQLCipher key would be: HKDF(PRE_ENCRYPTION_KEY, "sqlite")

import { hkdf } from 'node:crypto';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import type { DomainPayload, LifeDomain } from '@pre/shared';

// Use CJS require for libsodium-wrappers due to ESM packaging bug in 0.7.x
const require = createRequire(import.meta.url);
const sodium = require('libsodium-wrappers') as typeof import('libsodium-wrappers');

const hkdfAsync = promisify(hkdf);

let sodiumReady = false;

async function ensureSodium(): Promise<void> {
  if (!sodiumReady) {
    await sodium.ready;
    sodiumReady = true;
  }
}

/**
 * Derives a 32-byte key from the master key and a context string using HKDF-SHA256.
 */
export async function deriveKey(
  masterKey: string,
  context: string,
): Promise<Uint8Array> {
  const derived = await hkdfAsync(
    'sha256',
    Buffer.from(masterKey, 'hex'),
    Buffer.from('pre-encryption'),
    Buffer.from(context),
    32,
  );
  return new Uint8Array(derived as ArrayBuffer);
}

/**
 * Encrypts a domain payload using libsodium secretbox.
 * Key is derived as HKDF(masterKey, "payload-" + domain).
 * Returns base64 string with nonce prepended to ciphertext.
 */
export async function encryptPayload(
  payload: DomainPayload,
  domain: LifeDomain,
  masterKey: string,
): Promise<string> {
  await ensureSodium();
  const key = await deriveKey(masterKey, `payload-${domain}`);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const plaintext = sodium.from_string(JSON.stringify(payload));
  const ciphertext = sodium.crypto_secretbox_easy(plaintext, nonce, key);

  // Prepend nonce to ciphertext
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);

  return sodium.to_base64(combined, sodium.base64_variants.ORIGINAL);
}

/**
 * Decrypts a base64-encoded ciphertext (with prepended nonce) back to a DomainPayload.
 */
export async function decryptPayload(
  encrypted: string,
  domain: LifeDomain,
  masterKey: string,
): Promise<DomainPayload> {
  await ensureSodium();
  const key = await deriveKey(masterKey, `payload-${domain}`);
  const combined = sodium.from_base64(
    encrypted,
    sodium.base64_variants.ORIGINAL,
  );

  const nonce = combined.slice(0, sodium.crypto_secretbox_NONCEBYTES);
  const ciphertext = combined.slice(sodium.crypto_secretbox_NONCEBYTES);

  const plaintext = sodium.crypto_secretbox_open_easy(ciphertext, nonce, key);
  return JSON.parse(sodium.to_string(plaintext)) as DomainPayload;
}
