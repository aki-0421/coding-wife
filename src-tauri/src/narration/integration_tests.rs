use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::binary::{NarrationBinary, NarrationSpeech};
use super::process::{process_group_exists, NarrationProcessControl};
use super::service::NarrationService;
use super::settings::NarrationSettingsStore;
use super::types::{
    NarrationCancelReason, NarrationCancelRequestV1, NarrationDisposition, NarrationKind,
    NarrationLocale, NarrationMuteRequestV1, NarrationPlaybackState, NarrationPriority,
    NarrationResetRequestV1, NarrationScopeRequestV1, NarrationSemanticType,
    NarrationSettingsUpdateV1, NarrationSpeakRequestV1, NarrationVoiceSelectionV1,
    NARRATION_SCHEMA_VERSION,
};

struct FakeSayFixture {
    root: PathBuf,
    binary: PathBuf,
}

impl FakeSayFixture {
    fn new() -> Self {
        let root =
            std::env::temp_dir().join(format!("coding-wife-narration-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("fixture directory");
        let binary = root.join("fake-say");
        fs::write(
            &binary,
            r#"#!/bin/sh
if [ "$1" = "-v" ] && [ "$2" = "?" ]; then
  printf 'Kyoko ja_JP # Japanese sample\nEddy (日本語（日本）) ja_JP # Japanese sample\nSamantha en_US # English sample\nDaniel en_GB # English sample\n'
  exit 0
fi
printf '%s\n' "$$" > "$0.pid"
printf '%s\n' "$@" > "$0.args"
/bin/cat > "$0.stdin"
printf 'BEGIN\n' >> "$0.events"
/bin/cat "$0.stdin" >> "$0.events"
printf '\nEND\n' >> "$0.events"
: > "$0.playing"
while [ -e "$0.block" ]; do
  /bin/sleep 0.02
done
"#,
        )
        .expect("fake say script");
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o500))
            .expect("fake say permissions");
        Self { root, binary }
    }

    fn app_data(&self) -> PathBuf {
        self.root.join("app-data")
    }

    fn sidecar(&self, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}.{suffix}", self.binary.display()))
    }

    fn block(&self) {
        fs::write(self.sidecar("block"), []).expect("block marker");
    }

    fn unblock(&self) {
        let _ = fs::remove_file(self.sidecar("block"));
    }

    async fn wait_for(&self, suffix: &str) {
        wait_until(Duration::from_secs(2), || self.sidecar(suffix).exists()).await;
    }

    fn events(&self) -> String {
        fs::read_to_string(self.sidecar("events")).unwrap_or_default()
    }
}

impl Drop for FakeSayFixture {
    fn drop(&mut self) {
        self.unblock();
        let _ = fs::remove_dir_all(&self.root);
    }
}

async fn service_fixture(fixture: &FakeSayFixture) -> NarrationService {
    let service = NarrationService::fixture(fixture.app_data(), fixture.binary.clone())
        .expect("narration fixture");
    service
        .set_scope(NarrationScopeRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            generation: 1,
        })
        .await
        .expect("scope");
    service
}

async fn enable(service: &NarrationService) {
    let snapshot = service.snapshot().expect("settings snapshot");
    service
        .update_settings(NarrationSettingsUpdateV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            expected_version: snapshot.settings.version,
            enabled: true,
            muted: false,
            voices: NarrationVoiceSelectionV1 {
                ja: Some("Kyoko".to_owned()),
                en: Some("Samantha".to_owned()),
            },
            rate: 1.0,
        })
        .await
        .expect("enable narration");
}

fn request(id: &str, text: &str, priority: NarrationPriority) -> NarrationSpeakRequestV1 {
    NarrationSpeakRequestV1 {
        schema_version: NARRATION_SCHEMA_VERSION,
        request_id: id.to_owned(),
        workspace_id: "workspace-1".to_owned(),
        generation: 1,
        sequence: 0,
        locale: NarrationLocale::Ja,
        kind: NarrationKind::CommitExplanation,
        semantic_type: NarrationSemanticType::CommitExplanation,
        priority,
        text: text.to_owned(),
    }
}

