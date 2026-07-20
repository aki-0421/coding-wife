use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::utils::config::WindowConfig;
use tauri::WebviewWindow;

use crate::workspace_history::WorkspaceHistoryStore;

const MAIN_WINDOW_STATE_KEY: &str = "main_window_state_v1";
const MAIN_WINDOW_STATE_SCHEMA_VERSION: u16 = 1;
const MIN_WINDOW_WIDTH: u32 = 960;
const MIN_WINDOW_HEIGHT: u32 = 640;
const MAX_WINDOW_DIMENSION: u32 = 16_384;
const RESIZE_SAVE_DEBOUNCE: Duration = Duration::from_millis(300);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct MainWindowStateV1 {
    schema_version: u16,
    width: u32,
    height: u32,
    maximized: bool,
}

impl MainWindowStateV1 {
    fn new(width: u32, height: u32, maximized: bool) -> Option<Self> {
        let state = Self {
            schema_version: MAIN_WINDOW_STATE_SCHEMA_VERSION,
            width,
            height,
            maximized,
        };
        state.is_valid().then_some(state)
    }

    fn is_valid(self) -> bool {
        self.schema_version == MAIN_WINDOW_STATE_SCHEMA_VERSION
            && (MIN_WINDOW_WIDTH..=MAX_WINDOW_DIMENSION).contains(&self.width)
            && (MIN_WINDOW_HEIGHT..=MAX_WINDOW_DIMENSION).contains(&self.height)
    }
}

#[derive(Clone)]
pub(crate) struct MainWindowStateController {
    store: WorkspaceHistoryStore,
    generation: Arc<AtomicU64>,
    latest_safe_state: Arc<Mutex<Option<MainWindowStateV1>>>,
}

impl MainWindowStateController {
    pub(crate) fn new(store: WorkspaceHistoryStore) -> Self {
        Self {
            store,
            generation: Arc::new(AtomicU64::new(0)),
            latest_safe_state: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn configure_startup(&self, config: &mut WindowConfig) {
        let restored = self.load();
        let startup_state = restored.unwrap_or_else(|| {
            MainWindowStateV1::new(
                config.width.round() as u32,
                config.height.round() as u32,
                true,
            )
            .expect("main window fallback geometry must be valid")
        });

        config.width = f64::from(startup_state.width);
        config.height = f64::from(startup_state.height);
        config.maximized = startup_state.maximized;
        config.fullscreen = false;
        *self
            .latest_safe_state
            .lock()
            .expect("main window state lock poisoned") = Some(startup_state);
    }

    pub(crate) fn schedule_save(&self, window: &WebviewWindow) {
        let generation = self.generation.fetch_add(1, Ordering::AcqRel) + 1;
        let controller = self.clone();
        let observed_window = window.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(RESIZE_SAVE_DEBOUNCE).await;
            if controller.generation.load(Ordering::Acquire) == generation {
                if let Some(state) = controller.capture(&observed_window) {
                    let _ = controller.save(state);
                }
            }
        });
    }

    pub(crate) fn save_before_close(&self, window: &WebviewWindow) {
        let state = self.capture(window).or_else(|| {
            *self
                .latest_safe_state
                .lock()
                .expect("main window state lock poisoned")
        });
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(state) = state {
            let _ = self.save(state);
        }
    }

    fn load(&self) -> Option<MainWindowStateV1> {
        let raw = self.store.read_app_setting(MAIN_WINDOW_STATE_KEY).ok()??;
        let state = serde_json::from_str::<MainWindowStateV1>(&raw).ok()?;
        state.is_valid().then_some(state)
    }

    fn save(&self, state: MainWindowStateV1) -> Result<(), ()> {
        if !state.is_valid() {
            return Err(());
        }
        let encoded = serde_json::to_string(&state).map_err(|_| ())?;
        self.store
            .write_app_setting(MAIN_WINDOW_STATE_KEY, &encoded)
            .map_err(|_| ())
    }

