//! Reads the server process's own cost from Linux's own accounting.
//!
//! Everything here comes from `/proc`, so it needs no dependency and cannot
//! drift from what the kernel reports. This is a read of the process that
//! answers the request: the numbers describe the runtime the client is actually
//! talking to.
//!
//! Linux-only. Callers fall back to the counters that need no such source.

use std::time::Instant;

/// Per-process counters read from `/proc/<pid>/stat`.
struct ProcStat {
    utime_ticks: u64,
    stime_ticks: u64,
    rss_bytes: u64,
    start_ticks: u64,
}

fn clock_ticks_per_sec() -> u64 {
    // SAFETY: sysconf with a valid name is thread-safe and has no side effects.
    let value = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if value > 0 {
        value as u64
    } else {
        100
    }
}

fn page_size() -> u64 {
    // SAFETY: see `clock_ticks_per_sec`.
    let value = unsafe { libc::sysconf(libc::_SC_PAGESIZE) };
    if value > 0 {
        value as u64
    } else {
        4096
    }
}

/// Parses `/proc/<pid>/stat`.
///
/// Field positions are from `proc(5)`; index 0 below is field 3 (`state`),
/// because fields 1 and 2 are the pid and the command, and the command can
/// contain spaces and parentheses. Splitting after the last `)` is what makes
/// that safe.
fn parse_stat(raw: &str) -> Option<ProcStat> {
    let close = raw.rfind(')')?;
    let rest: Vec<&str> = raw[close + 1..].split_whitespace().collect();
    Some(ProcStat {
        utime_ticks: rest.get(11)?.parse().ok()?,
        stime_ticks: rest.get(12)?.parse().ok()?,
        start_ticks: rest.get(19)?.parse().ok()?,
        rss_bytes: rest.get(21)?.parse::<u64>().ok()? * page_size(),
    })
}

fn system_uptime_sec() -> Option<f64> {
    let raw = std::fs::read_to_string("/proc/uptime").ok()?;
    raw.split_whitespace().next()?.parse().ok()
}

fn thread_count(pid: u32) -> Option<u64> {
    let raw = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    let line = raw.lines().find(|line| line.starts_with("Threads:"))?;
    line.split_whitespace().nth(1)?.parse().ok()
}

fn open_fd_count(pid: u32) -> Option<u64> {
    let entries = std::fs::read_dir(format!("/proc/{pid}/fd")).ok()?;
    Some(entries.filter_map(Result::ok).count() as u64)
}

/// Counts `SOCK_STREAM` entries whose path matches, as `/proc/net/unix` lists
/// them.
///
/// The kernel's table is the cheapest source and needs no scanning of other
/// processes, which matters because this runs on the request path.
pub(super) fn unix_socket_count(path: &std::path::Path) -> Option<u64> {
    let needle = path.to_str()?;
    let raw = std::fs::read_to_string("/proc/net/unix").ok()?;
    Some(
        raw.lines()
            .filter(|line| line.split_whitespace().nth(7) == Some(needle))
            .count() as u64,
    )
}

/// CPU sampling state, held across calls so a rate can be reported.
#[derive(Default)]
pub(super) struct CpuSampler {
    previous: Option<(Instant, u64)>,
}

impl CpuSampler {
    /// Returns CPU used since the previous call, as a percentage of one core.
    ///
    /// `None` on the first call: a rate needs two readings, and reporting zero
    /// would read as an idle server.
    fn sample(&mut self, stat: &ProcStat) -> Option<f64> {
        let ticks = stat.utime_ticks + stat.stime_ticks;
        let now = Instant::now();
        let previous = self.previous.replace((now, ticks))?;
        let elapsed = now.duration_since(previous.0).as_secs_f64();
        if elapsed <= 0.0 {
            return None;
        }
        let consumed = ticks.saturating_sub(previous.1) as f64 / clock_ticks_per_sec() as f64;
        Some(consumed / elapsed * 100.0)
    }
}

/// The process-level readings, or `None` when `/proc` cannot be read.
pub(super) struct ProcessReading {
    pub uptime_sec: u64,
    pub rss_bytes: u64,
    pub threads: u64,
    pub open_fds: u64,
}

impl ProcessReading {
    pub(super) fn read(pid: u32, sampler: &mut CpuSampler) -> Option<(Self, Option<f64>)> {
        let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let stat = parse_stat(&raw)?;
        let cpu_percent = sampler.sample(&stat);
        let uptime_sec = system_uptime_sec()
            .map(|uptime| {
                let started = stat.start_ticks as f64 / clock_ticks_per_sec() as f64;
                (uptime - started).max(0.0) as u64
            })
            .unwrap_or(0);
        Some((
            Self {
                uptime_sec,
                rss_bytes: stat.rss_bytes,
                threads: thread_count(pid).unwrap_or(0),
                open_fds: open_fd_count(pid).unwrap_or(0),
            },
            cpu_percent,
        ))
    }
}
