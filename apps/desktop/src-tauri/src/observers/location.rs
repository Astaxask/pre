// ---------------------------------------------------------------------------
// Location Observer — coarse location context (macOS)
//
// PRIVACY: Never stores GPS coordinates or addresses.
// Only classifies location as: home | work | commuting | traveling | other
// Uses CoreLocation via the Objective-C bridge, but rounds coordinates to
// ~1km grid cells and only compares against user-defined home/work zones.
//
// Emits domain="world", subtype="location-context"
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq)]
enum LocationType {
    Home,
    Work,
    Commuting,
    Traveling,
    Other,
}

impl LocationType {
    fn as_str(&self) -> &'static str {
        match self {
            LocationType::Home => "home",
            LocationType::Work => "work",
            LocationType::Commuting => "commuting",
            LocationType::Traveling => "traveling",
            LocationType::Other => "other",
        }
    }
}

pub struct LocationObserver {
    last_type: Mutex<LocationType>,
    last_change: Mutex<i64>,
    /// Rounded home location (set during onboarding or auto-detected)
    home_grid: Mutex<Option<(i32, i32)>>,
    /// Rounded work location
    work_grid: Mutex<Option<(i32, i32)>>,
}

impl LocationObserver {
    pub fn new() -> Self {
        Self {
            last_type: Mutex::new(LocationType::Other),
            last_change: Mutex::new(chrono::Utc::now().timestamp_millis()),
            home_grid: Mutex::new(None),
            work_grid: Mutex::new(None),
        }
    }

    /// Round coordinates to ~1km grid cell (privacy: no precise location stored)
    fn to_grid(lat: f64, lon: f64) -> (i32, i32) {
        // ~0.01 degrees ≈ 1.1km at equator
        ((lat * 100.0).round() as i32, (lon * 100.0).round() as i32)
    }

    fn classify_location(&self, lat: f64, lon: f64) -> LocationType {
        let grid = Self::to_grid(lat, lon);
        let home = self.home_grid.lock().unwrap();
        let work = self.work_grid.lock().unwrap();

        if home.map_or(false, |h| h == grid) {
            LocationType::Home
        } else if work.map_or(false, |w| w == grid) {
            LocationType::Work
        } else {
            LocationType::Other
        }
    }

    /// Auto-learn home location (most frequent night-time location)
    pub fn set_home(&self, lat: f64, lon: f64) {
        *self.home_grid.lock().unwrap() = Some(Self::to_grid(lat, lon));
    }

    pub fn set_work(&self, lat: f64, lon: f64) {
        *self.work_grid.lock().unwrap() = Some(Self::to_grid(lat, lon));
    }

    #[cfg(target_os = "macos")]
    fn get_current_location(&self) -> Option<(f64, f64)> {
        // CoreLocation requires a running CFRunLoop which is complex to set up
        // in a background thread. For now, this returns None and we rely on
        // the mobile app's location data. A full implementation would use
        // CLLocationManager with a delegate.
        //
        // TODO: Implement CLLocationManager delegate via objc2 bindings
        None
    }

    #[cfg(not(target_os = "macos"))]
    fn get_current_location(&self) -> Option<(f64, f64)> {
        None
    }
}

#[async_trait::async_trait]
impl Observer for LocationObserver {
    fn name(&self) -> &str {
        "location"
    }

    fn is_available(&self) -> bool {
        // Location is theoretically available on macOS but requires
        // explicit user authorization + entitlements
        cfg!(target_os = "macos")
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let (lat, lon) = match self.get_current_location() {
            Some(coords) => coords,
            None => return vec![],
        };

        let current_type = self.classify_location(lat, lon);
        let now = chrono::Utc::now().timestamp_millis();

        let mut last = self.last_type.lock().unwrap();
        let mut since = self.last_change.lock().unwrap();

        if current_type == *last {
            return vec![];
        }

        let prev_type = *last;
        let prev_since = *since;
        *last = current_type;
        *since = now;
        drop(last);
        drop(since);

        let duration_secs = ((now - prev_since) as f64 / 1000.0).round() as i64;

        if duration_secs < 60 {
            return vec![]; // Skip very brief location changes
        }

        let source_id = format!("loc:{}:{}", prev_type.as_str(), prev_since);
        vec![ObserverEvent::new(
            "macos-location",
            &source_id,
            "world",
            "location-context",
            json!({
                "domain": "world",
                "subtype": "location-context",
                "locationType": prev_type.as_str(),
            }),
        )]
    }

    fn interval_secs(&self) -> u64 {
        120 // Check every 2 minutes
    }
}
