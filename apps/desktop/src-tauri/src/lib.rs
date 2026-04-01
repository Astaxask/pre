mod observers;

use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    WebviewWindowBuilder,
    tray::TrayIconBuilder,
};
use tokio::sync::mpsc;
use chrono::Timelike;

use observers::{
    ObserverManager, ObserverStatus,
    app_usage::AppUsageObserver,
    browser_history::BrowserHistoryObserver,
    calendar::CalendarObserver,
    gateway_client::GatewayClient,
    imessage::IMessageObserver,
    location::LocationObserver,
    music::MusicObserver,
    screen_activity::ScreenActivityObserver,
};

// ---------------------------------------------------------------------------
// TrayState — the four icon variants
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrayState {
    Idle,
    Alert,
    NeedsAttention,
    Offline,
}

impl Default for TrayState {
    fn default() -> Self {
        TrayState::Idle
    }
}

// ---------------------------------------------------------------------------
// Managed state
// ---------------------------------------------------------------------------

struct ManagedTrayState {
    current: Mutex<TrayState>,
}

struct ManagedObserverManager {
    manager: Arc<tokio::sync::Mutex<ObserverManager>>,
}

// ---------------------------------------------------------------------------
// Tray icon PNGs — embedded at compile time from build.rs output
// ---------------------------------------------------------------------------

static ICON_IDLE: &[u8] = include_bytes!("../icons/tray-idle.png");
static ICON_ALERT: &[u8] = include_bytes!("../icons/tray-alert.png");
static ICON_ATTENTION: &[u8] = include_bytes!("../icons/tray-attention.png");
static ICON_OFFLINE: &[u8] = include_bytes!("../icons/tray-offline.png");

const TRAY_ID: &str = "pre-tray";

fn icon_for_state(state: TrayState) -> &'static [u8] {
    match state {
        TrayState::Idle => ICON_IDLE,
        TrayState::Alert => ICON_ALERT,
        TrayState::NeedsAttention => ICON_ATTENTION,
        TrayState::Offline => ICON_OFFLINE,
    }
}

fn tooltip_for_state(state: TrayState) -> &'static str {
    match state {
        TrayState::Idle => "PRE \u{2014} Running",
        TrayState::Alert => "PRE \u{2014} New alert",
        TrayState::NeedsAttention => "PRE \u{2014} Action needed",
        TrayState::Offline => "PRE \u{2014} Gateway offline",
    }
}

// ---------------------------------------------------------------------------
// Tauri commands: tray state
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_tray_state(
    app: tauri::AppHandle,
    state: TrayState,
    managed: tauri::State<'_, ManagedTrayState>,
) -> Result<(), String> {
    let mut current = managed.current.lock().map_err(|e| e.to_string())?;
    if *current == state {
        return Ok(());
    }
    *current = state;
    drop(current);

    let tray = app.tray_by_id(TRAY_ID).ok_or("Tray icon not found")?;

    let png_bytes = icon_for_state(state);
    let image = tauri::image::Image::from_bytes(png_bytes)
        .map_err(|e| format!("Failed to decode icon: {}", e))?;

    tray.set_icon(Some(image))
        .map_err(|e| format!("Failed to set tray icon: {}", e))?;

    tray.set_tooltip(Some(tooltip_for_state(state)))
        .map_err(|e| format!("Failed to set tooltip: {}", e))?;

    Ok(())
}

#[tauri::command]
fn get_tray_state(
    managed: tauri::State<'_, ManagedTrayState>,
) -> Result<TrayState, String> {
    let current = managed.current.lock().map_err(|e| e.to_string())?;
    Ok(*current)
}

// ---------------------------------------------------------------------------
// Tauri commands: observer management
// ---------------------------------------------------------------------------

#[tauri::command]
async fn get_observer_status(
    managed: tauri::State<'_, ManagedObserverManager>,
) -> Result<Vec<ObserverStatus>, String> {
    let mgr = managed.manager.lock().await;
    Ok(mgr.get_statuses().await)
}

#[tauri::command]
async fn toggle_observer(
    name: String,
    enabled: bool,
    managed: tauri::State<'_, ManagedObserverManager>,
) -> Result<bool, String> {
    let mgr = managed.manager.lock().await;
    Ok(mgr.set_enabled(&name, enabled).await)
}

// ---------------------------------------------------------------------------
// Database helpers — persistent memory layer
// ---------------------------------------------------------------------------

