//! Prompts sent to a pane at a wall-clock time.
//!
//! The unit is one prompt, one pane, one time. The case it exists for is quota:
//! an agent on a metered plan learns the plan resets at, say, 18:27 only by
//! hitting the limit, so the useful thing to schedule is "at that time, send
//! this text to that pane" and nothing more. Firing sends the bytes the same
//! way a typed message goes in; whether the agent acts on them is the agent's
//! business. A time that passed without the prompt being sent is recorded as
//! missed and never retried — the moment was the point.

use std::sync::atomic::{AtomicU64, Ordering};

use chrono::{DateTime, Local, LocalResult, NaiveDateTime, NaiveTime, TimeZone};

use crate::api::schema::PromptScheduleStatus;
use crate::layout::PaneId;

/// A prompt, a pane, and the time to bring them together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PromptSchedule {
    pub id: String,
    /// The pane by its own id, which is what firing looks it up by.
    pub pane_id: PaneId,
    /// The pane's public id when the schedule was made — for reading only: the
    /// public name is derived from layout, so a pane that moved would make a
    /// stored name stale while the pane itself is still findable.
    pub pane_label: String,
    pub agent: Option<String>,
    pub due: DateTime<Local>,
    pub message: String,
    pub status: PromptScheduleStatus,
}

impl PromptSchedule {
    pub(crate) fn info(&self) -> crate::api::schema::PromptScheduleInfo {
        crate::api::schema::PromptScheduleInfo {
            id: self.id.clone(),
            pane_id: self.pane_label.clone(),
            agent: self.agent.clone(),
            due: self.due.format("%Y-%m-%d %H:%M:%S").to_string(),
            message: self.message.clone(),
            status: self.status,
        }
    }
}

/// Fresh ids without a generator: the timestamp rules out collisions across
/// restarts, the counter rules out two schedules made in the same second.
static SCHEDULE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub(crate) fn new_schedule_id() -> String {
    let stamp = Local::now().timestamp().max(0) as u64;
    let seq = SCHEDULE_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("sch-{stamp:x}-{seq:x}")
}

/// Reads a due time in local time: a full date with either separator, or a
/// clock time for the next occurrence — today, or tomorrow once it has passed,
/// because "at 08:00" said at 08:05 means tomorrow.
pub(crate) fn parse_due(at: &str) -> Option<DateTime<Local>> {
    let at = at.trim();
    let naive = NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M"))
        .or_else(|_| NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M:%S"))
        .or_else(|_| NaiveDateTime::parse_from_str(at, "%Y-%m-%dT%H:%M"))
        .ok();
    if let Some(naive) = naive {
        return single_local(naive);
    }
    let time = NaiveTime::parse_from_str(at, "%H:%M:%S")
        .or_else(|_| NaiveTime::parse_from_str(at, "%H:%M"))
        .ok()?;
    let today = Local::now().date_naive();
    let candidate = today.and_time(time);
    let candidate = if candidate > Local::now().naive_local() {
        candidate
    } else {
        // Already passed today, so the words mean the next one.
        match today.succ_opt() {
            Some(tomorrow) => tomorrow.and_time(time),
            None => return None,
        }
    };
    single_local(candidate)
}

fn single_local(naive: chrono::NaiveDateTime) -> Option<DateTime<Local>> {
    match Local.from_local_datetime(&naive) {
        LocalResult::Single(at) => Some(at),
        // A time that does not exist locally (a skipped hour) or exists twice
        // (a repeated hour) is not the reader's intent; naming it exactly is
        // how they get what they meant.
        _ => None,
    }
}

/// Restores a schedule from persisted fields, marking one whose time passed
/// while it was away as missed rather than inventing a new time for it.
pub(crate) fn from_snapshot(
    snapshot: &crate::persist::PromptScheduleSnapshot,
) -> Option<PromptSchedule> {
    let status = match snapshot.status.as_str() {
        "pending" => PromptScheduleStatus::Pending,
        "fired" => PromptScheduleStatus::Fired,
        "missed" => PromptScheduleStatus::Missed,
        "cancelled" => PromptScheduleStatus::Cancelled,
        _ => return None,
    };
    let due = match Local.timestamp_opt(snapshot.due_unix, 0) {
        LocalResult::Single(due) => due,
        _ => return None,
    };
    let status = if status == PromptScheduleStatus::Pending && due <= Local::now() {
        PromptScheduleStatus::Missed
    } else {
        status
    };
    Some(PromptSchedule {
        id: snapshot.id.clone(),
        pane_id: PaneId::from_raw(snapshot.pane_id),
        pane_label: snapshot.pane_label.clone(),
        agent: snapshot.agent.clone(),
        due,
        message: snapshot.message.clone(),
        status,
    })
}

fn status_name(status: PromptScheduleStatus) -> &'static str {
    match status {
        PromptScheduleStatus::Pending => "pending",
        PromptScheduleStatus::Fired => "fired",
        PromptScheduleStatus::Missed => "missed",
        PromptScheduleStatus::Cancelled => "cancelled",
    }
}

pub(crate) fn to_snapshot(schedule: &PromptSchedule) -> crate::persist::PromptScheduleSnapshot {
    crate::persist::PromptScheduleSnapshot {
        id: schedule.id.clone(),
        pane_id: schedule.pane_id.raw(),
        pane_label: schedule.pane_label.clone(),
        agent: schedule.agent.clone(),
        due_unix: schedule.due.timestamp(),
        message: schedule.message.clone(),
        status: status_name(schedule.status).to_owned(),
    }
}
