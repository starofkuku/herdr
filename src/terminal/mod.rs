mod diagnostics;
mod history_read;
mod id;
mod interactions;
mod runtime;
mod runtime_registry;
pub mod state;
mod title;

pub(crate) use diagnostics::{PaneDiagnosticReportError, MAX_PANE_DIAGNOSTICS};
pub(crate) use history_read::{merge_scrolled_up, snapshot_text, ScreenSnapshot, UpwardMerge};
pub use id::TerminalId;
pub(crate) use interactions::PaneInteractionError;
pub use runtime::TerminalRuntime;
pub(crate) use runtime_registry::TerminalRuntimeRegistry;
pub use state::{
    AgentMetadataReport, EffectivePresentation, EffectiveStateChange, TerminalState,
    TerminalStateMutation,
};
pub(crate) use title::stripped_terminal_title;