fn pre_db_path() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::PathBuf::from(&home).join(".pre").join("observer-buffer.db")
}

fn open_db_rw() -> Result<rusqlite::Connection, String> {
    let db_path = pre_db_path();
    if !db_path.exists() {
        return Err("Buffer DB not found".to_string());
    }
    let conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("Failed to open DB: {}", e))?;
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
    Ok(conn)
}

fn open_db_ro() -> Result<rusqlite::Connection, String> {
    let db_path = pre_db_path();
    if !db_path.exists() {
        return Err("Buffer DB not found".to_string());
    }
    rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    ).map_err(|e| format!("Failed to open DB: {}", e))
}

/// Initialize memory tables (thoughts + core_memory)
fn init_memory_tables(conn: &rusqlite::Connection) -> Result<(), String> {
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS thoughts (
            id TEXT PRIMARY KEY,
            text TEXT NOT NULL,
            category TEXT NOT NULL DEFAULT 'reflection',
            importance TEXT NOT NULL DEFAULT 'ambient',
            source TEXT NOT NULL DEFAULT 'local',
            template_key TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            expired INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_thoughts_created ON thoughts(created_at);
        CREATE INDEX IF NOT EXISTS idx_thoughts_key ON thoughts(template_key);
        CREATE INDEX IF NOT EXISTS idx_thoughts_expired ON thoughts(expired);

        CREATE TABLE IF NOT EXISTS core_memory (
            label TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            version INTEGER NOT NULL DEFAULT 1
        );
    ").map_err(|e| format!("Failed to init memory tables: {}", e))
}

// ---------------------------------------------------------------------------
// Tauri commands: read local observation buffer (works without gateway)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_recent_observations(limit: Option<i64>) -> Result<Vec<serde_json::Value>, String> {
    let conn = match open_db_ro() {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),
    };

    let max = limit.unwrap_or(100);
    let mut stmt = conn
        .prepare("SELECT event_json FROM event_buffer ORDER BY created_at DESC LIMIT ?1")
        .map_err(|e| e.to_string())?;

    let results: Vec<serde_json::Value> = stmt
        .query_map([max], |row| {
            let json_str: String = row.get(0)?;
            Ok(json_str)
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .filter_map(|json_str| serde_json::from_str(&json_str).ok())
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// Tauri commands: persistent thought memory
// ---------------------------------------------------------------------------

/// Save thoughts to persistent storage. Updates existing by template_key.
#[tauri::command]
fn save_thoughts(thoughts: Vec<serde_json::Value>) -> Result<(), String> {
    let conn = open_db_rw()?;
    init_memory_tables(&conn)?;

    let now = chrono::Utc::now().timestamp_millis();

    for t in &thoughts {
        let id = t.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let text = t.get("text").and_then(|v| v.as_str()).unwrap_or("");
        let category = t.get("category").and_then(|v| v.as_str()).unwrap_or("reflection");
        let importance = t.get("importance").and_then(|v| v.as_str()).unwrap_or("ambient");
        let source = t.get("source").and_then(|v| v.as_str()).unwrap_or("local");
        let template_key = t.get("templateKey").and_then(|v| v.as_str()).unwrap_or(id);

        if text.is_empty() { continue; }

        // Upsert: if template_key exists, update text; else insert new
        conn.execute(
            "INSERT INTO thoughts (id, text, category, importance, source, template_key, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)
             ON CONFLICT(id) DO UPDATE SET text=?2, importance=?4, updated_at=?7",
            rusqlite::params![id, text, category, importance, source, template_key, now],
        ).map_err(|e| format!("Failed to save thought: {}", e))?;
    }

    // Expire old thoughts (older than 7 days)
    let week_ago = now - 7 * 24 * 60 * 60 * 1000;
    conn.execute(
        "UPDATE thoughts SET expired = 1 WHERE created_at < ?1 AND expired = 0",
        [week_ago],
    ).map_err(|e| e.to_string())?;

    Ok(())
}

/// Load persisted thoughts (non-expired, most recent first)
#[tauri::command]
fn load_thoughts(limit: Option<i64>) -> Result<Vec<serde_json::Value>, String> {
    let conn = match open_db_ro() {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),
    };

    // Check if thoughts table exists
    let table_exists: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='thoughts'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(vec![]);
    }

    let max = limit.unwrap_or(50);
    let mut stmt = conn
        .prepare(
            "SELECT id, text, category, importance, source, template_key, created_at, updated_at
             FROM thoughts WHERE expired = 0 ORDER BY updated_at DESC LIMIT ?1",
        )
        .map_err(|e| e.to_string())?;

    let results: Vec<serde_json::Value> = stmt
        .query_map([max], |row| {
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "text": row.get::<_, String>(1)?,
                "category": row.get::<_, String>(2)?,
                "importance": row.get::<_, String>(3)?,
                "source": row.get::<_, String>(4)?,
                "templateKey": row.get::<_, String>(5)?,
                "timestamp": row.get::<_, i64>(6)?,
                "updatedAt": row.get::<_, i64>(7)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

// ---------------------------------------------------------------------------
// Tauri commands: core memory (AI's persistent understanding)
// ---------------------------------------------------------------------------

/// Save or update a core memory block
#[tauri::command]
fn save_core_memory(label: String, value: String) -> Result<(), String> {
    let conn = open_db_rw()?;
    init_memory_tables(&conn)?;
    let now = chrono::Utc::now().timestamp_millis();

    conn.execute(
        "INSERT INTO core_memory (label, value, updated_at, version)
         VALUES (?1, ?2, ?3, 1)
         ON CONFLICT(label) DO UPDATE SET value=?2, updated_at=?3, version=version+1",
        rusqlite::params![label, value, now],
    ).map_err(|e| format!("Failed to save core memory: {}", e))?;

    Ok(())
}

/// Load all core memory blocks
#[tauri::command]
fn load_core_memory() -> Result<Vec<serde_json::Value>, String> {
    let conn = match open_db_ro() {
        Ok(c) => c,
        Err(_) => return Ok(vec![]),
    };

    let table_exists: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='core_memory'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);

    if !table_exists {
        return Ok(vec![]);
    }

    let mut stmt = conn
        .prepare("SELECT label, value, updated_at, version FROM core_memory ORDER BY label")
        .map_err(|e| e.to_string())?;

    let results: Vec<serde_json::Value> = stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "label": row.get::<_, String>(0)?,
                "value": row.get::<_, String>(1)?,
                "updatedAt": row.get::<_, i64>(2)?,
                "version": row.get::<_, i64>(3)?,
            }))
        })
        .map_err(|e| e.to_string())?
        .filter_map(|r| r.ok())
        .collect();

    Ok(results)
}

