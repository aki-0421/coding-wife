use std::fs::{DirBuilder, Metadata, OpenOptions, Permissions};

pub(crate) trait MetadataExt {
    fn dev(&self) -> u64;
    fn ino(&self) -> u64;
    fn uid(&self) -> u32;
    fn gid(&self) -> u32;
    fn mode(&self) -> u32;
    fn nlink(&self) -> u64;
    fn size(&self) -> u64;
    fn mtime(&self) -> i64;
    fn mtime_nsec(&self) -> i64;
    fn ctime(&self) -> i64;
    fn ctime_nsec(&self) -> i64;
}

pub(crate) trait PermissionsExt {
    fn from_mode(mode: u32) -> Self;
    fn mode(&self) -> u32;
}

pub(crate) trait OpenOptionsExt {
    fn mode(&mut self, mode: u32) -> &mut Self;
    fn custom_flags(&mut self, flags: i32) -> &mut Self;
}

pub(crate) trait DirBuilderExt {
    fn mode(&mut self, mode: u32) -> &mut Self;
}

#[cfg(unix)]
impl MetadataExt for Metadata {
    fn dev(&self) -> u64 {
        std::os::unix::fs::MetadataExt::dev(self)
    }

    fn ino(&self) -> u64 {
        std::os::unix::fs::MetadataExt::ino(self)
    }

    fn uid(&self) -> u32 {
        std::os::unix::fs::MetadataExt::uid(self)
    }

    fn gid(&self) -> u32 {
        std::os::unix::fs::MetadataExt::gid(self)
    }

    fn mode(&self) -> u32 {
        std::os::unix::fs::MetadataExt::mode(self)
    }

    fn nlink(&self) -> u64 {
        std::os::unix::fs::MetadataExt::nlink(self)
    }

    fn size(&self) -> u64 {
        std::os::unix::fs::MetadataExt::size(self)
    }

    fn mtime(&self) -> i64 {
        std::os::unix::fs::MetadataExt::mtime(self)
    }

    fn mtime_nsec(&self) -> i64 {
        std::os::unix::fs::MetadataExt::mtime_nsec(self)
    }

    fn ctime(&self) -> i64 {
        std::os::unix::fs::MetadataExt::ctime(self)
    }

    fn ctime_nsec(&self) -> i64 {
        std::os::unix::fs::MetadataExt::ctime_nsec(self)
    }
}

#[cfg(unix)]
impl PermissionsExt for Permissions {
    fn from_mode(mode: u32) -> Self {
        std::os::unix::fs::PermissionsExt::from_mode(mode)
    }

    fn mode(&self) -> u32 {
        std::os::unix::fs::PermissionsExt::mode(self)
    }
}

#[cfg(unix)]
impl OpenOptionsExt for OpenOptions {
    fn mode(&mut self, mode: u32) -> &mut Self {
        std::os::unix::fs::OpenOptionsExt::mode(self, mode)
    }

    fn custom_flags(&mut self, flags: i32) -> &mut Self {
        std::os::unix::fs::OpenOptionsExt::custom_flags(self, flags)
    }
}

#[cfg(unix)]
impl DirBuilderExt for DirBuilder {
    fn mode(&mut self, mode: u32) -> &mut Self {
        std::os::unix::fs::DirBuilderExt::mode(self, mode)
    }
}

#[cfg(windows)]
impl MetadataExt for Metadata {
    fn dev(&self) -> u64 {
        u64::from(std::os::windows::fs::MetadataExt::file_attributes(self))
    }

    fn ino(&self) -> u64 {
        std::os::windows::fs::MetadataExt::creation_time(self)
            ^ std::os::windows::fs::MetadataExt::file_size(self)
    }

    fn uid(&self) -> u32 {
        1
    }

    fn gid(&self) -> u32 {
        1
    }

    fn mode(&self) -> u32 {
        if self.is_dir() {
            0o040700
        } else {
            0o100600
        }
    }

    fn nlink(&self) -> u64 {
        1
    }

    fn size(&self) -> u64 {
        std::os::windows::fs::MetadataExt::file_size(self)
    }

    fn mtime(&self) -> i64 {
        windows_file_time(std::os::windows::fs::MetadataExt::last_write_time(self)).0
    }

    fn mtime_nsec(&self) -> i64 {
        windows_file_time(std::os::windows::fs::MetadataExt::last_write_time(self)).1
    }

    fn ctime(&self) -> i64 {
        windows_file_time(std::os::windows::fs::MetadataExt::creation_time(self)).0
    }

    fn ctime_nsec(&self) -> i64 {
        windows_file_time(std::os::windows::fs::MetadataExt::creation_time(self)).1
    }
}

#[cfg(windows)]
fn windows_file_time(value: u64) -> (i64, i64) {
    const WINDOWS_TO_UNIX_SECONDS: i128 = 11_644_473_600;
    let ticks = i128::from(value);
    let seconds = ticks / 10_000_000 - WINDOWS_TO_UNIX_SECONDS;
    let nanoseconds = (ticks % 10_000_000) * 100;
    (
        i64::try_from(seconds).unwrap_or_default(),
        i64::try_from(nanoseconds).unwrap_or_default(),
    )
}

#[cfg(windows)]
impl PermissionsExt for Permissions {
    fn from_mode(_mode: u32) -> Self {
        let mut permissions = std::fs::metadata(std::env::temp_dir())
            .expect("the Windows temporary directory must expose permissions")
            .permissions();
        permissions.set_readonly(false);
        permissions
    }

    fn mode(&self) -> u32 {
        if self.readonly() {
            0o400
        } else {
            0o600
        }
    }
}

#[cfg(windows)]
impl OpenOptionsExt for OpenOptions {
    fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }

    fn custom_flags(&mut self, _flags: i32) -> &mut Self {
        let mut windows_flags = 0_u32;
        if _flags & O_DIRECTORY != 0 {
            windows_flags |= 0x0200_0000;
        }
        if _flags & O_NOFOLLOW != 0 {
            windows_flags |= 0x0020_0000;
        }
        std::os::windows::fs::OpenOptionsExt::custom_flags(self, windows_flags);
        self
    }
}

#[cfg(windows)]
impl DirBuilderExt for DirBuilder {
    fn mode(&mut self, _mode: u32) -> &mut Self {
        self
    }
}

#[cfg(unix)]
pub(crate) fn current_user_id() -> u32 {
    // SAFETY: geteuid has no parameters, does not dereference memory, and always succeeds.
    unsafe { libc::geteuid() }
}

#[cfg(windows)]
pub(crate) fn current_user_id() -> u32 {
    1
}

#[cfg(unix)]
pub(crate) use libc::{O_CLOEXEC, O_DIRECTORY, O_NOFOLLOW};

#[cfg(windows)]
pub(crate) const O_CLOEXEC: i32 = 0x01;
#[cfg(windows)]
pub(crate) const O_DIRECTORY: i32 = 0x02;
#[cfg(windows)]
pub(crate) const O_NOFOLLOW: i32 = 0x04;
