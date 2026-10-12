//! `schedule.*` handlers: make, show, and take back a scheduled prompt.

use super::responses::{encode_error, encode_success};
use super::App;
use crate::api::schema::{
    PromptScheduleInfo, PromptScheduleStatus, ResponseResult, ScheduleCancelParams,
    ScheduleCreateParams,
};

impl App {
    pub(super) fn handle_schedule_create(
        &mut self,
        id: String,
        params: ScheduleCreateParams,
    ) -> String {
        let Some((ws_idx, pane_id)) = self.parse_pane_id(&params.pane_id) else {
            return encode_error(id, "pane_not_found", "pane not found");
        };
        let Some(due) = crate::prompt_schedule::parse_due(&params.at) else {
            return encode_error(
                id,
                "invalid_time",
                "at must be a local time: YYYY-MM-DD HH:MM[:SS] or HH:MM[:SS]",
            );
        };
        if params.message.trim().is_empty() {
            return encode_error(id, "empty_message", "message must not be empty");
        }
        // Kept for reading: the list says which agent a schedule talks to, and
        // the pane's own presentation is the honest source for that label.
        let agent = self
            .pane_info(ws_idx, pane_id)
            .and_then(|pane| pane.agent.clone());
        let schedule = crate::prompt_schedule::PromptSchedule {
            id: crate::prompt_schedule::new_schedule_id(),
            pane_id,
            pane_label: params.pane_id,
            agent,
            due,
            message: params.message,
            status: PromptScheduleStatus::Pending,
        };
        let info = schedule.info();
        self.state.prompt_schedules.push(schedule);
        self.schedule_session_save();
        self.sync_prompt_schedule_deadline();
        encode_success(id, ResponseResult::ScheduleCreated { schedule: info })
    }

    pub(super) fn handle_schedule_list(&mut self, id: String) -> String {
        let mut schedules: Vec<PromptScheduleInfo> = self
            .state
            .prompt_schedules
            .iter()
            .map(|schedule| schedule.info())
            .collect();
        // Soonest first, and pending ahead of the record: the top of the list
        // is the question "what happens next", not a filing cabinet.
        schedules.sort_by(|a, b| {
            (a.status != PromptScheduleStatus::Pending)
                .cmp(&(b.status != PromptScheduleStatus::Pending))
                .then_with(|| a.due.cmp(&b.due))
        });
        encode_success(id, ResponseResult::ScheduleList { schedules })
    }

    pub(super) fn handle_schedule_cancel(
        &mut self,
        id: String,
        params: ScheduleCancelParams,
    ) -> String {
        let Some(schedule) = self
            .state
            .prompt_schedules
            .iter_mut()
            .find(|schedule| schedule.id == params.schedule_id)
        else {
            return encode_error(id, "schedule_not_found", "schedule not found");
        };
        if schedule.status != PromptScheduleStatus::Pending {
            return encode_error(
                id,
                "schedule_not_pending",
                "only a pending schedule can be cancelled",
            );
        }
        schedule.status = PromptScheduleStatus::Cancelled;
        let info = schedule.info();
        self.schedule_session_save();
        self.sync_prompt_schedule_deadline();
        encode_success(id, ResponseResult::ScheduleCancelled { schedule: info })
    }
}

impl App {
    /// Points the loop's wake-up at the nearest pending schedule.
    ///
    /// Wall clock turned into a monotonic deadline: the loop sleeps in
    /// `Instant`s, so a clock change between now and then simply re-syncs on the
    /// next pass through the scheduled-task tick.
    pub(crate) fn sync_prompt_schedule_deadline(&mut self) {
        let now = chrono::Local::now();
        self.prompt_schedule_deadline = self
            .state
            .prompt_schedules
            .iter()
            .filter(|schedule| schedule.status == PromptScheduleStatus::Pending)
            .map(|schedule| schedule.due.signed_duration_since(now))
            .filter_map(|until| until.to_std().ok())
            .min()
            .map(|until| std::time::Instant::now() + until);
    }

    /// Sends every pending schedule whose time has come.
    pub(crate) fn fire_due_prompt_schedules(&mut self) {
        let now = chrono::Local::now();
        // Collected first, sent after: sending borrows the runtimes through the
        // same state the loop below writes to, and the two cannot overlap.
        let due: Vec<(usize, crate::layout::PaneId, String)> = self
            .state
            .prompt_schedules
            .iter()
            .enumerate()
            .filter_map(|(index, schedule)| {
                (schedule.status == PromptScheduleStatus::Pending && schedule.due <= now)
                    .then_some((index, schedule.pane_id, schedule.message.clone()))
            })
            .collect();
        let mut fired = false;
        for (index, pane, message) in due {
            // A pane that is gone is not a retry away from coming back: the
            // moment was the point, so it is recorded as missed.
            let sent = self.send_to_pane(pane, message.as_str()).is_ok();
            if let Some(schedule) = self.state.prompt_schedules.get_mut(index) {
                schedule.status = if sent {
                    PromptScheduleStatus::Fired
                } else {
                    PromptScheduleStatus::Missed
                };
            }
            fired = true;
        }
        if fired {
            // Marked rather than scheduled directly: the save itself is the
            // session's business, and the loop's next pass picks the flag up.
            self.state.mark_session_dirty();
        }
        self.sync_prompt_schedule_deadline();
    }

    /// Writes the message as a submitted prompt.
    ///
    /// The Enter matters: to a TUI agent, text without it is a half-typed line
    /// sitting in the composer, which is not a prompt that was sent at a time.
    /// It goes through the same encoding the composer's own send uses.
    fn send_to_pane(&self, pane: crate::layout::PaneId, message: &str) -> Result<(), String> {
        for ws_idx in 0..self.state.workspaces.len() {
            let Some(runtime) =
                self.state
                    .runtime_for_pane_in_workspace(&self.terminal_runtimes, ws_idx, pane)
            else {
                continue;
            };
            let keys = ["Enter".to_owned()];
            let bytes = crate::app::api_helpers::encode_api_input(runtime, message, &keys)?;
            return runtime
                .try_send_bytes(bytes::Bytes::from(bytes))
                .map_err(|err| err.to_string());
        }
        Err("pane not found".to_owned())
    }
}