/// Generate human-readable observation stream from local buffer data.
/// This works entirely offline — no gateway or LLM needed.
#[tauri::command]
fn get_thinking_stream(limit: Option<i64>) -> Result<Vec<serde_json::Value>, String> {
    let observations = get_recent_observations(limit)?;
    let mut thoughts: Vec<serde_json::Value> = Vec::new();

    for obs in &observations {
        let event_type = obs.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
        let source = obs.get("source").and_then(|v| v.as_str()).unwrap_or("");
        let domain = obs.get("domain").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = obs.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let payload = obs.get("payload").cloned().unwrap_or(serde_json::Value::Null);

        let text = match event_type {
            "app-session" => {
                let app = payload.get("appName").and_then(|v| v.as_str()).unwrap_or("an app");
                let secs = payload.get("sessionDurationSeconds").and_then(|v| v.as_i64()).unwrap_or(0);
                if secs > 3600 {
                    format!("You spent {:.1} hours in {}. That's a deep session.", secs as f64 / 3600.0, app)
                } else if secs > 600 {
                    format!("Spent {} minutes in {}.", secs / 60, app)
                } else {
                    format!("Quick switch to {} ({} seconds).", app, secs)
                }
            }
            "browsing-session" => {
                let site = payload.get("domainVisited").and_then(|v| v.as_str()).unwrap_or("a website");
                let count = payload.get("visitCount").and_then(|v| v.as_i64()).unwrap_or(1);
                if count > 5 {
                    format!("Visited {} {} times — you keep coming back to this.", site, count)
                } else if count > 1 {
                    format!("Browsed {} ({} visits).", site, count)
                } else {
                    format!("Visited {}.", site)
                }
            }
            "now-playing" => {
                let track = payload.get("trackTitle").and_then(|v| v.as_str()).unwrap_or("something");
                let artist = payload.get("artistName").and_then(|v| v.as_str()).unwrap_or("");
                if artist.is_empty() {
                    format!("Listening to \"{}\".", track)
                } else {
                    format!("Listening to \"{}\" by {}.", track, artist)
                }
            }
            "screen-session" => {
                let state = payload.get("screenState").and_then(|v| v.as_str()).unwrap_or("unknown");
                let secs = payload.get("idleDurationSeconds").and_then(|v| v.as_i64()).unwrap_or(0);
                match state {
                    "idle" if secs > 1800 => format!("You've been away for {} minutes. Taking a break.", secs / 60),
                    "idle" => format!("Went idle for {} minutes.", secs / 60),
                    "active" => "Back at the screen.".to_string(),
                    _ => format!("Screen state: {}.", state),
                }
            }
            "communication" => {
                let direction = payload.get("direction").and_then(|v| v.as_str()).unwrap_or("sent");
                let count = payload.get("messageCount").and_then(|v| v.as_i64()).unwrap_or(1);
                let is_group = payload.get("isGroup").and_then(|v| v.as_bool()).unwrap_or(false);
                let chat_type = if is_group { "a group chat" } else { "a conversation" };
                if direction == "sent" {
                    format!("{} {} message{} in {}.",
                        if count > 5 { "Actively chatting —" } else { "Sent" },
                        count, if count != 1 { "s" } else { "" }, chat_type)
                } else {
                    format!("Received {} message{} in {}.", count, if count != 1 { "s" } else { "" }, chat_type)
                }
            }
            "calendar-event" => {
                let title = payload.get("title").and_then(|v| v.as_str()).unwrap_or("an event");
                let mins = payload.get("durationMinutes").and_then(|v| v.as_i64()).unwrap_or(0);
                if mins > 60 {
                    format!("\"{}\" — {:.1} hour block on your calendar.", title, mins as f64 / 60.0)
                } else {
                    format!("\"{}\" — {} min event.", title, mins)
                }
            }
            _ => {
                format!("{} observation from {}.", domain, source)
            }
        };

        thoughts.push(serde_json::json!({
            "text": text,
            "domain": domain,
            "event_type": event_type,
            "timestamp": timestamp,
            "source": source,
        }));
    }

    Ok(thoughts)
}

