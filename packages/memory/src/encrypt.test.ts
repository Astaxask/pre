import { describe, it, expect } from 'vitest';
import { deriveKey, encryptPayload, decryptPayload } from './encrypt.js';
import type { BodyPayload, MoneyPayload } from '@pre/shared';

const TEST_KEY = 'a'.repeat(64); // 32-byte hex key

describe('deriveKey', () => {
  it('produces a 32-byte key', async () => {
    const key = await deriveKey(TEST_KEY, 'test-context');
    expect(key).toBeInstanceOf(Uint8Array);
    expect(key.length).toBe(32);
  });

  it('is deterministic for the same inputs', async () => {
    const key1 = await deriveKey(TEST_KEY, 'same-context');
    const key2 = await deriveKey(TEST_KEY, 'same-context');
    expect(key1).toEqual(key2);
  });

  it('produces different keys for different contexts', async () => {
    const key1 = await deriveKey(TEST_KEY, 'context-a');
    const key2 = await deriveKey(TEST_KEY, 'context-b');
    expect(key1).not.toEqual(key2);
  });
});

describe('encryptPayload / decryptPayload', () => {
  const bodyPayload: BodyPayload = {
    domain: 'body',
    subtype: 'sleep',
    sleepDuration: 420,
    sleepScore: 85,
    deepSleepMinutes: 90,
  };

  it('round-trips a payload', async () => {
    const encrypted = await encryptPayload(bodyPayload, 'body', TEST_KEY);
    const decrypted = await decryptPayload(encrypted, 'body', TEST_KEY);
    expect(decrypted).toEqual(bodyPayload);
  });

  it('produces base64 output that is not plaintext JSON', async () => {
    const encrypted = await encryptPayload(bodyPayload, 'body', TEST_KEY);
    expect(() => JSON.parse(encrypted)).toThrow();
  });

  it('produces different ciphertext for different domains', async () => {
    const moneyPayload: MoneyPayload = {
      domain: 'money',
      subtype: 'transaction',
      amount: 42,
    };
    const encBody = await encryptPayload(bodyPayload, 'body', TEST_KEY);
    const encMoney = await encryptPayload(moneyPayload, 'money', TEST_KEY);
    expect(encBody).not.toEqual(encMoney);
  });

  it('fails to decrypt with wrong domain', async () => {
    const encrypted = await encryptPayload(bodyPayload, 'body', TEST_KEY);
    await expect(
      decryptPayload(encrypted, 'money', TEST_KEY),
    ).rejects.toThrow();
  });
});
