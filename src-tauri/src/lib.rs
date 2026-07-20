pub mod app_lifecycle;
pub mod character;
pub mod codex;
pub mod git_review;
pub mod narration;
pub mod preferences;
pub mod readiness;
pub mod workspace_history;

mod window_state;

use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{http, Manager, State};

use app_lifecycle::{
    app_quit_cancel, app_quit_confirm, app_quit_retry_cleanup, raise_main_window,
    request_app_close, AppLifecycleCoordinator,
};
use character::commands::{
    character_attest_preview, character_cancel_import, character_confirm_import,
    character_delete_pack, character_import_pick, character_library_get, character_read_asset,
    character_select_pack, character_semantic_mapping_save,
};
use character::service::resolve_builtin_directory;
use character::{CharacterService, CharacterStorage};
use codex::attachment::AttachmentService;
use codex::commands::{
    codex_answer_fallback_decision, codex_connect, codex_get_diagnostic, codex_pick_attachments,
    codex_pick_workspace, codex_probe, codex_register_attachment_paths, codex_respond_pending,
    codex_review_start, codex_thread_list, codex_thread_resume, codex_thread_start,
    codex_turn_interrupt, codex_turn_start,
};
use codex::commit_explanation::{
    commit_explanation_cancel, commit_explanation_get_state, commit_explanation_present,
    commit_explanation_request, commit_explanation_set_scope, CommitExplanationController,
};
use codex::supervisor::CodexSupervisor;
use codex::workspace::WorkspaceService;
use git_review::commands::{
    list_commit_evidence, observe_git_repository, observe_terminal_work_unit,
    prepare_commit_explanation_evidence, read_commit_diff_file, read_commit_evidence,
};
use git_review::main_work_unit_runtime::GitReviewMainWorkUnitRuntime;
use git_review::GitReviewService;
use narration::commands::{
    narration_cancel, narration_get_runtime, narration_get_settings, narration_list_voices,
    narration_reset_settings, narration_set_muted, narration_set_scope, narration_speak,
    narration_update_settings,
};
use narration::NarrationService;
use preferences::commands::{app_preferences_get, app_preferences_update};
use preferences::AppPreferencesService;
use readiness::commands::{
    configure_codex_binary, copy_sanitized_diagnostics, run_diagnostic_check,
};
use readiness::NativeReadinessService;
use window_state::MainWindowStateController;
use workspace_history::commands::{
    app_character_context_get, app_character_context_save, history_append_domain_event,
    project_context_get, project_context_save, workspace_archive, workspace_cancel,
    workspace_create_session, workspace_delete, workspace_get_turn_context_snapshot,
    workspace_issue_delete_challenge, workspace_list, workspace_list_timeline,
    workspace_pick_register, workspace_project_setup_cancel, workspace_project_setup_git_init,
    workspace_project_setup_github, workspace_recheck, workspace_repair,
    workspace_save_context_snapshot, workspace_save_draft, workspace_save_timeline_anchor,
    workspace_select, workspace_unregister, workspace_update_lifecycle,
};
use workspace_history::{WorkspaceHistoryService, WorkspaceHistoryStore};