    fn capture(&self, window: &WebviewWindow) -> Option<MainWindowStateV1> {
        if window.is_fullscreen().ok()? {
            return None;
        }
        let maximized = window.is_maximized().ok()? || fills_current_work_area(window)?;
        let previous = *self
            .latest_safe_state
            .lock()
            .expect("main window state lock poisoned");
        let next = if maximized {
            updated_state(previous, None, true)
        } else {
            let physical = window.inner_size().ok()?;
            let scale_factor = window.scale_factor().ok()?;
            if !scale_factor.is_finite() || scale_factor <= 0.0 {
                return None;
            }
            let logical = physical.to_logical::<u32>(scale_factor);
            updated_state(previous, Some((logical.width, logical.height)), false)
        }?;
        *self
            .latest_safe_state
            .lock()
            .expect("main window state lock poisoned") = Some(next);
        Some(next)
    }
}

fn fills_current_work_area(window: &WebviewWindow) -> Option<bool> {
    const FRAME_TOLERANCE: u32 = 2;

    let monitor = window.current_monitor().ok()??;
    let work_area = monitor.work_area();
    let outer_size = window.outer_size().ok()?;
    Some(
        outer_size.width.abs_diff(work_area.size.width) <= FRAME_TOLERANCE
            && outer_size.height.abs_diff(work_area.size.height) <= FRAME_TOLERANCE,
    )
}

fn updated_state(
    previous: Option<MainWindowStateV1>,
    logical_size: Option<(u32, u32)>,
    maximized: bool,
) -> Option<MainWindowStateV1> {
    if maximized {
        return previous.map(|state| MainWindowStateV1 {
            maximized: true,
            ..state
        });
    }
    let (width, height) = logical_size?;
    MainWindowStateV1::new(width, height, false)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use serde_json::json;

    use super::*;

    fn temporary_directory(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "coding-wife-window-state-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("temporary app data directory");
        path
    }

    #[test]
    fn persisted_window_state_round_trips_through_native_sqlite() {
        let app_data = temporary_directory("round-trip");
        let state = MainWindowStateV1::new(1280, 720, false).expect("valid state");
        {
            let controller =
                MainWindowStateController::new(WorkspaceHistoryStore::open(&app_data).unwrap());
            controller.save(state).expect("save state");
        }
        let reopened =
            MainWindowStateController::new(WorkspaceHistoryStore::open(&app_data).unwrap());
        assert_eq!(reopened.load(), Some(state));
        fs::remove_dir_all(app_data).expect("cleanup");
    }

    #[test]
    fn invalid_or_unknown_window_state_fails_closed() {
        for (label, value) in [
            (
                "too-small",
                json!({
                    "schemaVersion": MAIN_WINDOW_STATE_SCHEMA_VERSION,
                    "width": MIN_WINDOW_WIDTH - 1,
                    "height": MIN_WINDOW_HEIGHT,
                    "maximized": false
                }),
            ),
            (
                "unknown-schema",
                json!({
                    "schemaVersion": MAIN_WINDOW_STATE_SCHEMA_VERSION + 1,
                    "width": 1280,
                    "height": 720,
                    "maximized": false
                }),
            ),
            (
                "unknown-field",
                json!({
                    "schemaVersion": MAIN_WINDOW_STATE_SCHEMA_VERSION,
                    "width": 1280,
                    "height": 720,
                    "maximized": false,
                    "fullscreen": true
                }),
            ),
        ] {
            let app_data = temporary_directory(label);
            let store = WorkspaceHistoryStore::open(&app_data).unwrap();
            store
                .write_app_setting(MAIN_WINDOW_STATE_KEY, &value.to_string())
                .expect("write fixture");
            let controller = MainWindowStateController::new(store);
            assert_eq!(controller.load(), None);
            fs::remove_dir_all(app_data).expect("cleanup");
        }
    }

    #[test]
    fn maximized_state_keeps_the_last_normal_geometry() {
        let normal = MainWindowStateV1::new(1240, 760, false).expect("normal state");
        let maximized = updated_state(Some(normal), None, true).expect("maximized state");
        assert_eq!(maximized.width, normal.width);
        assert_eq!(maximized.height, normal.height);
        assert!(maximized.maximized);
    }

    #[test]
    fn normal_resize_replaces_previous_geometry() {
        let previous = MainWindowStateV1::new(1240, 760, true).expect("previous state");
        let resized =
            updated_state(Some(previous), Some((1360, 800)), false).expect("resized window state");
        assert_eq!(resized, MainWindowStateV1::new(1360, 800, false).unwrap());
    }
}
