// ---------------------------------------------------------------------------
// Gateway Client — pushes observer events to the PRE gateway via WebSocket
//
// Features:
// - Connects to the gateway's WebSocket endpoint
// - Buffers events locally in SQLite WAL when gateway is unreachable
// - Automatically flushes the buffer when connection is restored
// - Batches events for efficient transmission
// ---------------------------------------------------------------------------

use super::ObserverEvent;
use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};

const GATEWAY_URL: &str = "ws://127.0.0.1:18789";
const BATCH_SIZE: usize = 50;
const FLUSH_INTERVAL_SECS: u64 = 5;

pub struct GatewayClient {
    buffer_db: Arc<Mutex<Connection>>,
    event_rx: mpsc::Receiver<ObserverEvent>,
}

impl GatewayClient {
    pub fn new(event_rx: mpsc::Receiver<ObserverEvent>) -> Result<Self, String> {
        let db_path = Self::buffer_db_path();

        // Ensure parent directory exists
        if let Some(parent) = db_path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let conn =
            Connection::open(&db_path).map_err(|e| format!("Failed to open buffer DB: {}", e))?;

        // Enable WAL mode for concurrent reads during flush
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| e.to_string())?;

        // Create the buffer table
        conn.execute(
            r#"
            CREATE TABLE IF NOT EXISTS event_buffer (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_json TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                sent INTEGER DEFAULT 0
            )
            "#,
            [],
        )
        .map_err(|e| e.to_string())?;

        Ok(Self {
            buffer_db: Arc::new(Mutex::new(conn)),
            event_rx,
        })
    }

    fn buffer_db_path() -> PathBuf {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        PathBuf::from(home)
            .join(".pre")
            .join("observer-buffer.db")
    }

    /// Main loop: receive events, buffer them, flush to gateway
    pub async fn run(mut self) {
        let db = self.buffer_db.clone();

        // Spawn the flush loop
        let flush_db = db.clone();
        tokio::spawn(async move {
            let mut interval =
                tokio::time::interval(tokio::time::Duration::from_secs(FLUSH_INTERVAL_SECS));
            loop {
                interval.tick().await;
                if let Err(e) = Self::flush_buffer(&flush_db).await {
                    log::debug!("Gateway flush failed (gateway may be offline): {}", e);
                }
            }
        });

        // Receive events and write to buffer
        while let Some(event) = self.event_rx.recv().await {
            let json = match serde_json::to_string(&event) {
                Ok(j) => j,
                Err(e) => {
                    log::error!("Failed to serialize event: {}", e);
                    continue;
                }
            };

            let db = db.lock().await;
            let now = chrono::Utc::now().timestamp_millis();
            if let Err(e) = db.execute(
                "INSERT INTO event_buffer (event_json, created_at) VALUES (?1, ?2)",
                rusqlite::params![json, now],
            ) {
                log::error!("Failed to buffer event: {}", e);
            }
        }
    }

    /// Try to send buffered events to the gateway
    async fn flush_buffer(db: &Arc<Mutex<Connection>>) -> Result<(), String> {
        // Read unsent events
        let events: Vec<(i64, String)> = {
            let conn = db.lock().await;
            let mut stmt = conn
                .prepare(
                    "SELECT id, event_json FROM event_buffer WHERE sent = 0 ORDER BY id ASC LIMIT ?1",
                )
                .map_err(|e| e.to_string())?;

            let result: Vec<(i64, String)> = stmt.query_map([BATCH_SIZE as i64], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
            result
        };

        if events.is_empty() {
            return Ok(());
        }

        // Connect to gateway
        let (mut ws_stream, _) =
            tokio_tungstenite::connect_async(GATEWAY_URL)
                .await
                .map_err(|e| format!("WebSocket connect failed: {}", e))?;

        use futures_util::SinkExt;

        // Send events as a batch ingest message
        let event_jsons: Vec<serde_json::Value> = events
            .iter()
            .filter_map(|(_, json_str)| serde_json::from_str(json_str).ok())
            .collect();

        let batch_msg = serde_json::json!({
            "type": "ingest-events",
            "payload": {
                "events": event_jsons,
            }
        });

        let msg_text = serde_json::to_string(&batch_msg).map_err(|e| e.to_string())?;

        ws_stream
            .send(tokio_tungstenite::tungstenite::Message::Text(msg_text))
            .await
            .map_err(|e| format!("Failed to send batch: {}", e))?;

        // Mark events as sent
        let ids: Vec<i64> = events.iter().map(|(id, _)| *id).collect();
        let conn = db.lock().await;
        for id in &ids {
            let _ = conn.execute("UPDATE event_buffer SET sent = 1 WHERE id = ?1", [id]);
        }

        // Periodically clean up old sent events (keep last hour for debugging)
        let cutoff = chrono::Utc::now().timestamp_millis() - 3_600_000;
        let _ = conn.execute(
            "DELETE FROM event_buffer WHERE sent = 1 AND created_at < ?1",
            [cutoff],
        );

        log::info!("Flushed {} events to gateway", ids.len());
        Ok(())
    }
}