const IPC_SCHEMA_VERSION: u16 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum RuntimeKind {
    Tauri,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum FoundationState {
    Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum IntegrationReadiness {
    NotConfigured,
    Ready,
    ReadOnly,
    RecoveryRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct HealthCheckResponse {
    schema_version: u16,
    runtime: RuntimeKind,
    foundation_state: FoundationState,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct IntegrationMetadata {
    codex: IntegrationReadiness,
    git: IntegrationReadiness,
    live2d: IntegrationReadiness,
    history: IntegrationReadiness,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct RuntimeMetadata {
    schema_version: u16,
    runtime: RuntimeKind,
    app_version: String,
    platform: String,
    architecture: String,
    integrations: IntegrationMetadata,
}

#[tauri::command]
fn health_check() -> HealthCheckResponse {
    HealthCheckResponse {
        schema_version: IPC_SCHEMA_VERSION,
        runtime: RuntimeKind::Tauri,
        foundation_state: FoundationState::Ready,
    }
}

#[tauri::command]
fn app_window_ready(app: tauri::AppHandle) {
    raise_main_window(&app);
}

fn runtime_metadata(
    app_version: impl Into<String>,
    platform: impl Into<String>,
    architecture: impl Into<String>,
    history: IntegrationReadiness,
) -> RuntimeMetadata {
    RuntimeMetadata {
        schema_version: IPC_SCHEMA_VERSION,
        runtime: RuntimeKind::Tauri,
        app_version: app_version.into(),
        platform: platform.into(),
        architecture: architecture.into(),
        integrations: IntegrationMetadata {
            codex: IntegrationReadiness::NotConfigured,
            git: IntegrationReadiness::NotConfigured,
            live2d: IntegrationReadiness::NotConfigured,
            history,
        },
    }
}

#[tauri::command]
fn get_runtime_metadata(history: State<'_, WorkspaceHistoryService>) -> RuntimeMetadata {
    let history = match history.history_mode() {
        workspace_history::types::HistoryMode::Ready => IntegrationReadiness::Ready,
        workspace_history::types::HistoryMode::ReadOnly => IntegrationReadiness::ReadOnly,
        workspace_history::types::HistoryMode::RecoveryRequired => {
            IntegrationReadiness::RecoveryRequired
        }
    };
    runtime_metadata(
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        history,
    )
}

fn allow_opaque_preview_module_request<B>(
    request: &http::Request<Vec<u8>>,
    response: &mut http::Response<B>,
) {
    let is_tauri_asset = request.uri().scheme_str() == Some("tauri");
    let has_opaque_origin = request
        .headers()
        .get(http::header::ORIGIN)
        .is_some_and(|origin| origin == "null");
    if !is_tauri_asset || !has_opaque_origin {
        return;
    }
    response.headers_mut().insert(
        http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
        http::HeaderValue::from_static("null"),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let supervisor = CodexSupervisor::new();
    let setup_supervisor = supervisor.clone();
    let workspace_service = WorkspaceService::production(supervisor.clone());
    let setup_workspace_service = workspace_service.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let main_window_visible = app
                .get_webview_window("main")
                .and_then(|window| window.is_visible().ok())
                .unwrap_or(false);
            if main_window_visible {
                raise_main_window(app);
            }
        }))
        .manage(Arc::new(AppLifecycleCoordinator::default()))
        .manage(supervisor)
        .manage(workspace_service)
        .setup(move |app| {
            setup_supervisor.attach_app_handle(app.handle().clone());
            setup_supervisor.start_signal_loop();
            let app_data_directory = app.path().app_data_dir()?;
            let preferences_service = AppPreferencesService::production(&app_data_directory);
            app.manage(preferences_service.clone());
            let attachment_service = AttachmentService::production(&app_data_directory)
                .map_err(|error| std::io::Error::other(error.code))?;
            app.manage(attachment_service);
            app.manage(NarrationService::production(&app_data_directory));
            let history_store = WorkspaceHistoryStore::open(&app_data_directory)?;
            if let Some(record) = history_store.private_binary_record()? {
                tauri::async_runtime::block_on(
                    setup_supervisor.set_explicit_binary(Some(record.canonical_path)),
                );
            }
            let window_state_controller = MainWindowStateController::new(history_store.clone());
            let resource_directory = app.path().resource_dir()?;
            let character_storage = CharacterStorage::open(&app_data_directory)?;
            let project_operations = Arc::new(tokio::sync::Mutex::new(()));
            let character_service = CharacterService::production_with_operations(
                character_storage,
                resolve_builtin_directory(&resource_directory),
                project_operations.clone(),
            );
            let history_service = WorkspaceHistoryService::new_pending_restore_with_character(
                history_store,
                setup_workspace_service.clone(),
                character_service.clone(),
                project_operations,
            );
            let git_review_service = GitReviewService::production(
                setup_workspace_service.clone(),
                history_service.clone(),
            )
            .map_err(|error| std::io::Error::other(error.code))?;
            let explanation_controller = CommitExplanationController::production(
                setup_supervisor.clone(),
                app.handle().clone(),
                &app_data_directory,
                &resource_directory,
            );
            setup_supervisor.attach_main_work_unit_runtime(Arc::new(
                GitReviewMainWorkUnitRuntime::production(
                    git_review_service.clone(),
                    explanation_controller.trusted_enqueuer(),
                ),
            ));
            app.manage(history_service.clone());
            app.manage(git_review_service);
            app.manage(explanation_controller);
            let startup_history_service = history_service.clone();
            tauri::async_runtime::spawn(async move {
                startup_history_service.restore_startup().await;
            });
            app.manage(NativeReadinessService::new(
                setup_supervisor.clone(),
                history_service.clone(),
                character_service.clone(),
                preferences_service,
            ));
            app.manage(character_service);
            let mut window_config = app.config().app.windows.first().cloned().ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "main window configuration is required",
                )
            })?;
            window_state_controller.configure_startup(&mut window_config);
            let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .on_web_resource_request(|request, response| {
                    allow_opaque_preview_module_request(&request, response);
                })
                .build()?;
            let close_app = app.handle().clone();
            let observed_window = window.clone();
            window.on_window_event(move |event| match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. } => {
                    window_state_controller.schedule_save(&observed_window);
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    window_state_controller.save_before_close(&observed_window);
                    request_app_close(close_app.clone());
                }
                _ => {}
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_window_ready,
            health_check,
            get_runtime_metadata,
            app_preferences_get,
            app_preferences_update,
            run_diagnostic_check,
            configure_codex_binary,
            copy_sanitized_diagnostics,
            app_quit_cancel,
            app_quit_confirm,
            app_quit_retry_cleanup,
            codex_pick_workspace,
            codex_get_diagnostic,
            codex_probe,
            codex_connect,
            codex_thread_list,
            codex_thread_start,
            codex_thread_resume,
            codex_turn_start,
            codex_pick_attachments,
            codex_register_attachment_paths,
            codex_turn_interrupt,
            codex_review_start,
            codex_respond_pending,
            codex_answer_fallback_decision,
            workspace_list,
            workspace_pick_register,
            workspace_project_setup_git_init,
            workspace_project_setup_github,
            workspace_project_setup_cancel,
            workspace_create_session,
            workspace_select,
            workspace_recheck,
            workspace_repair,
            workspace_unregister,
            workspace_archive,
            workspace_update_lifecycle,
            workspace_cancel,
            workspace_save_draft,
            workspace_save_timeline_anchor,
            workspace_save_context_snapshot,
            project_context_get,
            project_context_save,
            app_character_context_get,
            app_character_context_save,
            workspace_get_turn_context_snapshot,
            workspace_list_timeline,
            workspace_issue_delete_challenge,
            workspace_delete,
            history_append_domain_event,
            observe_git_repository,
            observe_terminal_work_unit,
            list_commit_evidence,
            read_commit_evidence,
            read_commit_diff_file,
            prepare_commit_explanation_evidence,
            commit_explanation_request,
            commit_explanation_cancel,
            commit_explanation_present,
            commit_explanation_get_state,
            commit_explanation_set_scope,
            character_library_get,
            character_import_pick,
            character_read_asset,
            character_attest_preview,
            character_confirm_import,
            character_cancel_import,
            character_select_pack,
            character_semantic_mapping_save,
            character_delete_pack,
            narration_get_settings,
            narration_get_runtime,
            narration_list_voices,
            narration_update_settings,
            narration_set_muted,
            narration_reset_settings,
            narration_set_scope,
            narration_speak,
            narration_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build the Coding Wife application");

    app.run(move |app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            let can_exit = app_handle
                .state::<Arc<AppLifecycleCoordinator>>()
                .can_exit();
            if !can_exit {
                api.prevent_exit();
                request_app_close(app_handle.clone());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const RUNTIME_CONTRACT_FIXTURE: &str =
        include_str!("../../src/test/fixtures/runtime-foundation.v1.json");

    fn contract_fixture() -> Value {
        serde_json::from_str(RUNTIME_CONTRACT_FIXTURE)
            .expect("runtime contract fixture must deserialize")
    }

    fn fixture_response<'a>(fixture: &'a Value, key: &str) -> &'a Value {
        fixture
            .get(key)
            .unwrap_or_else(|| panic!("fixture response {key} must exist"))
    }

    fn serialized_response(response: impl Serialize) -> Value {
        serde_json::to_value(response).expect("command response must serialize")
    }

    #[test]
    fn health_reports_only_the_foundation_state() {
        let response = health_check();

        assert_eq!(response.schema_version, IPC_SCHEMA_VERSION);
        assert_eq!(response.runtime, RuntimeKind::Tauri);
        assert_eq!(response.foundation_state, FoundationState::Ready);
    }

    #[test]
    fn only_opaque_tauri_asset_requests_receive_preview_cors() {
        fn response() -> http::Response<Vec<u8>> {
            http::Response::builder()
                .header(
                    http::header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    "tauri://localhost",
                )
                .body(Vec::new())
                .expect("fixture response must build")
        }

        let opaque_request = http::Request::builder()
            .uri("tauri://localhost/assets/character-import-preview.js")
            .header(http::header::ORIGIN, "null")
            .body(Vec::new())
            .expect("fixture request must build");
        let mut opaque_response = response();
        allow_opaque_preview_module_request(&opaque_request, &mut opaque_response);
        assert_eq!(
            opaque_response
                .headers()
                .get(http::header::ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&http::HeaderValue::from_static("null"))
        );

        for (uri, origin) in [
            ("tauri://localhost/assets/app.js", "https://attacker.test"),
            ("https://localhost:1420/assets/app.js", "null"),
        ] {
            let request = http::Request::builder()
                .uri(uri)
                .header(http::header::ORIGIN, origin)
                .body(Vec::new())
                .expect("fixture request must build");
            let mut rejected_response = response();
            allow_opaque_preview_module_request(&request, &mut rejected_response);
            assert_eq!(
                rejected_response
                    .headers()
                    .get(http::header::ACCESS_CONTROL_ALLOW_ORIGIN),
                Some(&http::HeaderValue::from_static("tauri://localhost"))
            );
        }
    }

    fn runtime_fixture_metadata() -> RuntimeMetadata {
        runtime_metadata(
            env!("CARGO_PKG_VERSION"),
            std::env::consts::OS,
            std::env::consts::ARCH,
            IntegrationReadiness::Ready,
        )
    }

    #[test]
    fn history_readiness_is_reported_separately_from_unconfigured_integrations() {
        let metadata = runtime_fixture_metadata();

        assert_eq!(
            metadata.integrations.codex,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(
            metadata.integrations.git,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(
            metadata.integrations.live2d,
            IntegrationReadiness::NotConfigured
        );
        assert_eq!(metadata.integrations.history, IntegrationReadiness::Ready);
    }

    #[test]
    fn serialized_responses_match_the_cross_language_fixture() {
        let fixture = contract_fixture();

        assert_eq!(
            fixture.get("schemaVersion").and_then(Value::as_u64),
            Some(u64::from(IPC_SCHEMA_VERSION))
        );
        assert_eq!(
            serialized_response(health_check()),
            *fixture_response(&fixture, "healthCheck")
        );
        assert_eq!(
            serialized_response(runtime_fixture_metadata()),
            *fixture_response(&fixture, "runtimeMetadata")
        );
    }

    #[test]
    fn exact_fixture_comparison_rejects_unknown_and_missing_fields() {
        let fixture = contract_fixture();
        let actual_metadata = serialized_response(runtime_fixture_metadata());
        let mut fixture_with_unknown = fixture_response(&fixture, "runtimeMetadata").clone();
        fixture_with_unknown
            .as_object_mut()
            .expect("fixture metadata must be an object")
            .insert("unexpectedField".to_owned(), Value::Bool(true));

        let mut actual_with_missing_field = actual_metadata.clone();
        actual_with_missing_field
            .as_object_mut()
            .expect("serialized metadata must be an object")
            .remove("schemaVersion");

        assert_ne!(actual_metadata, fixture_with_unknown);
        assert_ne!(
            actual_with_missing_field,
            *fixture_response(&fixture, "runtimeMetadata")
        );
        assert!(serde_json::from_value::<RuntimeMetadata>(fixture_with_unknown).is_err());
    }
}
