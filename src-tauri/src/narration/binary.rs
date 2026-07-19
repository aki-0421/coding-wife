use std::collections::BTreeSet;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::error::{narration_error, NarrationResult};
use super::process::{terminate_owned_child, NarrationProcessControl};
use super::types::{NarrationLocale, NarrationVoiceV1};

const PRODUCTION_SAY_PATH: &str = "/usr/bin/say";
const VOICE_LIST_LIMIT: usize = 64 * 1024;
const VOICE_LIST_MAX_LINES: usize = 512;
const VOICE_LIST_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub(crate) struct NarrationBinary {
    path: PathBuf,
    expected_uid: u32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct NarrationSpeech<'a> {
    pub locale: NarrationLocale,
    pub voice: &'a str,
    pub words_per_minute: u16,
    pub text: &'a str,
    pub timeout: Duration,
}

impl NarrationBinary {
    pub fn production() -> Self {
        Self {
            path: PathBuf::from(PRODUCTION_SAY_PATH),
            expected_uid: 0,
        }
    }

    #[cfg(test)]
    pub fn fixture(path: PathBuf, expected_uid: u32) -> Self {
        Self { path, expected_uid }
    }

    pub fn verify(&self, operation: &str) -> NarrationResult<()> {
        if self.expected_uid == 0 && self.path != Path::new(PRODUCTION_SAY_PATH) {
            return Err(narration_error(operation, "NARRATION-BINARY-PATH", false));
        }
        let metadata = std::fs::symlink_metadata(&self.path)
            .map_err(|_| narration_error(operation, "NARRATION-BINARY-UNAVAILABLE", true))?;
        let mode = metadata.permissions().mode();
        if !metadata.file_type().is_file()
            || metadata.uid() != self.expected_uid
            || mode & 0o022 != 0
            || mode & 0o111 == 0
        {
            return Err(narration_error(
                operation,
                "NARRATION-BINARY-UNTRUSTED",
                false,
            ));
        }
        Ok(())
    }

    pub async fn list_voices(
        &self,
        control: Arc<NarrationProcessControl>,
        expected_epoch: u64,
    ) -> NarrationResult<Vec<NarrationVoiceV1>> {
        self.verify("narration_list_voices")?;
        let mut command = Command::new(&self.path);
        command
            .arg("-v")
            .arg("?")
            .env_clear()
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        self.verify("narration_list_voices")?;
        let mut child = control.spawn(&mut command, expected_epoch)?;
        let pid = child.id().ok_or_else(|| {
            narration_error("narration_list_voices", "NARRATION-PROCESS-SPAWN", true)
        })?;
        let stdout = match child.stdout.take() {
            Some(stdout) => stdout,
            None => {
                terminate_owned_child(&control, &mut child, pid).await;
                return Err(narration_error(
                    "narration_list_voices",
                    "NARRATION-PROCESS-STDOUT",
                    true,
                ));
            }
        };
        let capture = tokio::spawn(read_bounded(stdout, VOICE_LIST_LIMIT));
        let status = match tokio::time::timeout(VOICE_LIST_TIMEOUT, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => {
                terminate_owned_child(&control, &mut child, pid).await;
                capture.abort();
                return Err(narration_error(
                    "narration_list_voices",
                    "NARRATION-PROCESS-WAIT",
                    true,
                ));
            }
            Err(_) => {
                terminate_owned_child(&control, &mut child, pid).await;
                capture.abort();
                return Err(narration_error(
                    "narration_list_voices",
                    "NARRATION-PROCESS-TIMEOUT",
                    true,
                ));
            }
        };
        control.clear(pid);
        if !control.is_current(expected_epoch) {
            capture.abort();
            return Err(narration_error(
                "narration_list_voices",
                "NARRATION-CANCELED",
                true,
            ));
        }
        if !status.success() {
            capture.abort();
            return Err(narration_error(
                "narration_list_voices",
                "NARRATION-VOICE-LIST-EXIT",
                true,
            ));
        }
        let output = capture.await.map_err(|_| {
            narration_error("narration_list_voices", "NARRATION-VOICE-LIST-READ", true)
        })??;
        parse_voice_list(&output)
    }

