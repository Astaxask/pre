import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GoogleCalendarAdapter } from './google-calendar-adapter.js';
import eventsListFixture from './fixtures/events-list-response.json' with { type: 'json' };

// Mock googleapis
const mockEventsList = vi.fn();
const mockCalendarListList = vi.fn();

vi.mock('googleapis', () => {
  class MockOAuth2 {
    constructor(_clientId: string, _clientSecret: string) {}
    setCredentials(_creds: unknown) {}
  }

  return {
    google: {
      auth: { OAuth2: MockOAuth2 },
      calendar: () => ({
        events: { list: mockEventsList },
        calendarList: { list: mockCalendarListList },
      }),
    },
  };
});

function createAdapter(): GoogleCalendarAdapter {
  return new GoogleCalendarAdapter({
    clientId: 'test-client-id',
    clientSecret: 'test-client-secret',
    refreshToken: 'test-refresh-token',
  });
}

describe('GoogleCalendarAdapter', () => {
  beforeEach(() => {
    mockEventsList.mockReset();
    mockCalendarListList.mockReset();
  });

  describe('sync()', () => {
    it('maps calendar events to LifeEvents with correct fields', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      expect(result.events).toHaveLength(3);

      const first = result.events[0]!;
      expect(first.source).toBe('google-calendar');
      expect(first.sourceId).toBe('event_001');
      expect(first.domain).toBe('time');
      expect(first.eventType).toBe('calendar-event');
      expect(first.privacyLevel).toBe('private');
      expect(first.confidence).toBe(1.0);
      expect(first.embedding).toBeNull();
      expect(first.summary).toBeNull();
    });

    it('never includes event titles or descriptions in payload', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      for (const event of result.events) {
        const payload = event.payload;
        if (payload.domain === 'time') {
          // title must not be set — we never collect it
          expect(payload.title).toBeUndefined();
        }
        // No field should contain the original event summary
        const payloadStr = JSON.stringify(payload);
        expect(payloadStr).not.toContain('Team Standup');
        expect(payloadStr).not.toContain('Dentist');
        expect(payloadStr).not.toContain('Conference');
      }
    });

    it('never includes attendee names or emails', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      for (const event of result.events) {
        const payloadStr = JSON.stringify(event);
        expect(payloadStr).not.toContain('alice@');
        expect(payloadStr).not.toContain('bob@');
        expect(payloadStr).not.toContain('carol@');
        expect(payloadStr).not.toContain('dave@');
        expect(payloadStr).not.toContain('company.com');
      }
    });

    it('stores attendee count as integer', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // event_001 has 3 attendees
      const event1 = result.events[0]!;
      if (event1.payload.domain === 'time') {
        expect(event1.payload.attendeeCount).toBe(3);
        expect(Number.isInteger(event1.payload.attendeeCount)).toBe(true);
      }

      // event_003 has 5 attendees
      const event3 = result.events[2]!;
      if (event3.payload.domain === 'time') {
        expect(event3.payload.attendeeCount).toBe(5);
      }
    });

    it('detects recurring events', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // event_001 has recurringEventId
      if (result.events[0]!.payload.domain === 'time') {
        expect(result.events[0]!.payload.isRecurring).toBe(true);
      }

      // event_002 does not
      if (result.events[1]!.payload.domain === 'time') {
        expect(result.events[1]!.payload.isRecurring).toBe(false);
      }
    });

    it('infers calendar type from organizer', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // event_001 organizer is alice@company.com → work
      if (result.events[0]!.payload.domain === 'time') {
        expect(result.events[0]!.payload.calendarType).toBe('work');
      }

      // event_002 organizer is user@gmail.com → personal
      if (result.events[1]!.payload.domain === 'time') {
        expect(result.events[1]!.payload.calendarType).toBe('personal');
      }
    });

    it('calculates duration correctly', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      // event_001: 9:00 - 9:30 = 30 min
      if (result.events[0]!.payload.domain === 'time') {
        expect(result.events[0]!.payload.durationMinutes).toBe(30);
      }

      // event_002: 14:00 - 15:00 = 60 min
      if (result.events[1]!.payload.domain === 'time') {
        expect(result.events[1]!.payload.durationMinutes).toBe(60);
      }
    });

    it('returns nextCursor from syncToken', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      expect(result.nextCursor).toBe('sync_token_abc123');
      expect(result.hasMore).toBe(false);
    });

    it('passes cursor as syncToken for incremental sync', async () => {
      mockEventsList.mockResolvedValue({
        data: { ...eventsListFixture, items: [] },
      });

      const adapter = createAdapter();
      await adapter.sync('prev_sync_token');

      expect(mockEventsList).toHaveBeenCalledWith(
        expect.objectContaining({
          syncToken: 'prev_sync_token',
        }),
      );
    });

    it('all events have privacyLevel private', async () => {
      mockEventsList.mockResolvedValue({ data: eventsListFixture });

      const adapter = createAdapter();
      const result = await adapter.sync(null);

      for (const event of result.events) {
        expect(event.privacyLevel).toBe('private');
      }
    });
  });

  describe('healthCheck()', () => {
    it('returns ok on success', async () => {
      mockCalendarListList.mockResolvedValue({
        data: { items: [] },
      });

      const adapter = createAdapter();
      const result = await adapter.healthCheck();
      expect(result.ok).toBe(true);
    });

    it('returns error on failure', async () => {
      mockCalendarListList.mockRejectedValue(
        new Error('invalid_grant'),
      );

      const adapter = createAdapter();
      const result = await adapter.healthCheck();
      expect(result.ok).toBe(false);
      expect(result.error).toContain('invalid_grant');
    });
  });

  describe('manifest()', () => {
    it('returns correct manifest', () => {
      const adapter = createAdapter();
      const m = adapter.manifest();

      expect(m.source).toBe('google-calendar');
      expect(m.domains).toEqual(['time']);
      expect(m.maxPrivacyLevel).toBe('private');
      expect(m.defaultSyncIntervalMinutes).toBe(10);
      expect(m.refusesFields).toContain('Event title or description');
      expect(m.refusesFields).toContain('Attendee names or email addresses');
      expect(m.refusesFields).toContain('Event location');
    });
  });
});
