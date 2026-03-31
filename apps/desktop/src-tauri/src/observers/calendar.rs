// ---------------------------------------------------------------------------
// Calendar Observer — reads upcoming events from macOS Calendar (EventKit)
//
// Uses the EventKit SQLite database directly (avoids EventKit framework
// which requires a running NSApplication event loop).
// Requires Full Disk Access on macOS.
//
// Emits domain="time", subtype="calendar-event" events.
// Only captures: title, duration, attendee count, recurrence, calendar type.
// Does NOT capture: event notes, attendee names/emails, location details.
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct CalendarObserver {
    /// Track the last event end time we've seen to avoid re-emitting
    last_sync_time: Mutex<i64>,
}

impl CalendarObserver {
    pub fn new() -> Self {
        Self {
            last_sync_time: Mutex::new(chrono::Utc::now().timestamp_millis()),
        }
    }

    fn calendar_db_path() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        // macOS Calendar stores data in ~/Library/Calendars/Calendar Cache
        let path = PathBuf::from(&home).join("Library/Calendars/Calendar Cache");
        if path.exists() {
            return Some(path);
        }
        // Alternative location
        let path2 =
            PathBuf::from(&home).join("Library/Group Containers/group.com.apple.calendar/Calendar Cache");
        if path2.exists() {
            Some(path2)
        } else {
            None
        }
    }

    fn read_upcoming_events(&self, since_ms: i64) -> Vec<CalendarEvent> {
        let path = match Self::calendar_db_path() {
            Some(p) => p,
            None => return vec![],
        };

        let conn = match rusqlite::Connection::open_with_flags(
            &path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        // CoreData epoch is 2001-01-01 (same as macOS absolute time)
        const CORE_DATA_EPOCH: i64 = 978_307_200;
        let since_cd = (since_ms / 1000) - CORE_DATA_EPOCH;

        // Query the CalendarItem table for events in the near future
        let query = r#"
            SELECT
                ci.ZSUMMARY,
                ci.ZSTARTDATE,
                ci.ZENDDATE,
                ci.ZHASRECURRENCERULES,
                cal.ZTITLE as calendar_title
            FROM ZCALENDARITEM ci
            LEFT JOIN ZCALENDAR cal ON ci.ZCALENDAR = cal.Z_PK
            WHERE ci.ZSTARTDATE > ?1
            AND ci.ZSTARTDATE < ?1 + 86400
            ORDER BY ci.ZSTARTDATE ASC
            LIMIT 50
        "#;

        let mut stmt = match conn.prepare(query) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt
            .query_map([since_cd as f64], |row| {
                Ok(CalendarEvent {
                    title: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                    start_date: row.get::<_, f64>(1)?,
                    end_date: row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    is_recurring: row.get::<_, Option<i32>>(3)?.unwrap_or(0) != 0,
                    calendar_title: row
                        .get::<_, Option<String>>(4)?
                        .unwrap_or_default(),
                })
            })
            .ok();

        match rows {
            Some(r) => r.filter_map(|r| r.ok()).collect(),
            None => vec![],
        }
    }
}

struct CalendarEvent {
    title: String,
    start_date: f64,  // CoreData timestamp (seconds since 2001-01-01)
    end_date: f64,
    is_recurring: bool,
    calendar_title: String,
}

impl CalendarEvent {
    fn start_millis(&self) -> i64 {
        const CORE_DATA_EPOCH: i64 = 978_307_200;
        ((self.start_date as i64) + CORE_DATA_EPOCH) * 1000
    }

    fn duration_minutes(&self) -> i64 {
        if self.end_date > self.start_date {
            ((self.end_date - self.start_date) / 60.0).round() as i64
        } else {
            0
        }
    }

    fn calendar_type(&self) -> &str {
        let lower = self.calendar_title.to_lowercase();
        if lower.contains("work") || lower.contains("office") {
            "work"
        } else if lower.contains("health") || lower.contains("fitness") {
            "health"
        } else {
            "personal"
        }
    }
}

#[async_trait::async_trait]
impl Observer for CalendarObserver {
    fn name(&self) -> &str {
        "calendar"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos") && Self::calendar_db_path().is_some()
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let mut last = self.last_sync_time.lock().unwrap();
        let since = *last;
        let now = chrono::Utc::now().timestamp_millis();
        *last = now;
        drop(last);

        let events = self.read_upcoming_events(since);

        events
            .into_iter()
            .map(|e| {
                let source_id =
                    format!("cal:{}:{}", e.start_millis(), e.title.len());
                ObserverEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: "macos-calendar".to_string(),
                    source_id,
                    domain: "time".to_string(),
                    event_type: "calendar-event".to_string(),
                    timestamp: e.start_millis(),
                    ingested_at: now,
                    payload: json!({
                        "domain": "time",
                        "subtype": "calendar-event",
                        "title": e.title,
                        "durationMinutes": e.duration_minutes(),
                        "isRecurring": e.is_recurring,
                        "calendarType": e.calendar_type(),
                    }),
                    privacy_level: "private".to_string(),
                    confidence: 1.0,
                }
            })
            .collect()
    }

    fn interval_secs(&self) -> u64 {
        300 // Check every 5 minutes
    }
}