    pub async fn speak(
        &self,
        control: Arc<NarrationProcessControl>,
        expected_epoch: u64,
        speech: NarrationSpeech<'_>,
    ) -> NarrationResult<()> {
        let voices = self.list_voices(control.clone(), expected_epoch).await?;
        if !exact_voice_available(&voices, speech.locale, speech.voice) {
            return Err(narration_error(
                "narration_speak",
                "NARRATION-VOICE-UNAVAILABLE",
                true,
            ));
        }
        self.verify("narration_speak")?;
        let mut command = Command::new(&self.path);
        command
            .arg("-v")
            .arg(speech.voice)
            .arg("-r")
            .arg(speech.words_per_minute.to_string())
            .env_clear()
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        self.verify("narration_speak")?;
        let mut child = control.spawn(&mut command, expected_epoch)?;
        let pid = child
            .id()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        let mut stdin = match child.stdin.take() {
            Some(stdin) => stdin,
            None => {
                terminate_owned_child(&control, &mut child, pid).await;
                return Err(narration_error(
                    "narration_speak",
                    "NARRATION-PROCESS-STDIN",
                    true,
                ));
            }
        };
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
        let status = match tokio::time::timeout(speech.timeout, child.wait()).await {
            Ok(Ok(status)) => status,
            Ok(Err(_)) => {
                terminate_owned_child(&control, &mut child, pid).await;
                return Err(narration_error(
                    "narration_speak",
                    "NARRATION-PROCESS-WAIT",
                    true,
                ));
            }
            Err(_) => {
                terminate_owned_child(&control, &mut child, pid).await;
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
}

async fn read_bounded<R>(mut reader: R, limit: usize) -> NarrationResult<Vec<u8>>
where
    R: AsyncRead + Unpin,
{
    let mut output = Vec::with_capacity(limit.min(16 * 1024));
    let mut buffer = [0_u8; 4096];
    loop {
        let count = reader.read(&mut buffer).await.map_err(|_| {
            narration_error("narration_list_voices", "NARRATION-VOICE-LIST-READ", true)
        })?;
        if count == 0 {
            return Ok(output);
        }
        if output.len().saturating_add(count) > limit {
            return Err(narration_error(
                "narration_list_voices",
                "NARRATION-VOICE-LIST-SIZE",
                false,
            ));
        }
        output.extend_from_slice(&buffer[..count]);
    }
}

fn parse_voice_list(bytes: &[u8]) -> NarrationResult<Vec<NarrationVoiceV1>> {
    let output = std::str::from_utf8(bytes).map_err(|_| {
        narration_error("narration_list_voices", "NARRATION-VOICE-LIST-UTF8", false)
    })?;
    if output.lines().count() > VOICE_LIST_MAX_LINES {
        return Err(narration_error(
            "narration_list_voices",
            "NARRATION-VOICE-LIST-SIZE",
            false,
        ));
    }
    let mut seen = BTreeSet::new();
    let mut voices = Vec::new();
    for line in output.lines() {
        let columns = line
            .split_once('#')
            .map_or(line, |(columns, _)| columns)
            .split_whitespace()
            .collect::<Vec<_>>();
        let Some(locale_index) = columns.iter().position(|column| {
            *column == "ja_JP"
                || (column.starts_with("en_")
                    && column.len() == 5
                    && column[3..].bytes().all(|byte| byte.is_ascii_uppercase()))
        }) else {
            continue;
        };
        if locale_index == 0 {
            continue;
        }
        let name = columns[..locale_index].join(" ");
        let locale = columns[locale_index].to_owned();
        if name.is_empty()
            || name.chars().count() > 128
            || name.starts_with('-')
            || name.chars().any(char::is_control)
        {
            return Err(narration_error(
                "narration_list_voices",
                "NARRATION-VOICE-LIST-INVALID",
                false,
            ));
        }
        if seen.insert((locale.clone(), name.clone())) {
            voices.push(NarrationVoiceV1 { name, locale });
        }
    }
    voices.sort_by(|left, right| {
        left.locale
            .cmp(&right.locale)
            .then_with(|| left.name.cmp(&right.name))
    });
    if voices.is_empty() {
        return Err(narration_error(
            "narration_list_voices",
            "NARRATION-VOICE-UNAVAILABLE",
            true,
        ));
    }
    Ok(voices)
}

pub(crate) fn exact_voice_available(
    voices: &[NarrationVoiceV1],
    locale: NarrationLocale,
    selected: &str,
) -> bool {
    voices
        .iter()
        .any(|voice| voice.name == selected && locale.accepts_locale(&voice.locale))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_unicode_and_space_bearing_exact_voice_names() {
        let voices = parse_voice_list(
            "Kyoko               ja_JP    # sample\nEddy (日本語（日本）)    ja_JP # sample\nSamantha en_US # sample\n"
                .as_bytes(),
        )
        .expect("voice list");
        assert_eq!(voices.len(), 3);
        assert!(exact_voice_available(
            &voices,
            NarrationLocale::Ja,
            "Eddy (日本語（日本）)"
        ));
        assert!(!exact_voice_available(
            &voices,
            NarrationLocale::En,
            "Eddy (日本語（日本）)"
        ));
    }
}
