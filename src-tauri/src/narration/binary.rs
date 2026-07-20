use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::io::AsyncWriteExt;
use tokio::process::{Child, Command};

use super::error::{narration_error, NarrationResult};
use super::process::{terminate_owned_child, NarrationProcessControl};

const PRODUCTION_CURL_PATH: &str = "/usr/bin/curl";
const PRODUCTION_PLAYER_PATH: &str = "/usr/bin/afplay";
const OPENAI_SPEECH_ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
const MAX_AUDIO_BYTES: u64 = 8 * 1024 * 1024;

#[derive(Clone, Debug)]
enum NarrationAdapter {
    Production {
        curl_path: PathBuf,
        player_path: PathBuf,
        runtime_directory: PathBuf,
    },
    #[cfg(test)]
    Fixture { path: PathBuf },
}

#[derive(Clone, Debug)]
pub(crate) struct NarrationBinary {
    adapter: NarrationAdapter,
    expected_uid: u32,
}

#[derive(Clone, Copy)]
pub(crate) struct NarrationSpeech<'a> {
    pub api_key: &'a str,
    pub model: &'a str,
    pub voice: &'a str,
    pub speed: f64,
    pub text: &'a str,
    pub timeout: Duration,
}

impl NarrationBinary {
    pub fn production(app_data_directory: impl AsRef<Path>) -> Self {
        Self {
            adapter: NarrationAdapter::Production {
                curl_path: PathBuf::from(PRODUCTION_CURL_PATH),
                player_path: PathBuf::from(PRODUCTION_PLAYER_PATH),
                runtime_directory: app_data_directory.as_ref().join("narration"),
            },
            expected_uid: 0,
        }
    }

    #[cfg(test)]
    pub fn fixture(path: PathBuf, expected_uid: u32) -> Self {
        Self {
            adapter: NarrationAdapter::Fixture { path },
            expected_uid,
        }
    }

    #[cfg(test)]
    pub fn verify(&self, operation: &str) -> NarrationResult<()> {
        match &self.adapter {
            NarrationAdapter::Production {
                curl_path,
                player_path,
                ..
            } => {
                verify_binary(curl_path, PRODUCTION_CURL_PATH, self.expected_uid)
                    .map_err(|error| error.with_operation(operation))?;
                verify_binary(player_path, PRODUCTION_PLAYER_PATH, self.expected_uid)
                    .map_err(|error| error.with_operation(operation))
            }
            #[cfg(test)]
            NarrationAdapter::Fixture { path } => verify_binary(path, path, self.expected_uid)
                .map_err(|error| error.with_operation(operation)),
        }
    }

    pub async fn speak(
        &self,
        control: Arc<NarrationProcessControl>,
        expected_epoch: u64,
        speech: NarrationSpeech<'_>,
    ) -> NarrationResult<()> {
        match &self.adapter {
            NarrationAdapter::Production {
                curl_path,
                player_path,
                runtime_directory,
            } => {
                self.speak_openai(
                    curl_path,
                    player_path,
                    runtime_directory,
                    control,
                    expected_epoch,
                    speech,
                )
                .await
            }
            #[cfg(test)]
            NarrationAdapter::Fixture { path } => {
                self.speak_fixture(path, control, expected_epoch, speech)
                    .await
            }
        }
    }

    async fn speak_openai(
        &self,
        curl_path: &Path,
        player_path: &Path,
        runtime_directory: &Path,
        control: Arc<NarrationProcessControl>,
        expected_epoch: u64,
        speech: NarrationSpeech<'_>,
    ) -> NarrationResult<()> {
        verify_binary(curl_path, PRODUCTION_CURL_PATH, self.expected_uid)?;
        verify_binary(player_path, PRODUCTION_PLAYER_PATH, self.expected_uid)?;
        let started = Instant::now();
        let files = SpeechFiles::create(runtime_directory, &speech)?;
        let mut command = Command::new(curl_path);
        command
            .arg("-q")
            .arg("--fail")
            .arg("--silent")
            .arg("--show-error")
            .arg("--connect-timeout")
            .arg("10")
            .arg("--max-time")
            .arg("30")
            .arg("--max-filesize")
            .arg(MAX_AUDIO_BYTES.to_string())
            .arg("--request")
            .arg("POST")
            .arg("--header")
            .arg("Content-Type: application/json")
            .arg("--config")
            .arg("-")
            .arg("--data-binary")
            .arg(format!("@{}", files.request.display()))
            .arg("--output")
            .arg(&files.audio)
            .arg(OPENAI_SPEECH_ENDPOINT)
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        verify_binary(curl_path, PRODUCTION_CURL_PATH, self.expected_uid)?;
        let mut child = control.spawn(&mut command, expected_epoch)?;
        let pid = child
            .id()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-STDIN", true))?;
        let authorization = format!("header = \"Authorization: Bearer {}\"\n", speech.api_key);
        if stdin.write_all(authorization.as_bytes()).await.is_err()
            || stdin.shutdown().await.is_err()
        {
            terminate_owned_child(&control, &mut child, pid).await;
            return Err(narration_error(
                "narration_speak",
                "NARRATION-PROCESS-STDIN",
                true,
            ));
        }
        drop(stdin);
        wait_for_success(&control, &mut child, pid, expected_epoch, speech.timeout).await?;
        verify_audio_file(&files.audio)?;
        if !control.is_current(expected_epoch) {
            return Err(narration_error(
                "narration_speak",
                "NARRATION-CANCELED",
                true,
            ));
        }

        let mut player = Command::new(player_path);
        player
            .arg(&files.audio)
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        verify_binary(player_path, PRODUCTION_PLAYER_PATH, self.expected_uid)?;
        let mut child = control.spawn(&mut player, expected_epoch)?;
        let pid = child
            .id()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        let remaining = speech.timeout.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            terminate_owned_child(&control, &mut child, pid).await;
            return Err(narration_error(
                "narration_speak",
                "NARRATION-PROCESS-TIMEOUT",
                true,
            ));
        }
        wait_for_success(&control, &mut child, pid, expected_epoch, remaining).await
    }

    #[cfg(test)]
    async fn speak_fixture(
        &self,
        path: &Path,
        control: Arc<NarrationProcessControl>,
        expected_epoch: u64,
        speech: NarrationSpeech<'_>,
    ) -> NarrationResult<()> {
        verify_binary(path, path, self.expected_uid)?;
        let mut command = Command::new(path);
        command
            .arg("-v")
            .arg(speech.voice)
            .arg("-r")
            .arg(speech.speed.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        verify_binary(path, path, self.expected_uid)?;
        let mut child = control.spawn(&mut command, expected_epoch)?;
        let pid = child
            .id()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-STDIN", true))?;
        if stdin.write_all(speech.text.as_bytes()).await.is_err() || stdin.shutdown().await.is_err()
        {
            terminate_owned_child(&control, &mut child, pid).await;
            return Err(narration_error(
                "narration_speak",
                "NARRATION-PROCESS-STDIN",
                true,
            ));
        }
        drop(stdin);
        wait_for_success(&control, &mut child, pid, expected_epoch, speech.timeout).await
    }
}