async fn wait_until(mut remaining: Duration, mut condition: impl FnMut() -> bool) {
    while !condition() && !remaining.is_zero() {
        let interval = remaining.min(Duration::from_millis(10));
        tokio::time::sleep(interval).await;
        remaining = remaining.saturating_sub(interval);
    }
    assert!(condition(), "condition was not reached before timeout");
}

#[tokio::test]
async fn passes_only_allowlisted_arguments_and_redacted_text_over_stdin() {
    let fixture = FakeSayFixture::new();
    let service = service_fixture(&fixture).await;
    enable(&service).await;

    let response = service
        .speak(request(
            "request-exact",
            "変更内容を確認しました。",
            NarrationPriority::High,
        ))
        .await
        .expect("speak response");
    assert_eq!(response.disposition, NarrationDisposition::Queued);
    fixture.wait_for("events").await;
    wait_until(Duration::from_secs(2), || {
        service
            .runtime_snapshot()
            .is_ok_and(|runtime| runtime.playback_state == NarrationPlaybackState::Idle)
    })
    .await;

    assert_eq!(
        fs::read_to_string(fixture.sidecar("args")).expect("arguments"),
        "-v\nKyoko\n-r\n180\n"
    );
    assert_eq!(
        fs::read_to_string(fixture.sidecar("stdin")).expect("stdin"),
        "変更内容を確認しました。"
    );
    let entries = fs::read_dir(&fixture.root)
        .expect("fixture entries")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect::<Vec<_>>();
    assert!(!entries.iter().any(|name| {
        [".aiff", ".aac", ".m4a", ".wav"]
            .iter()
            .any(|extension| name.ends_with(extension))
    }));
    service.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn voice_listing_and_speech_fail_closed_after_binary_tampering() {
    let fixture = FakeSayFixture::new();
    let binary = NarrationBinary::fixture(fixture.binary.clone(), effective_uid());
    let control = std::sync::Arc::new(NarrationProcessControl::default());
    let voices = binary
        .list_voices(control.clone(), control.epoch())
        .await
        .expect("trusted voice list");
    assert!(voices.iter().any(|voice| voice.name == "Kyoko"));

    fs::set_permissions(&fixture.binary, fs::Permissions::from_mode(0o520))
        .expect("tamper permissions");
    let list_error = binary
        .list_voices(control.clone(), control.epoch())
        .await
        .expect_err("tampered list must fail");
    assert_eq!(list_error.code, "NARRATION-BINARY-UNTRUSTED");
    let speak_error = binary
        .speak(
            control.clone(),
            control.epoch(),
            NarrationSpeech {
                locale: NarrationLocale::Ja,
                voice: "Kyoko",
                words_per_minute: 180,
                text: "安全な本文です。",
                timeout: Duration::from_secs(1),
            },
        )
        .await
        .expect_err("tampered speech must fail");
    assert_eq!(speak_error.code, "NARRATION-BINARY-UNTRUSTED");
    assert!(!fixture.sidecar("playing").exists());
}

#[tokio::test]
async fn persists_owner_only_settings_atomically_and_resets_to_off() {
    let fixture = FakeSayFixture::new();
    let service = service_fixture(&fixture).await;
    let initial = service.snapshot().expect("initial snapshot");
    assert!(!initial.settings.enabled);
    assert_eq!(initial.settings.version, 0);
    enable(&service).await;

    let settings_path = fixture.app_data().join("narration/settings-v1.json");
    let directory_path = fixture.app_data().join("narration");
    let settings_metadata = fs::symlink_metadata(&settings_path).expect("settings metadata");
    let directory_metadata = fs::symlink_metadata(&directory_path).expect("directory metadata");
    assert_eq!(settings_metadata.uid(), effective_uid());
    assert_eq!(settings_metadata.mode() & 0o777, 0o600);
    assert_eq!(directory_metadata.uid(), effective_uid());
    assert_eq!(directory_metadata.mode() & 0o777, 0o700);
    assert!(fs::read_dir(&directory_path)
        .expect("settings directory")
        .filter_map(Result::ok)
        .all(|entry| !entry.file_name().to_string_lossy().ends_with(".tmp")));

    service.shutdown().await.expect("shutdown");
    let reopened = NarrationService::fixture(fixture.app_data(), fixture.binary.clone())
        .expect("reopen service");
    let persisted = reopened.snapshot().expect("persisted snapshot");
    assert!(persisted.settings.enabled);
    let reset = reopened
        .reset_settings(NarrationResetRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            expected_version: persisted.settings.version,
        })
        .await
        .expect("reset settings");
    assert!(!reset.settings.enabled);
    assert!(!reset.settings.muted);
    assert_eq!(reset.settings.voices, NarrationVoiceSelectionV1::default());
    assert_eq!(reset.settings.rate, 1.0);
    reopened.shutdown().await.expect("shutdown reopened");

    let stored = NarrationSettingsStore::open(fixture.app_data())
        .expect("stored settings")
        .settings;
    assert!(!stored.enabled);
    assert_eq!(stored.version, reset.settings.version);
}

