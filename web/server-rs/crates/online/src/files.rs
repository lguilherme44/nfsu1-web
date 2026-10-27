//! The two files of the state folder (stats.json, buddies.json), written atomically: the folder made 0700 when it is
//! missing (the Online audit's ONL-13), a temporary file of 0600 (`<file>.tmp-<pid>`), then a rename; a failure
//! described in Node's words (its `e.message`: the console line quotes it, as the Node server's line did).

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// the folder (0700, with its parents), the temporary file (0600), then the rename over `file`
pub fn write_atomic(dir: &Path, file: &Path, body: &[u8]) -> Result<(), String> {
    let mut b = fs::DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        b.mode(0o700);
    }
    b.create(dir).map_err(|e| node_error(&e, "mkdir", Some(dir), None))?;
    let tmp = format!("{}.tmp-{}", file.display(), std::process::id());
    let mut o = fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    let mut f = o.open(&tmp).map_err(|e| node_error(&e, "open", Some(Path::new(&tmp)), None))?;
    f.write_all(body).map_err(|e| node_error(&e, "write", None, None))?;
    drop(f);
    fs::rename(&tmp, file).map_err(|e| node_error(&e, "rename", Some(Path::new(&tmp)), Some(file)))
}

/// libuv's name and text of an errno (uv_err_name, uv_strerror)
fn uv(errno: i32) -> Option<(&'static str, &'static str)> {
    // Linux's numbers: the server runs there
    Some(match errno {
        1 => ("EPERM", "operation not permitted"),
        2 => ("ENOENT", "no such file or directory"),
        5 => ("EIO", "i/o error"),
        9 => ("EBADF", "bad file descriptor"),
        11 => ("EAGAIN", "resource temporarily unavailable"),
        12 => ("ENOMEM", "not enough memory"),
        13 => ("EACCES", "permission denied"),
        16 => ("EBUSY", "resource busy or locked"),
        17 => ("EEXIST", "file already exists"),
        18 => ("EXDEV", "cross-device link not permitted"),
        19 => ("ENODEV", "no such device"),
        20 => ("ENOTDIR", "not a directory"),
        21 => ("EISDIR", "illegal operation on a directory"),
        22 => ("EINVAL", "invalid argument"),
        23 => ("ENFILE", "file table overflow"),
        24 => ("EMFILE", "too many open files"),
        26 => ("ETXTBSY", "text file is busy"),
        27 => ("EFBIG", "file too large"),
        28 => ("ENOSPC", "no space left on device"),
        30 => ("EROFS", "read-only file system"),
        31 => ("EMLINK", "too many links"),
        36 => ("ENAMETOOLONG", "name too long"),
        39 => ("ENOTEMPTY", "directory not empty"),
        40 => ("ELOOP", "too many symbolic links encountered"),
        _ => return None,
    })
}

/// Node's message of a failed fs call: "EACCES: permission denied, open '/x'" ("rename 'a' -> 'b'")
pub fn node_error(e: &io::Error, syscall: &str, path: Option<&Path>, dest: Option<&Path>) -> String {
    let Some((code, text)) = e.raw_os_error().filter(|_| cfg!(target_os = "linux")).and_then(uv) else {
        return e.to_string();
    };
    let mut s = format!("{code}: {text}, {syscall}");
    if let Some(p) = path {
        s.push_str(&format!(" '{}'", p.display()));
    }
    if let Some(d) = dest {
        s.push_str(&format!(" -> '{}'", d.display()));
    }
    s
}
