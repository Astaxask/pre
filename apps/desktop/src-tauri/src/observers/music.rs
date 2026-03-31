// ---------------------------------------------------------------------------
// Music Observer — tracks currently playing media (macOS)
//
// Uses the MediaRemote private framework via FFI to read now-playing info.
// Captures: track title, artist name, album name.
// Does NOT capture: album art, lyrics, playback position.
//
// Emits domain="mind", subtype="now-playing"
// ---------------------------------------------------------------------------

use super::{Observer, ObserverEvent};
use serde_json::json;
use std::sync::Mutex;

#[derive(Clone, Debug, Default)]
struct NowPlaying {
    title: String,
    artist: String,
    album: String,
}

pub struct MusicObserver {
    last_track: Mutex<Option<NowPlaying>>,
    track_start: Mutex<i64>,
}

impl MusicObserver {
    pub fn new() -> Self {
        Self {
            last_track: Mutex::new(None),
            track_start: Mutex::new(chrono::Utc::now().timestamp_millis()),
        }
    }

    #[cfg(target_os = "macos")]
    fn get_now_playing(&self) -> Option<NowPlaying> {
        // Use AppleScript via osascript as a reliable fallback.
        // The MediaRemote framework requires private API access and is fragile.
        let output = std::process::Command::new("osascript")
            .args([
                "-e",
                r#"
                try
                    tell application "Music"
                        if player state is playing then
                            set t to name of current track
                            set a to artist of current track
                            set al to album of current track
                            return t & "|||" & a & "|||" & al
                        end if
                    end tell
                end try
                try
                    tell application "Spotify"
                        if player state is playing then
                            set t to name of current track
                            set a to artist of current track
                            set al to album of current track
                            return t & "|||" & a & "|||" & al
                        end if
                    end tell
                end try
                return ""
                "#,
            ])
            .output()
            .ok()?;

        let text = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if text.is_empty() {
            return None;
        }

        let parts: Vec<&str> = text.splitn(3, "|||").collect();
        if parts.len() >= 3 {
            Some(NowPlaying {
                title: parts[0].to_string(),
                artist: parts[1].to_string(),
                album: parts[2].to_string(),
            })
        } else {
            None
        }
    }

    #[cfg(not(target_os = "macos"))]
    fn get_now_playing(&self) -> Option<NowPlaying> {
        None
    }
}

#[async_trait::async_trait]
impl Observer for MusicObserver {
    fn name(&self) -> &str {
        "music"
    }

    fn is_available(&self) -> bool {
        cfg!(target_os = "macos")
    }

    async fn collect(&self) -> Vec<ObserverEvent> {
        let current = self.get_now_playing();
        let now = chrono::Utc::now().timestamp_millis();

        let mut last = self.last_track.lock().unwrap();
        let mut start = self.track_start.lock().unwrap();

        let changed = match (&*last, &current) {
            (Some(prev), Some(curr)) => prev.title != curr.title || prev.artist != curr.artist,
            (None, Some(_)) => true,
            (Some(_), None) => true,
            (None, None) => false,
        };

        if !changed {
            return vec![];
        }

        let mut events = Vec::new();

        // Emit event for the track that just finished / stopped
        if let Some(prev) = last.take() {
            let duration_secs = ((now - *start) as f64 / 1000.0).round() as i64;
            if duration_secs > 10 {
                // Skip very brief plays
                let source_id = format!(
                    "music:{}:{}:{}",
                    prev.artist.len(),
                    prev.title.len(),
                    *start
                );
                events.push(ObserverEvent::new(
                    "macos-music",
                    &source_id,
                    "mind",
                    "now-playing",
                    json!({
                        "domain": "mind",
                        "subtype": "now-playing",
                        "trackTitle": prev.title,
                        "artistName": prev.artist,
                        "albumName": prev.album,
                        "durationMinutes": (duration_secs as f64 / 60.0).round() as i64,
                    }),
                ));
            }
        }

        *last = current;
        *start = now;

        events
    }

    fn interval_secs(&self) -> u64 {
        15 // Check every 15 seconds
    }
}
