use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    tray::TrayIconBuilder,
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
// Managed state — holds current TrayState in a Mutex
// ---------------------------------------------------------------------------

struct ManagedTrayState {
    current: Mutex<TrayState>,
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
// Tauri command: set_tray_state
// ---------------------------------------------------------------------------

#[tauri::command]
fn set_tray_state(
    app: tauri::AppHandle,
    state: TrayState,
    managed: tauri::State<'_, ManagedTrayState>,
) -> Result<(), String> {
    // Update managed state
    let mut current = managed.current.lock().map_err(|e| e.to_string())?;
    if *current == state {
        return Ok(()); // No change needed
    }
    *current = state;
    drop(current); // Release the lock before doing I/O

    // Get the tray handle and update icon + tooltip
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

// ---------------------------------------------------------------------------
// Tauri command: get_tray_state (for frontend to query current state)
// ---------------------------------------------------------------------------

#[tauri::command]
fn get_tray_state(
    managed: tauri::State<'_, ManagedTrayState>,
) -> Result<TrayState, String> {
    let current = managed.current.lock().map_err(|e| e.to_string())?;
    Ok(*current)
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
        .invoke_handler(tauri::generate_handler![set_tray_state, get_tray_state])
        .setup(|app| {
            // Build the tray icon with the idle icon and a known ID
            let idle_image = tauri::image::Image::from_bytes(ICON_IDLE)
                .expect("Failed to decode idle tray icon");

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(idle_image)
                .icon_as_template(true) // macOS: renders as template (adapts to light/dark menu bar)
                .tooltip(tooltip_for_state(TrayState::Idle))
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click { .. } = event {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // Hide window initially (menu bar apps start hidden)
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.hide();
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