#[tokio::test]
async fn bounds_the_queue_preserves_fifo_within_priority_and_deduplicates() {
    let fixture = FakeSayFixture::new();
    fixture.block();
    let service = service_fixture(&fixture).await;
    enable(&service).await;

    for (index, (id, text)) in [
        ("request-a", "説明Aです。"),
        ("request-b", "説明Bです。"),
        ("request-c", "説明Cです。"),
        ("request-d", "説明Dです。"),
    ]
    .into_iter()
    .enumerate()
    {
        let response = service
            .speak(request(id, text, NarrationPriority::High))
            .await
            .expect("queued speech");
        assert_eq!(response.disposition, NarrationDisposition::Queued);
        if index == 0 {
            fixture.wait_for("playing").await;
        }
    }
    let overflow = service
        .speak(request(
            "request-overflow",
            "上限を超える説明です。",
            NarrationPriority::High,
        ))
        .await
        .expect("overflow response");
    assert_eq!(overflow.disposition, NarrationDisposition::DroppedQueueFull);
    assert_eq!(overflow.queue_depth, 3);

    fixture.unblock();
    wait_until(Duration::from_secs(3), || {
        fixture.events().matches("BEGIN\n").count() == 4
            && service
                .runtime_snapshot()
                .is_ok_and(|runtime| runtime.playback_state == NarrationPlaybackState::Idle)
    })
    .await;
    let events = fixture.events();
    let positions = ["説明Aです。", "説明Bです。", "説明Cです。", "説明Dです。"]
        .map(|text| events.find(text).expect("ordered event"));
    assert!(positions.windows(2).all(|pair| pair[0] < pair[1]));

    let first = service
        .speak(request(
            "request-dedupe-1",
            "同じ説明です。",
            NarrationPriority::High,
        ))
        .await
        .expect("first duplicate candidate");
    assert_eq!(first.disposition, NarrationDisposition::Queued);
    let duplicate = service
        .speak(request(
            "request-dedupe-2",
            "同じ説明です。",
            NarrationPriority::High,
        ))
        .await
        .expect("duplicate response");
    assert_eq!(
        duplicate.disposition,
        NarrationDisposition::DroppedDuplicate
    );
    service.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn a_full_queue_evicts_the_oldest_low_priority_item_for_fresher_narration() {
    let fixture = FakeSayFixture::new();
    fixture.block();
    let service = service_fixture(&fixture).await;
    enable(&service).await;

    service
        .speak(request(
            "request-active",
            "再生中の説明です。",
            NarrationPriority::High,
        ))
        .await
        .expect("active speech");
    fixture.wait_for("playing").await;
    for (id, text) in [
        ("request-low-oldest", "古い低優先説明です。"),
        ("request-low-middle", "中間の低優先説明です。"),
        ("request-low-newest", "新しい低優先説明です。"),
    ] {
        let response = service
            .speak(request(id, text, NarrationPriority::Low))
            .await
            .expect("low priority queue");
        assert_eq!(response.disposition, NarrationDisposition::Queued);
    }

    let replacement = service
        .speak(request(
            "request-fresh-high",
            "最新の高優先説明です。",
            NarrationPriority::High,
        ))
        .await
        .expect("fresh replacement");
    assert_eq!(replacement.disposition, NarrationDisposition::Queued);
    assert_eq!(replacement.queue_depth, 3);
    assert_eq!(
        replacement.code.as_deref(),
        Some("NARRATION-QUEUE-EVICTED-LOW")
    );

    service.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn mute_cancel_and_scope_switch_converge_without_stale_playback() {
    let fixture = FakeSayFixture::new();
    fixture.block();
    let service = service_fixture(&fixture).await;
    enable(&service).await;
    service
        .speak(request(
            "request-cancel",
            "キャンセル対象です。",
            NarrationPriority::High,
        ))
        .await
        .expect("queued cancel fixture");
    fixture.wait_for("playing").await;
    let pid = fs::read_to_string(fixture.sidecar("pid"))
        .expect("fake pid")
        .trim()
        .parse::<u32>()
        .expect("numeric pid");

    let started = Instant::now();
    tokio::time::timeout(
        Duration::from_millis(100),
        service.set_muted(NarrationMuteRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            expected_version: service.snapshot().expect("snapshot").settings.version,
            muted: true,
        }),
    )
    .await
    .expect("mute must converge within 100ms")
    .expect("mute result");
    assert!(started.elapsed() < Duration::from_millis(100));
    assert!(!process_group_exists(pid));
    let runtime = service.runtime_snapshot().expect("runtime after mute");
    assert_eq!(runtime.playback_state, NarrationPlaybackState::Idle);
    assert_eq!(runtime.queue_depth, 0);

    service
        .set_scope(NarrationScopeRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            workspace_id: "workspace-2".to_owned(),
            generation: 2,
        })
        .await
        .expect("scope switch");
    let stale = service
        .speak(request(
            "request-stale",
            "古いワークスペースです。",
            NarrationPriority::High,
        ))
        .await
        .expect("stale response");
    assert_eq!(stale.disposition, NarrationDisposition::Muted);

    let snapshot = service.snapshot().expect("muted snapshot");
    service
        .set_muted(NarrationMuteRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            expected_version: snapshot.settings.version,
            muted: false,
        })
        .await
        .expect("unmute");
    let stale = service
        .speak(request(
            "request-stale-after-unmute",
            "古いワークスペースです。",
            NarrationPriority::High,
        ))
        .await
        .expect("stale response after unmute");
    assert_eq!(stale.disposition, NarrationDisposition::Stale);
    service
        .cancel(NarrationCancelRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            reason: NarrationCancelReason::ExplicitCancel,
        })
        .await
        .expect("explicit cancel");
    service.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn rejects_same_workspace_scope_rollback_with_a_stable_error() {
    let fixture = FakeSayFixture::new();
    let service = service_fixture(&fixture).await;
    service
        .set_scope(NarrationScopeRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            generation: 3,
        })
        .await
        .expect("advance scope");

    let error = service
        .set_scope(NarrationScopeRequestV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            workspace_id: "workspace-1".to_owned(),
            generation: 2,
        })
        .await
        .expect_err("scope rollback must fail closed");

    assert_eq!(error.code, "NARRATION-SCOPE-ROLLBACK");
    assert!(!error.recoverable);
    service.shutdown().await.expect("shutdown");
}

#[tokio::test]
async fn rejects_unsafe_text_before_spawning_speech() {
    let fixture = FakeSayFixture::new();
    let service = service_fixture(&fixture).await;
    enable(&service).await;
    for (id, text) in [
        ("unsafe-secret", "api_key=unsafe-value"),
        ("unsafe-path", "Open /Users/example/private.txt"),
        ("unsafe-single-component-path", "Open /x"),
        ("unsafe-token", "sk-1234567890abcdef"),
    ] {
        let error = service
            .speak(request(id, text, NarrationPriority::High))
            .await
            .expect_err("unsafe text must fail");
        assert_eq!(error.code, "NARRATION-TEXT-UNSAFE");
    }
    assert!(!fixture.sidecar("playing").exists());
    service.shutdown().await.expect("shutdown");
}

#[cfg(target_os = "macos")]
#[tokio::test]
async fn production_say_binary_has_the_required_trust_metadata() {
    let binary = NarrationBinary::production();
    binary
        .verify("narration_test_binary")
        .expect("trusted /usr/bin/say");
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
