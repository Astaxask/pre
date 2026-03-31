import { randomUUID, createHash } from 'node:crypto';
import { google, type calendar_v3 } from 'googleapis';
import type { LifeEvent, TimePayload } from '@pre/shared';
import type {
  LifeAdapter,
  AdapterResult,
  AdapterManifest,
  SyncCursor,
} from '../types.js';

type GoogleCalendarConfig = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
};

/**
 * SHA-256 hash of a calendar ID — we never store the raw calendar ID
 * per privacy-model.md section 4.
 */
function hashCalendarId(calendarId: string): string {
  return createHash('sha256').update(calendarId).digest('hex').slice(0, 16);
}

/**
 * Infer work vs personal from calendar ID heuristics.
 * If the calendar ID is the user's primary, assume 'personal'.
 * Otherwise default to 'work'. This is deliberately coarse.
 */
function inferCalendarType(
  calendarId: string,
): 'work' | 'personal' | 'other' {
  // Primary calendar is typically the user's email
  if (calendarId === 'primary' || calendarId.includes('@gmail.com')) {
    return 'personal';
  }
  return 'work';
}

export class GoogleCalendarAdapter implements LifeAdapter {
  readonly source = 'google-calendar' as const;
  readonly domains = ['time' as const];

  private calendarApi: calendar_v3.Calendar;

  constructor(config: GoogleCalendarConfig) {
    const auth = new google.auth.OAuth2(
      config.clientId,
      config.clientSecret,
    );
    auth.setCredentials({ refresh_token: config.refreshToken });
    this.calendarApi = google.calendar({ version: 'v3', auth });
  }

  async sync(cursor: SyncCursor | null): Promise<AdapterResult> {
    const events: LifeEvent[] = [];
    let nextSyncToken: string | null = null;
    let pageToken: string | undefined;

    // If cursor is a syncToken from a previous sync, use it for incremental sync
    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId: 'primary',
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
    };

    if (cursor) {
      // Incremental sync: Google requires removing singleEvents/orderBy when using syncToken
      params.syncToken = cursor;
      delete params.singleEvents;
      delete params.orderBy;
    } else {
      // Initial sync: fetch events from the last 30 days
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      params.timeMin = thirtyDaysAgo.toISOString();
    }

    do {
      if (pageToken) {
        params.pageToken = pageToken;
      }

      // Spread params so later mutations don't affect this call's snapshot
      const callParams = { ...params };
      const response = await this.calendarApi.events.list(callParams);
      const data = response.data;

      if (data.items) {
        for (const item of data.items) {
          const mapped = this.mapEventToLifeEvent(item);
          if (mapped) {
            events.push(mapped);
          }
        }
      }

      pageToken = data.nextPageToken ?? undefined;
      if (data.nextSyncToken) {
        nextSyncToken = data.nextSyncToken;
      }

      // Remove syncToken for subsequent pages (Google API requirement)
      delete params.syncToken;
    } while (pageToken);

    return {
      events,
      nextCursor: nextSyncToken ?? cursor ?? '',
      hasMore: false, // Google Calendar API handles pagination internally
    };
  }

  async healthCheck(): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.calendarApi.calendarList.list({ maxResults: 1 });
      return { ok: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message };
    }
  }

  manifest(): AdapterManifest {
    return {
      source: 'google-calendar',
      description:
        'Calendar event metadata from Google Calendar (no titles, no attendee names)',
      domains: ['time'],
      maxPrivacyLevel: 'private',
      defaultSyncIntervalMinutes: 10,
      collectsFields: [
        'Event start time, end time, duration',
        'Is recurring (boolean)',
        'Attendee count (integer only)',
        'Calendar ID (hashed, not raw)',
        'Rough category (work/personal, inferred from calendar ID)',
      ],
      refusesFields: [
        'Event title or description',
        'Attendee names or email addresses',
        'Video conference links',
        'Event location',
        'Attached files or notes',
      ],
    };
  }

  private mapEventToLifeEvent(
    event: calendar_v3.Schema$Event,
  ): LifeEvent | null {
    if (!event.id) return null;

    // Determine start/end timestamps
    const startStr =
      event.start?.dateTime ?? event.start?.date ?? null;
    const endStr = event.end?.dateTime ?? event.end?.date ?? null;

    if (!startStr) return null;

    const startMs = new Date(startStr).getTime();
    const endMs = endStr ? new Date(endStr).getTime() : startMs;
    const durationMinutes = Math.round((endMs - startMs) / 60000);

    // Attendee count — integer only, no names/emails
    const attendeeCount = event.attendees?.length ?? 0;

    // Calendar ID hashed for privacy
    const rawCalendarId = event.organizer?.email ?? 'primary';
    const calendarType = inferCalendarType(rawCalendarId);

    const payload: TimePayload = {
      domain: 'time',
      subtype: 'calendar-event',
      durationMinutes: durationMinutes > 0 ? durationMinutes : undefined,
      attendeeCount,
      isRecurring: !!event.recurringEventId,
      calendarType,
    };

    return {
      id: randomUUID(),
      source: 'google-calendar',
      sourceId: event.id,
      domain: 'time',
      eventType: 'calendar-event',
      timestamp: startMs,
      ingestedAt: Date.now(),
      payload,
      embedding: null,
      summary: null,
      privacyLevel: 'private',
      confidence: 1.0,
    };
  }
}
