mod observers;

use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use tauri::{
    Manager,
    tray::TrayIconBuilder,
};
use tokio::sync::mpsc;

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
        ])
        .setup(|app| {
            // ── Tray icon ────────────────────────────────────────────
            let idle_image = tauri::image::Image::from_bytes(ICON_IDLE)
                .expect("Failed to decode idle tray icon");

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(idle_image)
                .icon_as_template(true)
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

            // Show window on startup
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
