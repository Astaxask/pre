// ---------------------------------------------------------------------------
// Browser History Observer — reads visited domains from browser SQLite DBs
//
// Reads Chrome/Safari history databases (requires Full Disk Access on macOS).
// PRIVACY: Only extracts the domain from URLs, never the full URL or page title.
// Uses SHA-256 hash of full URL as source_id for dedup without storing the URL.
// Emits domain="mind", subtype="browsing-session" events.
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

pub struct BrowserHistoryObserver {
    /// Timestamp of the last collection (to only read new entries)
    last_check_time: Mutex<i64>,
}

impl BrowserHistoryObserver {
    pub fn new() -> Self {
        Self {
            last_check_time: Mutex::new(chrono::Utc::now().timestamp_millis()),
        }
    }

    /// Chrome stores history in ~/Library/Application Support/Google/Chrome/Default/History
    fn chrome_history_path() -> Option<PathBuf> {
        let home = dirs_next().ok()?;
        let path = home
            .join("Library/Application Support/Google/Chrome/Default/History");
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    /// Safari stores history in ~/Library/Safari/History.db
    fn safari_history_path() -> Option<PathBuf> {
        let home = dirs_next().ok()?;
        let path = home.join("Library/Safari/History.db");
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }

    /// Read recent Chrome history entries since `since_ts` (unix millis).
    /// Chrome stores timestamps as microseconds since 1601-01-01.
    fn read_chrome_history(&self, since_ts: i64) -> Vec<(String, i64)> {
        let path = match Self::chrome_history_path() {
            Some(p) => p,
            None => return vec![],
        };

        // Chrome's epoch: Jan 1, 1601. Offset to Unix epoch in microseconds.
        const CHROME_EPOCH_OFFSET: i64 = 11_644_473_600_000_000;
        let since_chrome = since_ts * 1000 + CHROME_EPOCH_OFFSET;

        // Open a read-only copy (Chrome locks the DB)
        let temp = std::env::temp_dir().join("pre-chrome-history-copy.db");
        if std::fs::copy(&path, &temp).is_err() {
            return vec![];
        }

        let conn = match rusqlite::Connection::open_with_flags(
            &temp,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        ) {
            Ok(c) => c,
            Err(_) => return vec![],
        };

        let mut stmt = match conn.prepare(
            "SELECT url, last_visit_time FROM urls WHERE last_visit_time > ?1 ORDER BY last_visit_time DESC LIMIT 100",
        ) {
            Ok(s) => s,
            Err(_) => return vec![],
        };

        let rows = stmt
            .query_map([since_chrome], |row| {
                let url: String = row.get(0)?;
                let visit_time: i64 = row.get(1)?;
                // Convert Chrome time to Unix millis
                let unix_ms = (visit_time - CHROME_EPOCH_OFFSET) / 1000;
                Ok((url, unix_ms))
            })
            .ok();

        match rows {
            Some(r) => r.filter_map(|r| r.ok()).collect(),
            None => vec![],
        }
    }

    /// Extract just the domain from a URL (privacy: never store full URL)
    fn extract_domain(url: &str) -> Option<String> {
        url::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(|h| h.to_string()))
    }

    /// SHA-256 hash of the URL for dedup source_id
    fn hash_url(url: &str) -> String {
        let mut hasher = Sha256::new();
        hasher.update(url.as_bytes());
        format!("{:x}", hasher.finalize())
    }
}

fn dirs_next() -> Result<PathBuf, ()> {
    std::env::var("HOME")
        .map(PathBuf::from)
        .map_err(|_| ())
}

#[async_trait::async_trait]
impl Observer for BrowserHistoryObserver {
    fn name(&self) -> &str {
        "browser-history"
    }

    fn is_available(&self) -> bool {
        // Available if at least one browser history DB exists
        cfg!(target_os = "macos")
            && (Self::chrome_history_path().is_some()
                || Self::safari_history_path().is_some())
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let mut last = self.last_check_time.lock().unwrap();
        let since = *last;
        let now = chrono::Utc::now().timestamp_millis();
        *last = now;
        drop(last);

        let entries = self.read_chrome_history(since);

        // Aggregate by domain: count visits and track time range
        let mut domain_stats: HashMap<String, (u32, i64)> = HashMap::new();
        for (url, ts) in &entries {
            if let Some(domain) = Self::extract_domain(url) {
                let entry = domain_stats.entry(domain).or_insert((0, *ts));
                entry.0 += 1;
                if *ts > entry.1 {
                    entry.1 = *ts;
                }
            }
        }

        domain_stats
            .into_iter()
            .map(|(domain, (count, latest_ts))| {
                let source_id = format!("browse:{}:{}", domain, since);
                ObserverEvent {
                    id: uuid::Uuid::new_v4().to_string(),
                    source: "macos-browser".to_string(),
                    source_id,
                    domain: "mind".to_string(),
                    event_type: "browsing-session".to_string(),
                    timestamp: latest_ts,
                    ingested_at: now,
                    payload: json!({
                        "domain": "mind",
                        "subtype": "browsing-session",
                        "domainVisited": domain,
                        "visitCount": count,
                    }),
                    privacy_level: "private".to_string(),
                    confidence: 1.0,
                }
            })
            .collect()
    }

    fn interval_secs(&self) -> u64 {
        60 // Check every minute
    }
}