// ---------------------------------------------------------------------------
// Tauri command: AI thought generation via local Ollama
// ---------------------------------------------------------------------------

#[tauri::command]
async fn generate_ai_thoughts(limit: Option<i64>, custom_prompt: Option<String>) -> Result<Vec<serde_json::Value>, String> {
    // 1. Read recent observations
    let observations = get_recent_observations(limit)?;
    if observations.is_empty() {
        return Ok(vec![]);
    }

    // 2. Build COMPACT context — only 12 obs, short lines
    let now = chrono::Utc::now().timestamp_millis();
    let mut context_lines = Vec::new();

    for obs in observations.iter().take(12) {
        let event_type = obs.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
        let timestamp = obs.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);
        let payload = obs.get("payload");
        let ago_min = (now - timestamp) / 60000;

        let line = match event_type {
            "app-session" => {
                let app = payload.and_then(|p| p.get("appName")).and_then(|v| v.as_str()).unwrap_or("?");
                let secs = payload.and_then(|p| p.get("sessionDurationSeconds")).and_then(|v| v.as_i64()).unwrap_or(0);
                format!("{}m ago: {} {}s", ago_min, app, secs)
            }
            "browsing-session" => {
                let site = payload.and_then(|p| p.get("domainVisited")).and_then(|v| v.as_str()).unwrap_or("?");
                format!("{}m ago: browsed {}", ago_min, site)
            }
            "now-playing" => {
                let track = payload.and_then(|p| p.get("trackTitle")).and_then(|v| v.as_str()).unwrap_or("?");
                format!("{}m ago: playing {}", ago_min, track)
            }
            _ => format!("{}m ago: {}", ago_min, event_type),
        };
        context_lines.push(line);
    }

    let h = chrono::Local::now().hour();
    let time_ctx = if h < 6 { "late night" } else if h < 12 { "morning" } else if h < 17 { "afternoon" } else if h < 21 { "evening" } else { "night" };

    // 3. Load memory context — previous thoughts + core memory
    let mut memory_section = String::new();

    // Core memory (the AI's persistent understanding)
    let core = load_core_memory().unwrap_or_default();
    if !core.is_empty() {
        memory_section.push_str("What I know about you:\n");
        for block in core.iter().take(5) {
            let label = block.get("label").and_then(|v| v.as_str()).unwrap_or("");
            let value = block.get("value").and_then(|v| v.as_str()).unwrap_or("");
            if !value.is_empty() {
                memory_section.push_str(&format!("- {}: {}\n", label, value));
            }
        }
        memory_section.push('\n');
    }

    // Recent thoughts (what I was thinking before)
    let prev_thoughts = load_thoughts(Some(5)).unwrap_or_default();
    if !prev_thoughts.is_empty() {
        memory_section.push_str("My recent thoughts:\n");
        for t in prev_thoughts.iter().take(5) {
            let text = t.get("text").and_then(|v| v.as_str()).unwrap_or("");
            if !text.is_empty() {
                let short = if text.len() > 80 { &text[..80] } else { text };
                memory_section.push_str(&format!("- {}\n", short));
            }
        }
        memory_section.push('\n');
    }

    // 4. Build prompt — use custom prompt from frontend if provided, else default
    let prompt = if let Some(ref cp) = custom_prompt {
        cp.clone()
    } else {
        format!(
r#"You are PRE, a personal life strategist. It's {} {}.

{}Current activity:
{}

Write 2-3 ideas or provocations the user hasn't thought of. Don't describe what they're doing — reveal what it MEANS. Surface blind spots, hidden opportunities, uncomfortable truths. Be specific and direct.

Reply ONLY with JSON:
[{{"text":"...","category":"insight","importance":"notable"}}]
Categories: idea, blindspot, question, challenge, insight, prediction
Importance: notable, important"#,
            chrono::Local::now().format("%H:%M"),
            time_ctx,
            memory_section,
            context_lines.join("\n")
        )
    };

    // 5. Call Ollama
    let client = reqwest::Client::new();
    let ollama_request = serde_json::json!({
        "model": "llama3.1:8b",
        "prompt": prompt,
        "stream": false,
        "options": {
            "temperature": 0.85,
            "top_p": 0.9,
            "num_predict": 400,
            "num_ctx": 2048,
        }
    });

    let response = client
        .post("http://127.0.0.1:11434/api/generate")
        .json(&ollama_request)
        .timeout(std::time::Duration::from_secs(90))
        .send()
        .await
        .map_err(|e| format!("Ollama request failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Ollama returned status: {}", response.status()));
    }

    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Failed to parse Ollama response: {}", e))?;

    let text = body
        .get("response")
        .and_then(|v| v.as_str())
        .unwrap_or("[]");

    // 4. Parse JSON array from response
    // Try to extract JSON array even if wrapped in markdown fences
    let json_str = if let Some(start) = text.find('[') {
        if let Some(end) = text.rfind(']') {
            &text[start..=end]
        } else {
            "[]"
        }
    } else {
        "[]"
    };

    let thoughts: Vec<serde_json::Value> = serde_json::from_str(json_str).unwrap_or_else(|_| {
        // Fallback: wrap raw text as a single thought
        if !text.trim().is_empty() {
            vec![serde_json::json!({
                "text": text.trim(),
                "category": "reflection",
                "importance": "notable"
            })]
        } else {
            vec![]
        }
    });

    // 5. Add timestamps and IDs
    let result: Vec<serde_json::Value> = thoughts
        .into_iter()
        .map(|mut t| {
            if let Some(obj) = t.as_object_mut() {
                obj.insert("id".to_string(), serde_json::json!(uuid::Uuid::new_v4().to_string()));
                obj.insert("timestamp".to_string(), serde_json::json!(now));
            }
            t
        })
        .collect();

    Ok(result)
}

