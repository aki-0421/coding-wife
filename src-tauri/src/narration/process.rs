use std::os::unix::process::CommandExt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use tokio::process::{Child, Command};

use super::error::{narration_error, NarrationResult};

const TERM_GRACE: Duration = Duration::from_millis(40);
const TOTAL_CANCEL_BUDGET: Duration = Duration::from_millis(95);

#[derive(Debug, Default)]
pub(crate) struct NarrationProcessControl {
    epoch: AtomicU64,
    spawn_gate: Mutex<()>,
    active_pid: Mutex<Option<u32>>,
}

impl NarrationProcessControl {
    pub fn epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }

    pub fn is_current(&self, expected_epoch: u64) -> bool {
        self.epoch() == expected_epoch
    }

    pub fn spawn(&self, command: &mut Command, expected_epoch: u64) -> NarrationResult<Child> {
        let _gate = self
            .spawn_gate
            .lock()
            .map_err(|_| narration_error("narration_speak", "NARRATION-PROCESS-STATE", true))?;
        if !self.is_current(expected_epoch) {
            return Err(narration_error(
                "narration_speak",
                "NARRATION-CANCELED",
                true,
            ));
        }
        command.kill_on_drop(true);
        command.as_std_mut().process_group(0);
        let child = command
            .spawn()
            .map_err(|_| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        let pid = child
            .id()
            .ok_or_else(|| narration_error("narration_speak", "NARRATION-PROCESS-SPAWN", true))?;
        *self
            .active_pid
            .lock()
            .map_err(|_| narration_error("narration_speak", "NARRATION-PROCESS-STATE", true))? =
            Some(pid);
        Ok(child)
    }

    pub fn clear(&self, pid: u32) {
        if let Ok(mut active_pid) = self.active_pid.lock() {
            if *active_pid == Some(pid) {
                *active_pid = None;
            }
        }
    }

    pub fn active_pid(&self) -> Option<u32> {
        self.active_pid.lock().ok().and_then(|active| *active)
    }

    pub fn invalidate(&self) {
        self.epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub async fn cancel_all(&self) -> bool {
        self.invalidate();
        self.terminate_active().await
    }

    pub async fn interrupt_active(&self) -> bool {
        self.terminate_active().await
    }

    async fn terminate_active(&self) -> bool {
        let pid = {
            let _gate = match self.spawn_gate.lock() {
                Ok(gate) => gate,
                Err(_) => return false,
            };
            self.active_pid()
        };
        let Some(pid) = pid else {
            return true;
        };
        let started = tokio::time::Instant::now();
        let _ = signal_process_group(pid, libc::SIGTERM);
        while started.elapsed() < TERM_GRACE {
            if !process_group_exists(pid) {
                self.clear(pid);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        let _ = signal_process_group(pid, libc::SIGKILL);
        while started.elapsed() < TOTAL_CANCEL_BUDGET {
            if !process_group_exists(pid) {
                self.clear(pid);
                return true;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        !process_group_exists(pid)
    }
}

pub(crate) async fn terminate_owned_child(
    control: &NarrationProcessControl,
    child: &mut Child,
    pid: u32,
) {
    let _ = signal_process_group(pid, libc::SIGTERM);
    let term_deadline = tokio::time::Instant::now() + TERM_GRACE;
    while tokio::time::Instant::now() < term_deadline {
        if matches!(child.try_wait(), Ok(Some(_))) || !process_group_exists(pid) {
            control.clear(pid);
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let _ = signal_process_group(pid, libc::SIGKILL);
    let _ = child.kill().await;
    let _ = tokio::time::timeout(Duration::from_millis(50), child.wait()).await;
    control.clear(pid);
}

fn signal_process_group(pid: u32, signal: i32) -> Result<(), ()> {
    let pid = i32::try_from(pid).map_err(|_| ())?;
    // SAFETY: kill receives a value-only pid/signal pair. A negative pid targets the child group.
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(())
    }
}

pub(crate) fn process_group_exists(pid: u32) -> bool {
    signal_process_group(pid, 0).is_ok()
}
