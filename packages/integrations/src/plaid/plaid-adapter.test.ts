import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PlaidAdapter } from './plaid-adapter.js';
import transactionsSyncFixture from './fixtures/transactions-sync-response.json' with { type: 'json' };
import accountsGetFixture from './fixtures/accounts-get-response.json' with { type: 'json' };

// Mock the plaid module
vi.mock('plaid', () => {
  const mockTransactionsSync = vi.fn();
  const mockAccountsGet = vi.fn();

  class MockPlaidApi {
    transactionsSync = mockTransactionsSync;
    accountsGet = mockAccountsGet;
  }

  class MockConfiguration {
    constructor(_opts: unknown) {}
  }

  return {
    Configuration: MockConfiguration,
    PlaidApi: MockPlaidApi,
    PlaidEnvironments: {
      sandbox: 'https://sandbox.plaid.com',
      production: 'https://production.plaid.com',
    },
    __mockTransactionsSync: mockTransactionsSync,
    __mockAccountsGet: mockAccountsGet,
  };
});

// Get handles to the mock functions
async function getMocks() {
  const plaidModule = await import('plaid');
  const mod = plaidModule as unknown as {
    __mockTransactionsSync: ReturnType<typeof vi.fn>;
    __mockAccountsGet: ReturnType<typeof vi.fn>;
  };
  return {
    mockTransactionsSync: mod.__mockTransactionsSync,
    mockAccountsGet: mod.__mockAccountsGet,
  };
}

function createAdapter(): PlaidAdapter {
  return new PlaidAdapter({
    clientId: 'test-client-id',
    secret: 'test-secret',
    accessToken: 'access-sandbox-test',
    environment: 'sandbox',
  });
}

describe('PlaidAdapter', () => {
  let mocks: Awaited<ReturnType<typeof getMocks>>;

  beforeEach(async () => {
    mocks = await getMocks();
    mocks.mockTransactionsSync.mockReset();
    mocks.mockAccountsGet.mockReset();
  });

  describe('sync()', () => {
    it('maps transactions to LifeEvents with correct fields', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // 5 transactions + 3 balance snapshots
      expect(result.events.length).toBe(8);

      const txnEvents = result.events.filter(
        (e) => e.eventType === 'transaction',
      );
      expect(txnEvents).toHaveLength(5);

      const first = txnEvents[0]!;
      expect(first.source).toBe('plaid');
      expect(first.sourceId).toBe('txn_001');
      expect(first.domain).toBe('money');
      expect(first.privacyLevel).toBe('private');
      expect(first.confidence).toBe(1.0);
      expect(first.embedding).toBeNull();
      expect(first.summary).toBeNull();

      // Check payload
      const p = first.payload;
      expect(p.domain).toBe('money');
      if (p.domain === 'money') {
        expect(p.subtype).toBe('transaction');
        expect(p.amount).toBe(12.5);
        expect(p.direction).toBe('debit');
        expect(p.currency).toBe('USD');
        expect(p.merchantName).toBe('Starbucks');
        expect(p.accountId).toBe('acc_checking_001');
        expect(p.category).toEqual([
          'FOOD_AND_DRINK',
          'FOOD_AND_DRINK_COFFEE',
        ]);
      }
    });

    it('sets sourceId to transaction_id for deduplication', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      const txnEvents = result.events.filter(
        (e) => e.eventType === 'transaction',
      );
      const sourceIds = txnEvents.map((e) => e.sourceId);
      expect(sourceIds).toContain('txn_001');
      expect(sourceIds).toContain('txn_002');
      expect(sourceIds).toContain('txn_003');
    });

    it('all events have privacyLevel private', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      for (const event of result.events) {
        expect(event.privacyLevel).toBe('private');
      }
    });

    it('maps credit (negative amount) correctly', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // txn_004 has amount -2500 (credit/income)
      const creditEvent = result.events.find(
        (e) => e.sourceId === 'txn_004',
      )!;
      if (creditEvent.payload.domain === 'money') {
        expect(creditEvent.payload.direction).toBe('credit');
        expect(creditEvent.payload.amount).toBe(2500);
      }
    });

    it('passes cursor through and returns nextCursor/hasMore', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync('previous-cursor');

      expect(mocks.mockTransactionsSync).toHaveBeenCalledWith({
        access_token: 'access-sandbox-test',
        cursor: 'previous-cursor',
      });
      expect(result.nextCursor).toBe('cursor_abc123_page2');
      expect(result.hasMore).toBe(false);
    });

    it('includes balance snapshot events', async () => {
      mocks.mockTransactionsSync.mockResolvedValue({
        data: transactionsSyncFixture,
      });
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      const balanceEvents = result.events.filter(
        (e) => e.eventType === 'balance-snapshot',
      );
      expect(balanceEvents).toHaveLength(3);

      const checking = balanceEvents.find((e) =>
        e.sourceId.includes('acc_checking_001'),
      )!;
      if (checking.payload.domain === 'money') {
        expect(checking.payload.balance).toBe(3500);
        expect(checking.payload.accountType).toBe('checking');
      }
    });
  });

  describe('healthCheck()', () => {
    it('returns ok on success', async () => {
      mocks.mockAccountsGet.mockResolvedValue({ data: accountsGetFixture });

      const adapter = createAdapter();
      const result = await adapter.healthCheck();
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('returns error on failure', async () => {
      mocks.mockAccountsGet.mockRejectedValue(
        new Error('INVALID_ACCESS_TOKEN'),
      );

      const adapter = createAdapter();
      const result = await adapter.healthCheck();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('INVALID_ACCESS_TOKEN');
    });
  });

  describe('manifest()', () => {
    it('returns correct manifest', () => {
      const adapter = createAdapter();
      const m = adapter.manifest();

      expect(m.source).toBe('plaid');
      expect(m.domains).toEqual(['money']);
      expect(m.maxPrivacyLevel).toBe('private');
      expect(m.defaultSyncIntervalMinutes).toBe(360);
      expect(m.collectsFields.length).toBeGreaterThan(0);
      expect(m.refusesFields.length).toBeGreaterThan(0);
      expect(m.refusesFields).toContain(
        'Account numbers (uses opaque Plaid IDs only)',
      );
    });
  });
});