/// Check if Ollama is available locally
#[tauri::command]
async fn check_ai_status() -> Result<serde_json::Value, String> {
    let client = reqwest::Client::new();
    match client
        .get("http://127.0.0.1:11434/api/tags")
        .timeout(std::time::Duration::from_secs(3))
        .send()
        .await
    {
        Ok(resp) if resp.status().is_success() => {
            let body: serde_json::Value = resp.json().await.unwrap_or_default();
            let models: Vec<String> = body
                .get("models")
                .and_then(|m| m.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()).map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            Ok(serde_json::json!({
                "available": true,
                "models": models,
            }))
        }
        _ => Ok(serde_json::json!({
            "available": false,
            "models": [],
        })),
    }
}

// ---------------------------------------------------------------------------
// Tray popover commands
// ---------------------------------------------------------------------------

/// Hide the tray-popover window. Called from JS when the popover loses focus.
#[tauri::command]
fn close_tray_popover(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("tray-popover") {
        let _ = w.hide();
    }
    Ok(())
}

/// Show the main PRE window and hide the popover.
#[tauri::command]
fn open_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(popover) = app.get_webview_window("tray-popover") {
        let _ = popover.hide();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
    Ok(())
}

/// Returns up to 5 context-aware insights in priority order (fast, no LLM).
/// The tray popover cycles through these with the "next" button.
#[tauri::command]
fn get_tray_insight() -> Result<Vec<serde_json::Value>, String> {
    let observations = get_recent_observations(Some(80)).unwrap_or_default();
    let now = chrono::Utc::now().timestamp_millis();
    let hour = chrono::Local::now().hour();

    // ── Aggregate activity ────────────────────────────────────────────────
    let mut app_secs: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
    let mut kick_slugs: Vec<String> = vec![];
    let mut twitch_slugs: Vec<String> = vec![];
    let mut reddit_subs: Vec<String> = vec![];
    let mut yt_channels: Vec<String> = vec![];
    let mut gh_owners: Vec<String> = vec![];
    let mut unique_sites: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut recent_switches: i64 = 0;
    let mut chess_visits: i64 = 0;

    let dev_apps = ["Cursor", "VS Code", "Code", "Terminal", "iTerm2", "Xcode", "WebStorm"];

    for obs in &observations {
        let event_type = obs.get("event_type").and_then(|v| v.as_str()).unwrap_or("");
        let payload = obs.get("payload");
        let ts = obs.get("timestamp").and_then(|v| v.as_i64()).unwrap_or(0);

        match event_type {
            "app-session" => {
                let app_name = payload
                    .and_then(|p| p.get("appName"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let secs = payload
                    .and_then(|p| p.get("sessionDurationSeconds"))
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0);
                if !app_name.is_empty()
                    && !["WindowManager", "Finder", "loginwindow", "UserNotificationCenter", "Dock"]
                        .contains(&app_name.as_str())
                {
                    *app_secs.entry(app_name).or_insert(0) += secs;
                }
                if now - ts < 600_000 {
                    recent_switches += 1;
                }
            }
            "browsing-session" => {
                let domain = payload
                    .and_then(|p| p.get("domainVisited"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let slug = payload
                    .and_then(|p| p.get("pageSlug"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("");

                if !domain.is_empty() {
                    unique_sites.insert(domain.to_string());
                }
                if domain.contains("chess.com") || domain.contains("lichess.org") {
                    chess_visits += 1;
                }
                if !slug.is_empty() {
                    if domain.contains("kick.com") && !kick_slugs.contains(&slug.to_string()) {
                        kick_slugs.push(slug.to_string());
                    } else if domain.contains("twitch.tv") && !twitch_slugs.contains(&slug.to_string()) {
                        twitch_slugs.push(slug.to_string());
                    } else if domain.contains("reddit.com") && !reddit_subs.contains(&slug.to_string()) {
                        reddit_subs.push(slug.to_string());
                    } else if domain.contains("youtube.com") && !yt_channels.contains(&slug.to_string()) {
                        yt_channels.push(slug.to_string());
                    } else if domain.contains("github.com") && !gh_owners.contains(&slug.to_string()) {
                        gh_owners.push(slug.to_string());
                    }
                }
            }
            _ => {}
        }
    }

    let dev_secs: i64 = app_secs
        .iter()
        .filter(|(n, _)| dev_apps.iter().any(|d| n.contains(d)))
        .map(|(_, s)| *s)
        .sum();
    let chrome_secs = app_secs.get("Google Chrome").copied().unwrap_or(0);
    let claude_secs = app_secs.get("Claude").copied().unwrap_or(0);
    let top_app = app_secs.iter().max_by_key(|(_, s)| **s).map(|(n, _)| n.clone());

    let is_builder = dev_secs > 300;

    // ── Build priority-ordered insight list ───────────────────────────────
    let mut insights: Vec<(i32, &str, &str, String)> = vec![]; // (priority, category, icon, text)

    // Highest priority: specific content they're consuming right now
    if let Some(ref streamer) = kick_slugs.first() {
        insights.push((100, "insight", "📺",
            format!("You're watching {} on Kick. Study their consistency, not their content — they show up at the same time every week. That's the actual product. Do you have anything you show up for that reliably?", streamer)));
    }
    if let Some(ref streamer) = twitch_slugs.first() {
        insights.push((99, "insight", "🎮",
            format!("{} on Twitch has built an audience by doing the same thing in public, repeatedly. You're building something — what would happen if you did that too?", streamer)));
    }
    if let Some(ref sub) = reddit_subs.first() {
        let sub_name = sub.trim_start_matches("r/");
        insights.push((95, "idea", "💡",
            format!("You're in r/{}. That community is pre-assembled people with a shared pain point — the hardest thing in distribution. What's the most-complained-about problem there that nobody has solved cleanly?", sub_name)));
    }
    if let Some(ref channel) = yt_channels.first() {
        insights.push((90, "question", "📹",
            format!("You follow {} on YouTube. What's the one concrete thing from their last video that you could act on today — not save, not bookmark — actually do?", channel)));
    }
    if let Some(ref owner) = gh_owners.first() {
        insights.push((88, "question", "💻",
            format!("You looked at {}'s GitHub. What made you click on their work? That pull — that signal of curiosity — is data about what you actually want to build.", owner)));
    }

    // Builder insights
    if is_builder && dev_secs > 600 {
        let mins = dev_secs / 60;
        insights.push((85, "challenge", "⚒️",
            format!("{}m of active building. The question isn't whether you can write it — it's whether you'll show it to someone real this week. Stealth is just fear with better branding.", mins)));
    }

    // Chess + builder combo
    if chess_visits >= 2 && is_builder {
        insights.push((82, "idea", "♟️",
            "Chess player who codes: that's exactly who builds the tools a domain depends on. Lichess was built by one obsessed chess player. The niche already trusts you — you're already in it.".to_string()));
    } else if chess_visits >= 2 {
        insights.push((75, "insight", "♟️",
            "Chess trains pattern recognition across long time horizons — the same skill that makes great engineers and strategists. You're not just playing a game.".to_string()));
    }

    // Context switches
    if recent_switches > 12 {
        insights.push((78, "question", "⚡",
            format!("{} context switches in 10 minutes. That pattern almost always means there's one decision you're not making. What is it?", recent_switches)));
    }

    // Deep focus
    if recent_switches <= 2 && dev_secs > 600 {
        insights.push((70, "insight", "🎯",
            "You've been in sustained focus for a while. That's genuinely rare and economically valuable right now. Most people can't buy it — you're doing it.".to_string()));
    }

    // Claude usage
    if claude_secs > 300 {
        let mins = claude_secs / 60;
        insights.push((72, "question", "🧠",
            format!("{}m with Claude. Are you using it reactively (one question, move on) or as a thinking partner that holds your full context? The difference in output quality is enormous.", mins)));
    }

    // Browse vs build imbalance
    if chrome_secs > 1800 && dev_secs < 120 {
        let mins = chrome_secs / 60;
        insights.push((68, "blindspot", "🌐",
            format!("{}m browsing, almost no building. The internet is read-only. You already know what you want to make — what's the smallest version you could ship by end of week?", mins)));
    }

    // Time of day insights
    if hour >= 6 && hour < 10 {
        insights.push((65, "insight", "🌅",
            "You're in the highest cognitive bandwidth window of your day. Cortisol peaks around 8am. Most people waste it on email. You don't have to.".to_string()));
    } else if hour >= 22 || hour < 4 {
        insights.push((65, "challenge", "🌙",
            "Late night work feels productive because there are no interruptions — but tired reasoning makes bad architectural decisions. What can you defer to tomorrow-morning-you?".to_string()));
    }

    // Many sites = research spiral
    if unique_sites.len() >= 7 {
        insights.push((60, "nudge", "📡",
            format!("{} different sites today. Breadth without capture is forgetting at scale. Two sentences of notes would 10x your retention.", unique_sites.len())));
    }

    // Top app fallback
    if insights.is_empty() {
        if let Some(ref app_name) = top_app {
            insights.push((50, "question", "🎯",
                format!("{} has had your attention the most. Is that where your most important work happens — or is it where you go when you're avoiding your most important work?", app_name)));
        } else {
            insights.push((40, "insight", "✦",
                "PRE is watching and building your picture. The longer it runs, the more specific the insights get.".to_string()));
        }
    }

    // Sort by priority, return top 5
    insights.sort_by(|a, b| b.0.cmp(&a.0));

    let result: Vec<serde_json::Value> = insights
        .into_iter()
        .take(5)
        .map(|(_, category, icon, text)| {
            serde_json::json!({
                "text": text,
                "category": category,
                "icon": icon,
            })
        })
        .collect();

    Ok(result)
}

// ---------------------------------------------------------------------------
// App entry point
// ---------------------------------------------------------------------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(ManagedTrayState {
            current: Mutex::new(TrayState::default()),
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_state,
            get_tray_state,
            get_observer_status,
            toggle_observer,
            get_recent_observations,
            get_thinking_stream,
            generate_ai_thoughts,
            check_ai_status,
            save_thoughts,
            load_thoughts,
            save_core_memory,
            load_core_memory,
            close_tray_popover,
            open_main_window,
            get_tray_insight,
        ])
        .setup(|app| {
            // ── Tray-popover window (hidden until tray is clicked) ───────
            let _popover_window = WebviewWindowBuilder::new(
                app,
                "tray-popover",
                tauri::WebviewUrl::App("index.html".into()),
            )
            .title("")
            .decorations(false)
            .always_on_top(true)
            .visible(false)
            .inner_size(340.0, 190.0)
            .resizable(false)
            .skip_taskbar(true)
            .build()?;

            // ── Tray icon ────────────────────────────────────────────
            let idle_image = tauri::image::Image::from_bytes(ICON_IDLE)
                .expect("Failed to decode idle tray icon");

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(idle_image)
                .icon_as_template(true)
                .tooltip(tooltip_for_state(TrayState::Idle))
                .on_tray_icon_event(|tray, event| {
                    // Only respond to left-click releases
                    if let tauri::tray::TrayIconEvent::Click {
                        position,
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event {
                        let app = tray.app_handle();
                        if let Some(popover) = app.get_webview_window("tray-popover") {
                            if popover.is_visible().unwrap_or(false) {
                                // Already open — close it
                                let _ = popover.hide();
                            } else {
                                // Position popover below the tray icon click point.
                                // Offset so it's centered horizontally under the cursor
                                // and sits just below the menu bar.
                                let popover_w = 340.0_f64;
                                let popover_h = 190.0_f64;
                                let x = (position.x - popover_w / 2.0).max(4.0);
                                let y = position.y + 6.0;

                                // Clamp so it doesn't go off the right edge
                                // (rough guard — 2560 covers most monitors)
                                let x = x.min(2560.0 - popover_w);

                                let _ = popover.set_size(tauri::PhysicalSize::new(
                                    popover_w as u32,
                                    popover_h as u32,
                                ));
                                let _ = popover.set_position(tauri::PhysicalPosition::new(
                                    x as i32,
                                    y as i32,
                                ));
                                let _ = popover.show();
                                let _ = popover.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Show main window on startup
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }

            // ── Observer infrastructure ──────────────────────────────
            // Channel: observers → gateway client
            let (event_tx, event_rx) = mpsc::channel(1024);

            // Create observer manager and register all observers
            let mut manager = ObserverManager::new(event_tx);

            // We need a tokio runtime to register (for the status mutex init).
            // Tauri 2 runs setup synchronously, so we spawn the async work.
            let app_handle = app.handle().clone();

            tauri::async_runtime::spawn(async move {
                // Register all observers
                manager.register(Arc::new(AppUsageObserver::new()));
                manager.register(Arc::new(ScreenActivityObserver::new()));
                manager.register(Arc::new(BrowserHistoryObserver::new()));
                manager.register(Arc::new(IMessageObserver::new()));
                manager.register(Arc::new(CalendarObserver::new()));
                manager.register(Arc::new(LocationObserver::new()));
                manager.register(Arc::new(MusicObserver::new()));

                // Start all enabled observers
                manager.start_all();

                let statuses = manager.get_statuses().await;
                let active = statuses.iter().filter(|s| s.enabled).count();
                let total = statuses.len();
                log::info!(
                    "Observer manager started: {}/{} observers active",
                    active,
                    total
                );
                for s in &statuses {
                    log::info!(
                        "  {} {} (available: {})",
                        if s.enabled { "✓" } else { "✗" },
                        s.name,
                        s.available
                    );
                }

                // Store manager in Tauri state for command access
                app_handle.manage(ManagedObserverManager {
                    manager: Arc::new(tokio::sync::Mutex::new(manager)),
                });

                // Start gateway client (consumes event_rx)
                match GatewayClient::new(event_rx) {
                    Ok(client) => {
                        log::info!("Gateway client started, buffering events to ~/.pre/observer-buffer.db");
                        client.run().await;
                    }
                    Err(e) => {
                        log::error!("Failed to start gateway client: {}", e);
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
