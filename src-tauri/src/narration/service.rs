use std::collections::VecDeque;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Mutex as AsyncMutex, Notify};

use super::binary::{NarrationBinary, NarrationSpeech};
use super::error::{narration_error, NarrationResult};
use super::policy::{NarrationPolicy, PolicyRejection, ScopeRejection};
use super::process::NarrationProcessControl;
use super::settings::{
    remap_settings_error, validate_api_key, validate_settings, NarrationSettingsStore,
};
use super::types::{
    NarrationApiKeyActionV2, NarrationCancelRequestV1, NarrationDisposition, NarrationKind,
    NarrationMuteRequestV1, NarrationPlaybackState, NarrationPriority, NarrationProvider,
    NarrationResetRequestV1, NarrationRuntimeSnapshotV1, NarrationScopeRequestV1,
    NarrationSettingsSnapshotV1, NarrationSettingsUpdateV2, NarrationSettingsV2,
    NarrationSpeakRequestV1, NarrationSpeakResponseV1, NarrationVoiceListV1, NarrationVoiceV1,
    NARRATION_MAX_QUEUE_DEPTH, NARRATION_SCHEMA_VERSION, NARRATION_SETTINGS_SCHEMA_VERSION,
    OPENAI_TTS_VOICES,
};

const TEST_TIMEOUT: Duration = Duration::from_secs(5);
const SPEECH_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Clone, Debug, Eq, PartialEq)]
struct NarrationRequestKey {
    workspace_id: String,
    generation: u64,
    request_id: String,
}

impl From<&NarrationSpeakRequestV1> for NarrationRequestKey {
    fn from(request: &NarrationSpeakRequestV1) -> Self {
        Self {
            workspace_id: request.workspace_id.clone(),
            generation: request.generation,
            request_id: request.request_id.clone(),
        }
    }
}

#[derive(Clone, Debug)]
struct QueuedNarration {
    request: NarrationSpeakRequestV1,
    text: String,
    epoch: u64,
}

struct SettingsState {
    store: Option<NarrationSettingsStore>,
    settings: NarrationSettingsV2,
    api_key: Option<String>,
    load_warning_code: Option<String>,
}

#[derive(Debug)]
struct RuntimeState {
    playback_state: NarrationPlaybackState,
    active_key: Option<NarrationRequestKey>,
    active_priority: Option<NarrationPriority>,
    last_error_code: Option<String>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            playback_state: NarrationPlaybackState::Idle,
            active_key: None,
            active_priority: None,
            last_error_code: None,
        }
    }
}

struct NarrationInner {
    settings: Mutex<SettingsState>,
    binary: NarrationBinary,
    process: Arc<NarrationProcessControl>,
    admission_lock: AsyncMutex<()>,
    operation_lock: AsyncMutex<()>,
    policy: Mutex<NarrationPolicy>,
    queue: Mutex<VecDeque<QueuedNarration>>,
    runtime: Mutex<RuntimeState>,
    notify: Notify,
    worker_started: AtomicBool,
    shutdown: AtomicBool,
}

#[derive(Clone)]
pub struct NarrationService {
    inner: Arc<NarrationInner>,
}

impl NarrationService {
    pub fn production(app_data_directory: impl AsRef<Path>) -> Self {
        let app_data_directory = app_data_directory.as_ref();
        let settings = match NarrationSettingsStore::open(app_data_directory) {
            Ok(opened) => SettingsState {
                store: Some(opened.store),
                settings: opened.settings,
                api_key: opened.api_key,
                load_warning_code: opened.load_warning_code,
            },
            Err(error) => SettingsState {
                store: None,
                settings: NarrationSettingsV2::default(),
                api_key: None,
                load_warning_code: Some(error.code),
            },
        };
        Self::new(settings, NarrationBinary::production(app_data_directory))
    }

    #[cfg(test)]
    pub(crate) fn fixture(
        app_data_directory: impl AsRef<Path>,
        binary: std::path::PathBuf,
    ) -> NarrationResult<Self> {
        let opened = NarrationSettingsStore::open(app_data_directory)?;
        Ok(Self::new(
            SettingsState {
                store: Some(opened.store),
                settings: opened.settings,
                api_key: opened.api_key,
                load_warning_code: opened.load_warning_code,
            },
            NarrationBinary::fixture(binary, effective_uid()),
        ))
    }

