use tokio::process::Command;

pub(crate) const SIGTERM: i32 = 15;
pub(crate) const SIGKILL: i32 = 9;

#[cfg(unix)]
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::unix::process::CommandExt;

    command.as_std_mut().process_group(0);
}

#[cfg(windows)]
pub(crate) fn configure_process_group(command: &mut Command) {
    use std::os::windows::process::CommandExt;

    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command
        .as_std_mut()
        .creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

#[cfg(unix)]
pub(crate) fn signal_process_group(pid: u32, signal: i32) -> Result<(), ()> {
    let pid = i32::try_from(pid).map_err(|_| ())?;
    // SAFETY: kill receives a value-only pid/signal pair. A negative pid targets the child group.
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        Ok(())
    } else {
        Err(())
    }
}

#[cfg(windows)]
pub(crate) fn signal_process_group(pid: u32, signal: i32) -> Result<(), ()> {
    if signal == 0 {
        return process_group_exists(pid).then_some(()).ok_or(());
    }

    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = std::process::Command::new("taskkill.exe");
    command
        .args(["/PID", &pid.to_string(), "/T"])
        .creation_flags(CREATE_NO_WINDOW);
    if signal == SIGKILL {
        command.arg("/F");
    }
    match command.status() {
        Ok(status) if status.success() || !process_group_exists(pid) => Ok(()),
        _ => Err(()),
    }
}

#[cfg(unix)]
pub(crate) fn process_group_exists(pid: u32) -> bool {
    signal_process_group(pid, 0).is_ok()
}

#[cfg(windows)]
pub(crate) fn process_group_exists(pid: u32) -> bool {
    type Handle = *mut std::ffi::c_void;

    const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
    const STILL_ACTIVE: u32 = 259;

    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(desired_access: u32, inherit_handle: i32, process_id: u32) -> Handle;
        fn GetExitCodeProcess(process: Handle, exit_code: *mut u32) -> i32;
        fn CloseHandle(object: Handle) -> i32;
    }

    // SAFETY: the handle is checked before use, the output pointer is valid, and the handle is
    // closed exactly once before returning.
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        let mut exit_code = 0_u32;
        let queried = GetExitCodeProcess(handle, &mut exit_code);
        let _ = CloseHandle(handle);
        queried != 0 && exit_code == STILL_ACTIVE
    }
}
