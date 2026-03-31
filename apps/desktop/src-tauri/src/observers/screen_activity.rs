// ---------------------------------------------------------------------------
// Screen Activity Observer — detects active/idle/locked state (macOS)
//
// Uses CGEventSource to check seconds since last HID event (mouse/keyboard).
// Emits domain="time", subtype="screen-session" events on state transitions.
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
enum ScreenState {
    Active,
    Idle,
    Locked,
}

pub struct ScreenActivityObserver {
    idle_threshold_secs: f64,
    last_state: Mutex<ScreenState>,
    state_since: Mutex<i64>,
}

impl ScreenActivityObserver {
    pub fn new() -> Self {
        Self {
            idle_threshold_secs: 300.0, // 5 minutes = idle
            last_state: Mutex::new(ScreenState::Active),
            state_since: Mutex::new(chrono::Utc::now().timestamp_millis()),
        }
    }

    #[cfg(target_os = "macos")]
    fn get_idle_seconds(&self) -> f64 {
        // CGEventSourceSecondsSinceLastEventType with kCGEventSourceStateCombinedSessionState
        // Source state 0 = combined session state, event type 0xFFFFFFFF = any event
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(
                source_state: i32,
                event_type: u32,
            ) -> f64;
        }
        unsafe { CGEventSourceSecondsSinceLastEventType(0, 0xFFFFFFFF) }
    }

    #[cfg(not(target_os = "macos"))]
    fn get_idle_seconds(&self) -> f64 {
        0.0
    }

    #[cfg(target_os = "macos")]
    fn is_screen_locked(&self) -> bool {
        // Check via CGSessionCopyCurrentDictionary for "CGSSessionScreenIsLocked"
        extern "C" {
            fn CGSessionCopyCurrentDictionary() -> *const std::ffi::c_void;
        }
        // Simplified: if idle > 30 minutes, assume locked for now
        // A proper implementation would read the session dictionary
        self.get_idle_seconds() > 1800.0
    }

    #[cfg(not(target_os = "macos"))]
    fn is_screen_locked(&self) -> bool {
        false
    }

    fn current_state(&self) -> ScreenState {
        if self.is_screen_locked() {
            ScreenState::Locked
        } else if self.get_idle_seconds() > self.idle_threshold_secs {
            ScreenState::Idle
        } else {
            ScreenState::Active
        }
    }
}

impl ScreenState {
    fn as_str(&self) -> &'static str {
        match self {
            ScreenState::Active => "active",
            ScreenState::Idle => "idle",
            ScreenState::Locked => "locked",
        }
    }
}

#[async_trait::async_trait]
impl Observer for ScreenActivityObserver {
    fn name(&self) -> &str {
        "screen-activity"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let current = self.current_state();
        let now = chrono::Utc::now().timestamp_millis();

        let mut last = self.last_state.lock().unwrap();
        let mut since = self.state_since.lock().unwrap();

        if current == *last {
            return vec![];
        }

        // State changed — emit an event for the previous state's duration
        let duration_secs = ((now - *since) as f64 / 1000.0).round() as i64;
        let prev_state = *last;

        *last = current;
        *since = now;

        if duration_secs < 5 {
            return vec![]; // Skip very brief transitions
        }

        let source_id = format!("screen:{}:{}", prev_state.as_str(), *since);
        vec![ObserverEvent::new(
            "macos-screen",
            &source_id,
            "time",
            "screen-session",
            json!({
                "domain": "time",
                "subtype": "screen-session",
                "screenState": prev_state.as_str(),
                "idleDurationSeconds": if prev_state != ScreenState::Active { duration_secs } else { 0 },
                "sessionDurationSeconds": duration_secs,
            }),
        )]
    }

    fn interval_secs(&self) -> u64 {
        10 // Check every 10 seconds
    }
}
