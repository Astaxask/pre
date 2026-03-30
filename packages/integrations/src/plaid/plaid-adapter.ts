import { randomUUID } from 'node:crypto';
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  type TransactionsSyncResponse,
  type AccountBase,
} from 'plaid';
import type { LifeEvent, MoneyPayload } from '@pre/shared';
import type {
  LifeAdapter,
  AdapterResult,
  AdapterManifest,
  SyncCursor,
} from '../types.js';

type PlaidAdapterConfig = {
  clientId: string;
  secret: string;
  accessToken: string;
  environment: 'sandbox' | 'production';
};

export class PlaidAdapter implements LifeAdapter {
  readonly source = 'plaid' as const;
  readonly domains = ['money' as const];

  private client: PlaidApi;
  private accessToken: string;

  constructor(config: PlaidAdapterConfig) {
    this.accessToken = config.accessToken;
    const configuration = new Configuration({
      basePath:
        config.environment === 'sandbox'
          ? PlaidEnvironments.sandbox
          : PlaidEnvironments.production,
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': config.clientId,
          'PLAID-SECRET': config.secret,
        },
      },
    });
    this.client = new PlaidApi(configuration);
  }

  async sync(cursor: SyncCursor | null): Promise<AdapterResult> {
    const response = await this.client.transactionsSync({
      access_token: this.accessToken,
      cursor: cursor ?? undefined,
    });

    const data: TransactionsSyncResponse = response.data;
    const events: LifeEvent[] = [];

    // Map added transactions to LifeEvents
    for (const txn of data.added) {
      const amount = Math.abs(txn.amount);
      // Plaid convention: positive amount = money leaving account (debit)
      const direction: 'debit' | 'credit' =
        txn.amount > 0 ? 'debit' : 'credit';

      const merchantName = txn.merchant_name ?? txn.name ?? undefined;
      const truncatedMerchant =
        merchantName && merchantName.length > 50
          ? merchantName.slice(0, 50)
          : merchantName;

      const category: string[] = [];
      if (txn.personal_finance_category) {
        category.push(txn.personal_finance_category.primary);
        if (txn.personal_finance_category.detailed) {
          category.push(txn.personal_finance_category.detailed);
        }
      }

      const payload: MoneyPayload = {
        domain: 'money',
        subtype: 'transaction',
        amount,
        currency: txn.iso_currency_code ?? 'USD',
        direction,
        merchantName: truncatedMerchant,
        category: category.length > 0 ? category : undefined,
        accountId: txn.account_id,
      };

      events.push({
        id: randomUUID(),
        source: 'plaid',
        sourceId: txn.transaction_id,
        domain: 'money',
        eventType: 'transaction',
        timestamp: new Date(txn.date).getTime(),
        ingestedAt: Date.now(),
        payload,
        embedding: null,
        summary: null,
        privacyLevel: 'private',
        confidence: 1.0,
      });
    }

    // Sync account balances
    try {
      const accountsResponse = await this.client.accountsGet({
        access_token: this.accessToken,
      });

      for (const account of accountsResponse.data.accounts) {
        const balanceEvent = this.mapAccountToEvent(account);
        if (balanceEvent) {
          events.push(balanceEvent);
        }
      }
    } catch {
      // Balance fetch is best-effort; transaction sync is primary
    }

    return {
      events,
      nextCursor: data.next_cursor,
      hasMore: data.has_more,
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.client.accountsGet({
        access_token: this.accessToken,
      });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  manifest(): AdapterManifest {
    return {
      source: 'plaid',
      description:
        'Financial transactions, balances, and bill reminders via Plaid',
      domains: ['money'],
      maxPrivacyLevel: 'private',
      defaultSyncIntervalMinutes: 360,
      collectsFields: [
        'Transaction amount, direction, date',
        'Merchant name (for categorization)',
        'Plaid category hierarchy',
        'Account type (checking/savings/credit)',
        'Account balance snapshot',
        'Bill due dates and estimated amounts',
      ],
      refusesFields: [
        'Account numbers (uses opaque Plaid IDs only)',
        'SSN, DOB, or any identity fields',
        'Full account holder name',
        'Routing numbers',
        'Transaction descriptions longer than 50 chars',
        'Investment holdings detail',
      ],
    };
  }

  private mapAccountToEvent(account: AccountBase): LifeEvent | null {
    const balance = account.balances.current;
    if (balance === null || balance === undefined) {
      return null;
    }

    const accountType = this.mapAccountType(account.type ?? '');

    const payload: MoneyPayload = {
      domain: 'money',
      subtype: 'balance-snapshot',
      balance,
      currency: account.balances.iso_currency_code ?? 'USD',
      accountId: account.account_id,
      accountType,
    };

    return {
      id: randomUUID(),
      source: 'plaid',
      sourceId: `balance-${account.account_id}-${Date.now()}`,
      domain: 'money',
      eventType: 'balance-snapshot',
      timestamp: Date.now(),
      ingestedAt: Date.now(),
      payload,
      embedding: null,
      summary: null,
      privacyLevel: 'private',
      confidence: 1.0,
    };
  }

  private mapAccountType(
    type: string,
  ): 'checking' | 'savings' | 'credit' | 'investment' | 'loan' | undefined {
    switch (type) {
      case 'depository':
        return 'checking';
      case 'credit':
        return 'credit';
      case 'investment':
        return 'investment';
      case 'loan':
        return 'loan';
      default:
        return undefined;
    }
  }
}