    fn new(settings: SettingsState, binary: NarrationBinary) -> Self {
        Self {
            inner: Arc::new(NarrationInner {
                settings: Mutex::new(settings),
                binary,
                process: Arc::new(NarrationProcessControl::default()),
                admission_lock: AsyncMutex::new(()),
                operation_lock: AsyncMutex::new(()),
                policy: Mutex::new(NarrationPolicy::default()),
                queue: Mutex::new(VecDeque::new()),
                runtime: Mutex::new(RuntimeState::default()),
                notify: Notify::new(),
                worker_started: AtomicBool::new(false),
                shutdown: AtomicBool::new(false),
            }),
        }
    }

    pub fn snapshot(&self) -> NarrationResult<NarrationSettingsSnapshotV1> {
        let settings = self.inner.settings.lock().map_err(|_| {
            narration_error("narration_get_settings", "NARRATION-SETTINGS-STATE", true)
        })?;
        Ok(NarrationSettingsSnapshotV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            settings: settings.settings.clone(),
            runtime: self.runtime_snapshot()?,
            load_warning_code: settings.load_warning_code.clone(),
        })
    }

    pub fn runtime_snapshot(&self) -> NarrationResult<NarrationRuntimeSnapshotV1> {
        let (playback_state, active_request_id, last_error_code) = {
            let runtime = self.inner.runtime.lock().map_err(|_| {
                narration_error("narration_get_runtime", "NARRATION-PROCESS-STATE", true)
            })?;
            (
                runtime.playback_state,
                runtime
                    .active_key
                    .as_ref()
                    .map(|key| key.request_id.clone()),
                runtime.last_error_code.clone(),
            )
        };
        Ok(NarrationRuntimeSnapshotV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            playback_state,
            active_request_id,
            queue_depth: self.queue_depth(),
            last_error_code,
        })
    }

    pub async fn list_voices(&self) -> NarrationResult<NarrationVoiceListV1> {
        let voices = OPENAI_TTS_VOICES
            .iter()
            .flat_map(|voice| {
                ["ja_JP", "en_US"].map(|locale| NarrationVoiceV1 {
                    name: (*voice).to_owned(),
                    locale: locale.to_owned(),
                })
            })
            .collect();
        Ok(NarrationVoiceListV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            voices,
        })
    }

    pub async fn update_settings(
        &self,
        request: NarrationSettingsUpdateV2,
    ) -> NarrationResult<NarrationSettingsSnapshotV1> {
        if request.schema_version != NARRATION_SETTINGS_SCHEMA_VERSION {
            return Err(narration_error(
                "narration_update_settings",
                "NARRATION-SCHEMA-VERSION",
                false,
            ));
        }
        let next_version = request.expected_version.checked_add(1).ok_or_else(|| {
            narration_error(
                "narration_update_settings",
                "NARRATION-SETTINGS-VERSION",
                false,
            )
        })?;
        let _admission = self.inner.admission_lock.lock().await;
        let next;
        {
            let mut state = self.inner.settings.lock().map_err(|_| {
                narration_error(
                    "narration_update_settings",
                    "NARRATION-SETTINGS-STATE",
                    true,
                )
            })?;
            if state.settings.version != request.expected_version {
                return Err(narration_error(
                    "narration_update_settings",
                    "NARRATION-SETTINGS-CONFLICT",
                    true,
                ));
            }
            let api_key = match request.api_key_action {
                NarrationApiKeyActionV2::Keep => state.api_key.clone(),
                NarrationApiKeyActionV2::Replace { value } => {
                    validate_api_key(&value, "narration_update_settings")?;
                    Some(value)
                }
                NarrationApiKeyActionV2::Clear => None,
            };
            next = NarrationSettingsV2 {
                schema_version: NARRATION_SETTINGS_SCHEMA_VERSION,
                version: next_version,
                enabled: request.enabled,
                muted: request.muted,
                provider: request.provider,
                api_key_configured: api_key.is_some(),
                model: request.model,
                voice: request.voice,
                speed: request.speed,
            };
            validate_settings(&next, api_key.as_deref(), "narration_update_settings")?;
            let store = state.store.as_ref().ok_or_else(|| {
                narration_error(
                    "narration_update_settings",
                    "NARRATION-SETTINGS-UNAVAILABLE",
                    true,
                )
            })?;
            store
                .save(&next, api_key.as_deref())
                .map_err(|error| remap_settings_error(error, "narration_update_settings"))?;
            state.settings = next.clone();
            state.api_key = api_key;
            state.load_warning_code = None;
        }
        if !next.enabled || next.muted {
            self.cancel_admitted().await?;
        }
        self.snapshot()
    }

    pub async fn set_muted(
        &self,
        request: NarrationMuteRequestV1,
    ) -> NarrationResult<NarrationSettingsSnapshotV1> {
        if request.schema_version != NARRATION_SCHEMA_VERSION {
            return Err(narration_error(
                "narration_set_muted",
                "NARRATION-SCHEMA-VERSION",
                false,
            ));
        }
        let current = self.snapshot()?.settings;
        self.update_settings(NarrationSettingsUpdateV2 {
            schema_version: NARRATION_SETTINGS_SCHEMA_VERSION,
            expected_version: request.expected_version,
            enabled: current.enabled,
            muted: request.muted,
            provider: current.provider,
            api_key_action: NarrationApiKeyActionV2::Keep,
            model: current.model,
            voice: current.voice,
            speed: current.speed,
        })
        .await
        .map_err(|error| error.with_operation("narration_set_muted"))
    }

    pub async fn reset_settings(
        &self,
        request: NarrationResetRequestV1,
    ) -> NarrationResult<NarrationSettingsSnapshotV1> {
        if request.schema_version != NARRATION_SCHEMA_VERSION {
            return Err(narration_error(
                "narration_reset_settings",
                "NARRATION-SCHEMA-VERSION",
                false,
            ));
        }
        let next_version = request.expected_version.checked_add(1).ok_or_else(|| {
            narration_error(
                "narration_reset_settings",
                "NARRATION-SETTINGS-VERSION",
                false,
            )
        })?;
        let _admission = self.inner.admission_lock.lock().await;
        {
            let mut state = self.inner.settings.lock().map_err(|_| {
                narration_error("narration_reset_settings", "NARRATION-SETTINGS-STATE", true)
            })?;
            if state.settings.version != request.expected_version {
                return Err(narration_error(
                    "narration_reset_settings",
                    "NARRATION-SETTINGS-CONFLICT",
                    true,
                ));
            }
            let reset = NarrationSettingsV2 {
                version: next_version,
                ..NarrationSettingsV2::default()
            };
            let store = state.store.as_ref().ok_or_else(|| {
                narration_error(
                    "narration_reset_settings",
                    "NARRATION-SETTINGS-UNAVAILABLE",
                    true,
                )
            })?;
            store
                .save(&reset, None)
                .map_err(|error| remap_settings_error(error, "narration_reset_settings"))?;
            state.settings = reset;
            state.api_key = None;
            state.load_warning_code = None;
        }
        self.cancel_admitted().await?;
        self.snapshot()
    }

    pub async fn set_scope(&self, request: NarrationScopeRequestV1) -> NarrationResult<()> {
        if request.schema_version != NARRATION_SCHEMA_VERSION
            || !is_opaque_identifier(&request.workspace_id)
        {
            return Err(narration_error(
                "narration_set_scope",
                "NARRATION-SCOPE-INVALID",
                false,
            ));
        }
        let _admission = self.inner.admission_lock.lock().await;
        let changed = self
            .inner
            .policy
            .lock()
            .map_err(|_| narration_error("narration_set_scope", "NARRATION-POLICY-STATE", true))?
            .set_scope(request.clone())
            .map_err(|rejection| match rejection {
                ScopeRejection::Rollback => {
                    narration_error("narration_set_scope", "NARRATION-SCOPE-ROLLBACK", false)
                }
            })?;
        if changed {
            self.cancel_admitted().await?;
            self.inner
                .policy
                .lock()
                .map_err(|_| {
                    narration_error("narration_set_scope", "NARRATION-POLICY-STATE", true)
                })?
                .set_scope(request)
                .map_err(|_| {
                    narration_error("narration_set_scope", "NARRATION-SCOPE-ROLLBACK", false)
                })?;
        }
        Ok(())
    }

    pub async fn speak(
        &self,
        request: NarrationSpeakRequestV1,
    ) -> NarrationResult<NarrationSpeakResponseV1> {
        self.ensure_worker();
        let _admission = self.inner.admission_lock.lock().await;
        let settings = self.snapshot()?.settings;
        if !settings.enabled {
            return Ok(self.response(NarrationDisposition::Disabled, None));
        }
        if settings.muted {
            return Ok(self.response(NarrationDisposition::Muted, None));
        }
        if settings.provider != Some(NarrationProvider::OpenAi) || !settings.api_key_configured {
            return Ok(self.response(
                NarrationDisposition::Unavailable,
                Some("NARRATION-PROVIDER-UNAVAILABLE"),
            ));
        }

        let (queue_depth, should_interrupt, response_code) = {
            let mut queue =
                self.inner.queue.lock().map_err(|_| {
                    narration_error("narration_speak", "NARRATION-QUEUE-STATE", true)
                })?;
            let eviction_index = if queue.len() >= NARRATION_MAX_QUEUE_DEPTH {
                queue
                    .iter()
                    .position(|job| job.request.priority == NarrationPriority::Low)
            } else {
                None
            };
            if queue.len() >= NARRATION_MAX_QUEUE_DEPTH && eviction_index.is_none() {
                return Ok(self.response_with_depth(
                    NarrationDisposition::DroppedQueueFull,
                    Some("NARRATION-QUEUE-FULL"),
                    queue.len(),
                ));
            }
            let validated = match self
                .inner
                .policy
                .lock()
                .map_err(|_| narration_error("narration_speak", "NARRATION-POLICY-STATE", true))?
                .validate_and_record(&request, Instant::now())
            {
                Ok(validated) => validated,
                Err(PolicyRejection::Stale) => {
                    return Ok(self.response_with_depth(
                        NarrationDisposition::Stale,
                        Some("NARRATION-STALE"),
                        queue.len(),
                    ));
                }
                Err(PolicyRejection::Sequence) => {
                    return Ok(self.response_with_depth(
                        NarrationDisposition::DroppedSequence,
                        Some("NARRATION-SEQUENCE"),
                        queue.len(),
                    ));
                }
                Err(PolicyRejection::Duplicate) => {
                    return Ok(self.response_with_depth(
                        NarrationDisposition::DroppedDuplicate,
                        Some("NARRATION-DUPLICATE"),
                        queue.len(),
                    ));
                }
                Err(PolicyRejection::InvalidSchema) => {
                    return Err(narration_error(
                        "narration_speak",
                        "NARRATION-SCHEMA-VERSION",
                        false,
                    ));
                }
                Err(PolicyRejection::InvalidIdentifier) => {
                    return Err(narration_error(
                        "narration_speak",
                        "NARRATION-IDENTIFIER-INVALID",
                        false,
                    ));
                }
                Err(PolicyRejection::UnsafeText) => {
                    return Err(narration_error(
                        "narration_speak",
                        "NARRATION-TEXT-UNSAFE",
                        false,
                    ));
                }
            };
            let should_interrupt = request.priority == NarrationPriority::High
                && self
                    .inner
                    .runtime
                    .lock()
                    .ok()
                    .and_then(|runtime| runtime.active_priority)
                    .is_some_and(|priority| priority < NarrationPriority::High);
            let queued = QueuedNarration {
                request,
                text: validated.text,
                epoch: self.inner.process.epoch(),
            };
            if let Some(index) = eviction_index {
                queue.remove(index);
            }
            let insertion_index = queue
                .iter()
                .position(|existing| existing.request.priority < queued.request.priority)
                .unwrap_or(queue.len());
            queue.insert(insertion_index, queued);
            (
                queue.len(),
                should_interrupt,
                eviction_index.map(|_| "NARRATION-QUEUE-EVICTED-LOW"),
            )
        };
        self.inner.notify.notify_one();
        if should_interrupt {
            let _ = self.inner.process.interrupt_active().await;
        }
        Ok(self.response_with_depth(NarrationDisposition::Queued, response_code, queue_depth))
    }

    pub async fn cancel(&self, request: NarrationCancelRequestV1) -> NarrationResult<()> {
        if request.schema_version != NARRATION_SCHEMA_VERSION {
            return Err(narration_error(
                "narration_cancel",
                "NARRATION-SCHEMA-VERSION",
                false,
            ));
        }
        let _reason = request.reason;
        let _admission = self.inner.admission_lock.lock().await;
        self.cancel_admitted().await
    }

    pub async fn shutdown(&self) -> NarrationResult<()> {
        self.inner.shutdown.store(true, Ordering::Release);
        self.inner.notify.notify_one();
        let _admission = self.inner.admission_lock.lock().await;
        self.cancel_admitted().await
    }

    pub async fn force_shutdown_now(&self) -> bool {
        self.inner.shutdown.store(true, Ordering::Release);
        self.inner.notify.notify_waiters();
        if let Ok(mut queue) = self.inner.queue.lock() {
            queue.clear();
        }
        let converged = self.inner.process.force_cancel_all().await;
        if let Ok(mut runtime) = self.inner.runtime.lock() {
            runtime.playback_state = NarrationPlaybackState::Idle;
            runtime.active_key = None;
            runtime.active_priority = None;
        }
        converged
    }

    fn ensure_worker(&self) {
        if self
            .inner
            .worker_started
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
        {
            let inner = self.inner.clone();
            tokio::spawn(async move { worker_loop(inner).await });
        }
    }

    async fn cancel_admitted(&self) -> NarrationResult<()> {
        let mut canceled = Vec::new();
        {
            let mut queue =
                self.inner.queue.lock().map_err(|_| {
                    narration_error("narration_cancel", "NARRATION-QUEUE-STATE", true)
                })?;
            canceled.extend(
                queue
                    .drain(..)
                    .map(|job| NarrationRequestKey::from(&job.request)),
            );
        }
        if let Some(active) = self
            .inner
            .runtime
            .lock()
            .map_err(|_| narration_error("narration_cancel", "NARRATION-PROCESS-STATE", true))?
            .active_key
            .clone()
        {
            canceled.push(active);
        }
        {
            let mut policy =
                self.inner.policy.lock().map_err(|_| {
                    narration_error("narration_cancel", "NARRATION-POLICY-STATE", true)
                })?;
            for key in canceled {
                policy.cancel_request(&key.workspace_id, key.generation, &key.request_id);
            }
        }
        let converged = self.inner.process.cancel_all().await;
        {
            let mut runtime = self.inner.runtime.lock().map_err(|_| {
                narration_error("narration_cancel", "NARRATION-PROCESS-STATE", true)
            })?;
            runtime.playback_state = NarrationPlaybackState::Idle;
            runtime.active_key = None;
            runtime.active_priority = None;
            runtime.last_error_code = None;
        }
        self.inner.notify.notify_one();
        if converged {
            Ok(())
        } else {
            Err(narration_error(
                "narration_cancel",
                "NARRATION-PROCESS-CANCEL",
                true,
            ))
        }
    }

    fn response(
        &self,
        disposition: NarrationDisposition,
        code: Option<&str>,
    ) -> NarrationSpeakResponseV1 {
        self.response_with_depth(disposition, code, self.queue_depth())
    }

    fn response_with_depth(
        &self,
        disposition: NarrationDisposition,
        code: Option<&str>,
        queue_depth: usize,
    ) -> NarrationSpeakResponseV1 {
        NarrationSpeakResponseV1 {
            schema_version: NARRATION_SCHEMA_VERSION,
            disposition,
            queue_depth,
            code: code.map(str::to_owned),
        }
    }

    fn queue_depth(&self) -> usize {
        self.inner.queue.lock().map_or(0, |queue| queue.len())
    }
}