async fn wait_for_success(
    control: &NarrationProcessControl,
    child: &mut Child,
    pid: u32,
    expected_epoch: u64,
    timeout: Duration,
) -> NarrationResult<()> {
    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(_)) => {
            terminate_owned_child(control, child, pid).await;
            return Err(narration_error(
                "narration_speak",
                "NARRATION-PROCESS-WAIT",
                true,
            ));
        }
        Err(_) => {
            terminate_owned_child(control, child, pid).await;
            return Err(narration_error(
                "narration_speak",
                "NARRATION-PROCESS-TIMEOUT",
                true,
            ));
        }
    };
    control.clear(pid);
    if !control.is_current(expected_epoch) {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-CANCELED",
            true,
        ));
    }
    if !status.success() {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-PROCESS-EXIT",
            true,
        ));
    }
    Ok(())
}

fn verify_binary(
    path: &Path,
    expected_path: impl AsRef<Path>,
    expected_uid: u32,
) -> NarrationResult<()> {
    if path != expected_path.as_ref() {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-BINARY-PATH",
            false,
        ));
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| narration_error("narration_speak", "NARRATION-BINARY-UNAVAILABLE", true))?;
    let mode = metadata.permissions().mode();
    if !metadata.file_type().is_file()
        || metadata.uid() != expected_uid
        || mode & 0o022 != 0
        || mode & 0o111 == 0
    {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-BINARY-UNTRUSTED",
            false,
        ));
    }
    Ok(())
}

#[derive(Debug)]
struct SpeechFiles {
    request: PathBuf,
    audio: PathBuf,
}

impl SpeechFiles {
    fn create(runtime_directory: &Path, speech: &NarrationSpeech<'_>) -> NarrationResult<Self> {
        let request = runtime_directory.join(format!("request-{}.json", uuid::Uuid::new_v4()));
        let audio = runtime_directory.join(format!("speech-{}.wav", uuid::Uuid::new_v4()));
        let result = (|| {
            let mut request_file = private_new_file(&request)?;
            let _audio_file = private_new_file(&audio)?;
            let body = serde_json::to_vec(&serde_json::json!({
                "model": speech.model,
                "input": speech.text,
                "voice": speech.voice,
                "speed": speech.speed,
                "response_format": "wav",
            }))
            .map_err(|_| {
                narration_error("narration_speak", "NARRATION-REQUEST-SERIALIZE", false)
            })?;
            request_file
                .write_all(&body)
                .map_err(|_| narration_error("narration_speak", "NARRATION-REQUEST-WRITE", true))?;
            request_file
                .sync_all()
                .map_err(|_| narration_error("narration_speak", "NARRATION-REQUEST-WRITE", true))?;
            Ok(Self { request, audio })
        })();
        if result.is_err() {
            let _ = fs::remove_file(&request);
            let _ = fs::remove_file(&audio);
        }
        result
    }
}

impl Drop for SpeechFiles {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.request);
        let _ = fs::remove_file(&self.audio);
    }
}

fn private_new_file(path: &Path) -> NarrationResult<File> {
    let mut options = OpenOptions::new();
    options.create_new(true).write(true).mode(0o600);
    let file = options
        .open(path)
        .map_err(|_| narration_error("narration_speak", "NARRATION-TEMP-FILE", true))?;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|_| narration_error("narration_speak", "NARRATION-TEMP-FILE", true))?;
    Ok(file)
}

fn verify_audio_file(path: &Path) -> NarrationResult<()> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| narration_error("narration_speak", "NARRATION-AUDIO-INVALID", true))?;
    if !metadata.file_type().is_file()
        || metadata.uid() != effective_uid()
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_AUDIO_BYTES
        || metadata.len() < 12
    {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-AUDIO-INVALID",
            false,
        ));
    }
    let mut file = File::open(path)
        .map_err(|_| narration_error("narration_speak", "NARRATION-AUDIO-INVALID", true))?;
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| narration_error("narration_speak", "NARRATION-AUDIO-INVALID", false))?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(narration_error(
            "narration_speak",
            "NARRATION-AUDIO-INVALID",
            false,
        ));
    }
    Ok(())
}

fn effective_uid() -> u32 {
    // SAFETY: geteuid has no arguments and returns the current process identity.
    unsafe { libc::geteuid() }
}
