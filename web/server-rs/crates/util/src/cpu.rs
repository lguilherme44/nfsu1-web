//! How busy the server is, 0 to 1.  Node read its one thread's event-loop use.  Here the switch's work is spread over
//! the runtime's worker threads, which are only some of the cores (half of them, 2 to 8), so the measure that says
//! whether the switch keeps up is theirs: [`WorkersBusy`], the share of the workers' time they spent running tasks.
//! [`Busy`], the process's CPU time over a number of cores, is for a hub with no runtime (the tests).

use std::time::{Duration, Instant};

/// CPU seconds (user + system) the process has used.
pub fn process_cpu_seconds() -> f64 {
    // SAFETY: getrusage only writes the struct it is given
    unsafe {
        let mut u: libc::rusage = std::mem::zeroed();
        if libc::getrusage(libc::RUSAGE_SELF, &mut u) != 0 {
            return 0.0;
        }
        let tv = |t: libc::timeval| t.tv_sec as f64 + t.tv_usec as f64 / 1e6;
        tv(u.ru_utime) + tv(u.ru_stime)
    }
}

/// Resident memory in bytes (Linux: /proc/self/statm), 0 where it cannot be read.
pub fn resident_bytes() -> u64 {
    let Ok(s) = std::fs::read_to_string("/proc/self/statm") else { return 0 };
    let pages: u64 = s.split_whitespace().nth(1).and_then(|x| x.parse().ok()).unwrap_or(0);
    // SAFETY: sysconf has no preconditions
    let page = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    pages * if page > 0 { page as u64 } else { 4096 }
}

/// The share of `threads` cores the process used between one `sample()` and the next.
pub struct Busy {
    threads: f64,
    cpu: f64,
    at: Instant,
}

impl Busy {
    pub fn new(threads: usize) -> Self {
        Busy { threads: threads.max(1) as f64, cpu: process_cpu_seconds(), at: Instant::now() }
    }
    /// 0 to 1 since the last call
    pub fn sample(&mut self) -> f64 {
        let cpu = process_cpu_seconds();
        let now = Instant::now();
        let wall = now.duration_since(self.at).as_secs_f64();
        let used = cpu - self.cpu;
        self.cpu = cpu;
        self.at = now;
        if wall <= 0.0 {
            return 0.0;
        }
        (used / (wall * self.threads)).clamp(0.0, 1.0)
    }
}

/// The share of a tokio runtime's worker threads' time they spent running tasks between one `sample()` and the next
/// (tokio's busy duration: a worker that waits for work, or looks for some to steal, is idle), the event-loop use of
/// the workers together.  Wall time, not CPU time: a worker the OS does not run while it has tasks is not keeping up
/// either.  The CPU time of the whole process over every core could not tell: workers that are all busy are half
/// of it at most, and the cap on the links never came down.
pub struct WorkersBusy {
    metrics: tokio::runtime::RuntimeMetrics,
    busy: Duration,
    at: Instant,
}

impl WorkersBusy {
    pub fn new(rt: &tokio::runtime::Handle) -> Self {
        let metrics = rt.metrics();
        let busy = Self::total(&metrics);
        WorkersBusy { metrics, busy, at: Instant::now() }
    }

    fn total(m: &tokio::runtime::RuntimeMetrics) -> Duration {
        (0..m.num_workers()).map(|w| m.worker_total_busy_duration(w)).sum()
    }

    /// 0 to 1 since the last call
    pub fn sample(&mut self) -> f64 {
        let busy = Self::total(&self.metrics);
        let now = Instant::now();
        let wall = now.duration_since(self.at).as_secs_f64() * self.metrics.num_workers().max(1) as f64;
        let used = busy.saturating_sub(self.busy).as_secs_f64();
        self.busy = busy;
        self.at = now;
        if wall <= 0.0 {
            return 0.0;
        }
        (used / wall).clamp(0.0, 1.0)
    }
}

/// This thread runs at a lower priority (Linux: a nice value of its own, `by` above the one it had, 19 at most;
/// elsewhere nothing): background work that must never keep the switch's workers off a core, such as compressing the
/// game data's runs.  From where it is, not a fixed value: in a server started under `nice` a fixed 10 was refused
/// (going back down needs privileges) and left the thread as high as the workers, or with privileges put it above
/// them.  False when it could not.
pub fn lower_this_thread(by: i32) -> bool {
    #[cfg(target_os = "linux")]
    {
        // SAFETY: gettid, getpriority and setpriority take and return plain integers, and errno is this thread's own;
        // a thread may lower its own priority
        unsafe {
            let tid = libc::syscall(libc::SYS_gettid) as libc::id_t;
            // (-1 is a nice value too: an error is told by errno)
            *libc::__errno_location() = 0;
            let now = libc::getpriority(libc::PRIO_PROCESS, tid);
            if now == -1 && *libc::__errno_location() != 0 {
                return false;
            }
            libc::setpriority(libc::PRIO_PROCESS, tid, (now + by.max(0)).min(19)) == 0
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = by;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // all the workers busy is busy, however many cores the machine has; idle workers are idle
    #[test]
    fn workers_busy_is_the_workers_share() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("a runtime");
        let mut b = WorkersBusy::new(rt.handle());
        std::thread::sleep(Duration::from_millis(200));
        let idle = b.sample();
        assert!(idle < 0.2, "idle workers: {idle}");
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        for _ in 0..2 {
            let stop = stop.clone();
            rt.spawn(async move {
                while !stop.load(std::sync::atomic::Ordering::Relaxed) {
                    let t = Instant::now();
                    while t.elapsed() < Duration::from_millis(1) {
                        std::hint::spin_loop();
                    }
                    tokio::task::yield_now().await;
                }
            });
        }
        std::thread::sleep(Duration::from_millis(300));
        b.sample();
        std::thread::sleep(Duration::from_millis(300));
        let busy = b.sample();
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
        assert!(busy > 0.85, "two busy workers: {busy}");
    }

    /// this thread's nice value
    #[cfg(target_os = "linux")]
    fn nice() -> i32 {
        // SAFETY: as in lower_this_thread
        unsafe {
            *libc::__errno_location() = 0;
            let n = libc::getpriority(libc::PRIO_PROCESS, libc::syscall(libc::SYS_gettid) as libc::id_t);
            assert!(n != -1 || *libc::__errno_location() == 0, "getpriority");
            n
        }
    }

    // (the port's own) A thread is lowered from where it is: below the threads it was made from, also in a server
    // started under `nice` (a nice value of 10 for it was refused without privileges there, the pool ran as high as
    // the switch's workers, and with them it was put above them)
    #[cfg(target_os = "linux")]
    #[test]
    fn a_thread_is_lowered_from_where_it_is() {
        std::thread::spawn(|| {
            let was = nice();
            assert!(lower_this_thread(4));
            assert_eq!(nice(), (was + 4).min(19), "4 lower than it was");
        })
        .join()
        .unwrap();
        std::thread::spawn(|| {
            // a process at nice 12, say
            let was = nice().max(12);
            // SAFETY: as in lower_this_thread (a higher nice value needs no privilege)
            assert_eq!(unsafe { libc::setpriority(libc::PRIO_PROCESS, libc::syscall(libc::SYS_gettid) as libc::id_t, was) }, 0);
            assert!(lower_this_thread(10));
            assert_eq!(nice(), 19, "lower than the process's {was}, as low as it goes");
        })
        .join()
        .unwrap();
    }
}
