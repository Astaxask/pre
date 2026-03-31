// ---------------------------------------------------------------------------
// iMessage Observer — reads message metadata from chat.db (macOS)
//
// Requires Full Disk Access permission on macOS.
// PRIVACY: Never reads message content. Only extracts:
//   - SHA-256 hash of contact identifier (for relationship tracking)
//   - Message count per conversation
//   - Whether it's a group chat
//   - Participant count
//   - Direction (sent/received)
// Emits domain="people", subtype="communication", channel="imessage"
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct IMessageObserver {
    last_rowid: Mutex<i64>,
}

impl IMessageObserver {
    pub fn new() -> Self {
        Self {
            last_rowid: Mutex::new(0),
        }
    }

    fn chat_db_path() -> Option<PathBuf> {
        let home = std::env::var("HOME").ok()?;
        let path = PathBuf::from(home).join("Library/Messages/chat.db");
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    fn hash_contact(identifier: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(identifier.as_bytes());
        format!("{:x}", hasher.finalize())[..16].to_string()
    }

    fn read_recent_messages(&self, since_rowid: i64) -> Vec<MessageMeta> {
        let path = match Self::chat_db_path() {
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

        // Query messages joined with chat_message_join and chat to get conversation info
        let query = r#"
            SELECT
                m.ROWID,
                m.is_from_me,
                m.date,
                c.chat_identifier,
                c.style,
                (SELECT COUNT(*) FROM chat_handle_join WHERE chat_id = c.ROWID) as participant_count
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE m.ROWID > ?1
            ORDER BY m.ROWID ASC
            LIMIT 500
        "#;

        let mut stmt = match conn.prepare(query) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt
            .query_map([since_rowid], |row| {
                Ok(MessageMeta {
                    rowid: row.get(0)?,
                    is_from_me: row.get::<_, i32>(1)? != 0,
                    date: row.get(2)?,
                    chat_identifier: row.get(3)?,
                    style: row.get(4)?,
                    participant_count: row.get(5)?,
                })
            })
            .ok();

        match rows {
            Some(r) => r.filter_map(|r| r.ok()).collect(),
            None => vec![],
        }
    }
}

struct MessageMeta {
    rowid: i64,
    is_from_me: bool,
    date: i64,           // macOS absolute time (seconds since 2001-01-01)
    chat_identifier: String,
    style: i64,           // 43 = group, 45 = individual
    participant_count: i64,
}

impl MessageMeta {
    /// Convert macOS absolute time to Unix millis
    fn timestamp_millis(&self) -> i64 {
        // macOS absolute time epoch: 2001-01-01 00:00:00 UTC
        // In nanoseconds since iOS 11 / macOS High Sierra
        const MACOS_EPOCH_OFFSET: i64 = 978_307_200;
        let secs = if self.date > 1_000_000_000_000 {
            // Nanoseconds
            self.date / 1_000_000_000
        } else {
            self.date
        };
        (secs + MACOS_EPOCH_OFFSET) * 1000
    }
}

#[async_trait::async_trait]
impl Observer for IMessageObserver {
    fn name(&self) -> &str {
        "imessage"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos") && Self::chat_db_path().is_some()
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let mut last_id = self.last_rowid.lock().unwrap();
        let since = *last_id;

        let messages = self.read_recent_messages(since);
        if messages.is_empty() {
            return vec![];
        }

        // Update last seen rowid
        if let Some(max) = messages.iter().map(|m| m.rowid).max() {
            *last_id = max;
        }
        drop(last_id);

        // Aggregate by chat: count messages per conversation in this batch
        use std::collections::HashMap;
        struct ChatAgg {
            sent: u32,
            received: u32,
            is_group: bool,
            participant_count: i64,
            latest_ts: i64,
        }

        let mut chats: HashMap<String, ChatAgg> = HashMap::new();
        for m in &messages {
            let entry = chats
                .entry(m.chat_identifier.clone())
                .or_insert(ChatAgg {
                    sent: 0,
                    received: 0,
                    is_group: m.style == 43,
                    participant_count: m.participant_count,
                    latest_ts: m.timestamp_millis(),
                });
            if m.is_from_me {
                entry.sent += 1;
            } else {
                entry.received += 1;
            }
            let ts = m.timestamp_millis();
            if ts > entry.latest_ts {
                entry.latest_ts = ts;
            }
        }

        let now = chrono::Utc::now().timestamp_millis();
        chats
            .into_iter()
            .flat_map(|(chat_id, agg)| {
                let contact_hash = IMessageObserver::hash_contact(&chat_id);
                let mut events = Vec::new();

                if agg.sent > 0 {
                    events.push(ObserverEvent {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: "macos-messages".to_string(),
                        source_id: format!("imsg:{}:sent:{}", contact_hash, since),
                        domain: "people".to_string(),
                        event_type: "communication".to_string(),
                        timestamp: agg.latest_ts,
                        ingested_at: now,
                        payload: json!({
                            "domain": "people",
                            "subtype": "communication",
                            "channel": "imessage",
                            "direction": "sent",
                            "contactId": contact_hash,
                            "messageCount": agg.sent,
                            "isGroup": agg.is_group,
                            "participantCount": agg.participant_count,
                        }),
                        privacy_level: "private".to_string(),
                        confidence: 1.0,
                    });
                }

                if agg.received > 0 {
                    events.push(ObserverEvent {
                        id: uuid::Uuid::new_v4().to_string(),
                        source: "macos-messages".to_string(),
                        source_id: format!("imsg:{}:recv:{}", contact_hash, since),
                        domain: "people".to_string(),
                        event_type: "communication".to_string(),
                        timestamp: agg.latest_ts,
                        ingested_at: now,
                        payload: json!({
                            "domain": "people",
                            "subtype": "communication",
                            "channel": "imessage",
                            "direction": "received",
                            "contactId": contact_hash,
                            "messageCount": agg.received,
                            "isGroup": agg.is_group,
                            "participantCount": agg.participant_count,
                        }),
                        privacy_level: "private".to_string(),
                        confidence: 1.0,
                    });
                }

                events
            })
            .collect()
    }

    fn interval_secs(&self) -> u64 {
        30 // Check every 30 seconds
    }
}