async fn worker_loop(inner: Arc<NarrationInner>) {
    loop {
        if inner.shutdown.load(Ordering::Acquire) {
            break;
        }
        let Some(job) = pop_job(&inner) else {
            inner.notify.notified().await;
            continue;
        };
        if !inner.process.is_current(job.epoch) {
            continue;
        }
        set_active(&inner, &job, NarrationPlaybackState::Preparing);
        if !wait_until_eligible(&inner, &job).await {
            finish_job(&inner, &job, None);
            continue;
        }
        let (settings, api_key) = match inner.settings.lock() {
            Ok(settings) => (settings.settings.clone(), settings.api_key.clone()),
            Err(_) => {
                finish_job(&inner, &job, Some("NARRATION-SETTINGS-STATE"));
                continue;
            }
        };
        if !settings.enabled || settings.muted || !inner.process.is_current(job.epoch) {
            finish_job(&inner, &job, None);
            continue;
        }
        if settings.provider != Some(NarrationProvider::OpenAi) {
            finish_job(&inner, &job, Some("NARRATION-PROVIDER-UNAVAILABLE"));
            continue;
        };
        let Some(api_key) = api_key else {
            finish_job(&inner, &job, Some("NARRATION-API-KEY-REQUIRED"));
            continue;
        };
        if let Ok(mut policy) = inner.policy.lock() {
            policy.record_start(Instant::now());
        }
        set_active(&inner, &job, NarrationPlaybackState::Playing);
        let timeout = if job.request.kind == NarrationKind::Test {
            TEST_TIMEOUT
        } else {
            SPEECH_TIMEOUT
        };
        let result = {
            let _operation = inner.operation_lock.lock().await;
            inner
                .binary
                .speak(
                    inner.process.clone(),
                    job.epoch,
                    NarrationSpeech {
                        api_key: &api_key,
                        model: &settings.model,
                        voice: &settings.voice,
                        speed: settings.speed,
                        text: &job.text,
                        timeout,
                    },
                )
                .await
        };
        if !inner.process.is_current(job.epoch) {
            finish_job(&inner, &job, None);
            continue;
        }
        let preempted = job.request.priority < NarrationPriority::High
            && inner.queue.lock().ok().is_some_and(|queue| {
                queue
                    .front()
                    .is_some_and(|next| next.request.priority == NarrationPriority::High)
            });
        match result {
            Ok(()) => finish_job(&inner, &job, None),
            Err(_) if preempted => finish_job(&inner, &job, None),
            Err(error) => finish_job(&inner, &job, Some(&error.code)),
        }
    }
}

