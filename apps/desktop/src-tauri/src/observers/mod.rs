// ---------------------------------------------------------------------------
// Observer infrastructure — passive data collection from OS-level signals
// ---------------------------------------------------------------------------
//
// Each observer implements `Observer` and runs on a tokio interval.
// The `ObserverManager` owns all observers and routes their events to the
// gateway client (or local buffer when the gateway is unreachable).
// ---------------------------------------------------------------------------

pub mod app_usage;
pub mod browser_history;
pub mod calendar;
pub mod gateway_client;
pub mod imessage;
pub mod location;
pub mod music;
pub mod screen_activity;

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

// ---------------------------------------------------------------------------
// ObserverEvent — the unified event envelope pushed to the gateway
// ---------------------------------------------------------------------------

/// A single observation from any OS-level observer.
/// Matches the gateway's LifeEvent shape but stays serializable as JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserverEvent {
    pub id: String,
    pub source: String,
    pub source_id: String,
    pub domain: String,
    pub event_type: String,
    pub timestamp: i64,
    pub ingested_at: i64,
    pub payload: serde_json::Value,
    pub privacy_level: String,
    pub confidence: f64,
}

impl ObserverEvent {
    pub fn new(
        source: &str,
        source_id: &str,
        domain: &str,
        event_type: &str,
        payload: serde_json::Value,
    ) -> Self {
        let now = chrono::Utc::now().timestamp_millis();
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            source: source.to_string(),
            source_id: source_id.to_string(),
            domain: domain.to_string(),
            event_type: event_type.to_string(),
            timestamp: now,
            ingested_at: now,
            payload,
            privacy_level: "private".to_string(), // OS-level data is always private
            confidence: 1.0,
        }
    }
}

// ---------------------------------------------------------------------------
// Observer trait — implemented by each data source
// ---------------------------------------------------------------------------

#[async_trait::async_trait]
pub trait Observer: Send + Sync {
    /// Human-readable name for logging (e.g. "app-usage", "browser-history")
    fn name(&self) -> &str;

    /// Check whether OS permissions are granted for this observer
    fn is_available(&self) -> bool;

    /// Collect current observations. Called on each tick interval.
    /// Returns zero or more events (may be empty if nothing changed).
    async fn collect(&self) -> Vec<ObserverEvent>;

    /// Suggested poll interval in seconds
    fn interval_secs(&self) -> u64;
}

// ---------------------------------------------------------------------------
// ObserverStatus — exposed to the frontend via Tauri command
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObserverStatus {
    pub name: String,
    pub enabled: bool,
    pub available: bool,
    pub last_collection: Option<i64>,
    pub events_collected: u64,
}

// ---------------------------------------------------------------------------
// ObserverManager — owns and orchestrates all observers
// ---------------------------------------------------------------------------

pub struct ObserverManager {
    observers: Vec<(Arc<dyn Observer>, bool)>, // (observer, enabled)
    event_tx: mpsc::Sender<ObserverEvent>,
    handles: Vec<JoinHandle<()>>,
    statuses: Arc<tokio::sync::Mutex<Vec<ObserverStatus>>>,
}

impl ObserverManager {
    pub fn new(event_tx: mpsc::Sender<ObserverEvent>) -> Self {
        Self {
            observers: Vec::new(),
            event_tx,
            handles: Vec::new(),
            statuses: Arc::new(tokio::sync::Mutex::new(Vec::new())),
        }
    }

    /// Register an observer. It will be started when `start_all()` is called.
    pub fn register(&mut self, observer: Arc<dyn Observer>) {
        let available = observer.is_available();
        let status = ObserverStatus {
            name: observer.name().to_string(),
            enabled: available, // auto-enable if permissions are granted
            available,
            last_collection: None,
            events_collected: 0,
        };

        // We'll initialize statuses in start_all after the lock
        self.observers.push((observer, available));

        // Use blocking to push status (we're not async here)
        let statuses = self.statuses.clone();
        tokio::task::block_in_place(|| {
            let rt = tokio::runtime::Handle::current();
            rt.block_on(async {
                statuses.lock().await.push(status);
            });
        });
    }

    /// Start polling loops for all enabled observers.
    pub fn start_all(&mut self) {
        for (i, (observer, enabled)) in self.observers.iter().enumerate() {
            if !enabled {
                log::info!(
                    "Observer '{}' skipped (not available or disabled)",
                    observer.name()
                );
                continue;
            }

            let obs = observer.clone();
            let tx = self.event_tx.clone();
            let statuses = self.statuses.clone();
            let interval = obs.interval_secs();

            let handle = tokio::spawn(async move {
                let mut ticker = tokio::time::interval(
                    tokio::time::Duration::from_secs(interval),
                );
                log::info!("Observer '{}' started (every {}s)", obs.name(), interval);

                loop {
                    ticker.tick().await;

                    match tokio::time::timeout(
                        tokio::time::Duration::from_secs(30),
                        obs.collect(),
                    )
                    .await
                    {
                        Ok(events) => {
                            let count = events.len();
                            for event in events {
                                if tx.send(event).await.is_err() {
                                    log::error!(
                                        "Observer '{}': event channel closed",
                                        obs.name()
                                    );
                                    return;
                                }
                            }

                            // Update status
                            if count > 0 {
                                let mut stats = statuses.lock().await;
                                if let Some(s) = stats.get_mut(i) {
                                    s.last_collection =
                                        Some(chrono::Utc::now().timestamp_millis());
                                    s.events_collected += count as u64;
                                }
                            }
                        }
                        Err(_) => {
                            log::warn!(
                                "Observer '{}': collection timed out",
                                obs.name()
                            );
                        }
                    }
                }
            });

            self.handles.push(handle);
        }
    }

    /// Get status of all observers (for Tauri command)
    pub async fn get_statuses(&self) -> Vec<ObserverStatus> {
        self.statuses.lock().await.clone()
    }

    /// Enable or disable an observer by name (takes effect on next collection cycle)
    pub async fn set_enabled(&self, name: &str, enabled: bool) -> bool {
        let mut stats = self.statuses.lock().await;
        if let Some(s) = stats.iter_mut().find(|s| s.name == name) {
            s.enabled = enabled;
            true
        } else {
            false
        }
    }

    /// Gracefully stop all observer loops
    pub fn stop_all(&mut self) {
        for handle in self.handles.drain(..) {
            handle.abort();
        }
    }
}
