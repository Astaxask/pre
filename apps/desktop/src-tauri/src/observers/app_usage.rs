// ---------------------------------------------------------------------------
// App Usage Observer — tracks which application is frontmost (macOS)
//
// Uses NSWorkspace.shared.frontmostApplication via objc2 bindings.
// Emits a LifeEvent with domain="time", subtype="app-session" each interval.
// Only records app bundle ID + name — never window titles or content.
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use std::sync::Mutex;

pub struct AppUsageObserver {
    /// Tracks the currently active app to detect switches
    last_app: Mutex<Option<ActiveApp>>,
    /// When the current app became frontmost (millis)
    session_start: Mutex<i64>,
}

#[derive(Clone, Debug)]
struct ActiveApp {
    bundle_id: String,
    name: String,
}

impl AppUsageObserver {
    pub fn new() -> Self {
        Self {
            last_app: Mutex::new(None),
            session_start: Mutex::new(chrono::Utc::now().timestamp_millis()),
        }
    }

    #[cfg(target_os = "macos")]
    fn get_frontmost_app(&self) -> Option<ActiveApp> {
        use objc2_app_kit::NSWorkspace;

        let workspace = NSWorkspace::sharedWorkspace();
        let app = workspace.frontmostApplication()?;

        let bundle_id = app
            .bundleIdentifier()
            .map(|s| s.to_string())
            .unwrap_or_default();

        let name = app
            .localizedName()
            .map(|s| s.to_string())
            .unwrap_or_default();

        Some(ActiveApp { bundle_id, name })
    }

    #[cfg(not(target_os = "macos"))]
    fn get_frontmost_app(&self) -> Option<ActiveApp> {
        None // Only supported on macOS
    }
}

#[async_trait::async_trait]
impl Observer for AppUsageObserver {
    fn name(&self) -> &str {
        "app-usage"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let current = match self.get_frontmost_app() {
            Some(app) => app,
            None => return vec![],
        };

        let mut events = Vec::new();
        let now = chrono::Utc::now().timestamp_millis();

        let mut last = self.last_app.lock().unwrap();
        let mut start = self.session_start.lock().unwrap();

        let switched = match &*last {
            Some(prev) => prev.bundle_id != current.bundle_id,
            None => true,
        };

        if switched {
            // Emit a session-end event for the previous app
            if let Some(prev) = last.take() {
                let duration_secs = ((now - *start) as f64 / 1000.0).round() as i64;
                if duration_secs > 2 {
                    // Skip sub-2s flickers
                    let source_id = format!(
                        "app-session:{}:{}",
                        prev.bundle_id, *start
                    );
                    events.push(ObserverEvent::new(
                        "macos-app-usage",
                        &source_id,
                        "time",
                        "app-session",
                        json!({
                            "domain": "time",
                            "subtype": "app-session",
                            "appBundleId": prev.bundle_id,
                            "appName": prev.name,
                            "sessionDurationSeconds": duration_secs,
                        }),
                    ));
                }
            }

            // Start tracking new app
            *last = Some(current);
            *start = now;
        }

        events
    }

    fn interval_secs(&self) -> u64 {
        5 // Check every 5 seconds
    }
}