fn pop_job(inner: &NarrationInner) -> Option<QueuedNarration> {
    inner.queue.lock().ok()?.pop_front()
}

fn set_active(
    inner: &NarrationInner,
    job: &QueuedNarration,
    playback_state: NarrationPlaybackState,
) {
    if let Ok(mut runtime) = inner.runtime.lock() {
        runtime.playback_state = playback_state;
        runtime.active_key = Some(NarrationRequestKey::from(&job.request));
        runtime.active_priority = Some(job.request.priority);
        runtime.last_error_code = None;
    }
}

fn finish_job(inner: &NarrationInner, job: &QueuedNarration, error_code: Option<&str>) {
    if let Ok(mut runtime) = inner.runtime.lock() {
        if runtime.active_key.as_ref() != Some(&NarrationRequestKey::from(&job.request)) {
            return;
        }
        runtime.playback_state = if error_code.is_some() {
            NarrationPlaybackState::Unavailable
        } else {
            NarrationPlaybackState::Idle
        };
        runtime.active_key = None;
        runtime.active_priority = None;
        runtime.last_error_code = error_code.map(str::to_owned);
    }
}

async fn wait_until_eligible(inner: &NarrationInner, job: &QueuedNarration) -> bool {
    loop {
        if !inner.process.is_current(job.epoch) || inner.shutdown.load(Ordering::Acquire) {
            return false;
        }
        if job.request.priority < NarrationPriority::High
            && inner.queue.lock().ok().is_some_and(|queue| {
                queue
                    .front()
                    .is_some_and(|next| next.request.priority == NarrationPriority::High)
            })
        {
            return false;
        }
        let delay = match inner.policy.lock() {
            Ok(mut policy) => policy.delay_before_start(job.request.priority, Instant::now()),
            Err(_) => return false,
        };
        if delay.is_zero() {
            return true;
        }
        tokio::select! {
            _ = tokio::time::sleep(delay) => {},
            _ = inner.notify.notified() => {},
        }
    }
}

fn is_opaque_identifier(value: &str) -> bool {
    (1..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':'))
}

#[cfg(test)]
fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
