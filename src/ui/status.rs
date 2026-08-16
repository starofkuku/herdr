use ratatui::{
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Clear, Paragraph},
    Frame,
};

use super::text::{display_width_u16, truncate_end};
use super::widgets::panel_contrast_fg;
use crate::{
    api::schema::{PaneDiagnosticInfo, PaneDiagnosticSeverity},
    app::state::{CopyFeedback, Palette, ToastKind, ToastNotification},
    config::{ToastClipboardPosition, ToastHerdrPosition},
    detect::AgentState,
};

const DIAGNOSTIC_CARD_WIDTH: u16 = 52;
const DIAGNOSTIC_CARD_HEIGHT: u16 = 10;

pub(crate) fn diagnostic_card_geometry(
    area: Rect,
    top_offset: u16,
    toast_rect: Option<Rect>,
) -> (Rect, Rect) {
    if area.width == 0 || area.height == 0 {
        return (Rect::default(), Rect::default());
    }
    let width = DIAGNOSTIC_CARD_WIDTH.min(area.width);
    let height = DIAGNOSTIC_CARD_HEIGHT.min(area.height);
    let x = area.x + area.width.saturating_sub(width);
    let mut y = area.y + top_offset.min(area.height.saturating_sub(height));
    let mut card = Rect::new(x, y, width, height);
    if toast_rect.is_some_and(|toast| rects_overlap(card, toast)) {
        y = toast_rect
            .map(|toast| toast.y.saturating_add(toast.height))
            .unwrap_or(y)
            .min(area.y + area.height.saturating_sub(height));
        card.y = y;
    }
    let close = if width >= 5 && height >= 3 {
        Rect::new(
            card.x + card.width.saturating_sub(4),
            card.y.saturating_add(1),
            3,
            1,
        )
    } else {
        Rect::default()
    };
    (card, close)
}

pub(super) fn render_diagnostic_card(
    frame: &mut Frame,
    area: Rect,
    close_area: Rect,
    diagnostic: &PaneDiagnosticInfo,
    p: &Palette,
) {
    if area.is_empty() {
        return;
    }
    frame.render_widget(Clear, area);
    let border = match diagnostic.severity {
        PaneDiagnosticSeverity::Info => p.blue,
        PaneDiagnosticSeverity::Warning => p.yellow,
        PaneDiagnosticSeverity::Error => p.red,
    };
    let title_width = area.width.saturating_sub(4) as usize;
    let block = Block::default()
        .title(format!(
            " {} ",
            truncate_end(&diagnostic.title, title_width)
        ))
        .borders(Borders::ALL)
        .border_style(Style::default().fg(border))
        .style(Style::default().bg(p.panel_bg));
    let inner = block.inner(area);
    frame.render_widget(block, area);
    if inner.is_empty() {
        return;
    }

    let content_width = inner.width as usize;
    let state_width = content_width.saturating_sub(5);
    let state = Line::from(vec![
        Span::styled("o ", Style::default().fg(border)),
        Span::styled(
            truncate_end(&diagnostic.state, state_width.saturating_sub(2)),
            Style::default().fg(p.text).add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(
        Paragraph::new(state),
        Rect::new(inner.x, inner.y, inner.width, 1),
    );
    if !close_area.is_empty() {
        frame.render_widget(
            Paragraph::new("[x]").style(Style::default().fg(p.overlay1)),
            close_area,
        );
    }

    let mut row = inner.y.saturating_add(1);
    let bottom = inner.y.saturating_add(inner.height);
    if row < bottom {
        frame.render_widget(
            Paragraph::new(truncate_end(&diagnostic.summary, content_width))
                .style(Style::default().fg(p.subtext0)),
            Rect::new(inner.x, row, inner.width, 1),
        );
        row = row.saturating_add(2);
    }
    for field in &diagnostic.fields {
        if row >= bottom {
            break;
        }
        let label = format!("{}: ", field.label);
        let label_width = display_width_u16(&label).min(inner.width);
        let value_width = inner.width.saturating_sub(label_width) as usize;
        let line = Line::from(vec![
            Span::styled(label, Style::default().fg(p.overlay1)),
            Span::styled(
                truncate_end(&field.value, value_width),
                Style::default().fg(p.text),
            ),
        ]);
        frame.render_widget(
            Paragraph::new(line),
            Rect::new(inner.x, row, inner.width, 1),
        );
        row = row.saturating_add(1);
    }
}

fn rects_overlap(a: Rect, b: Rect) -> bool {
    a.x < b.x.saturating_add(b.width)
        && b.x < a.x.saturating_add(a.width)
        && a.y < b.y.saturating_add(b.height)
        && b.y < a.y.saturating_add(a.height)
}

pub(crate) fn copy_feedback_rect(
    area: Rect,
    feedback: &CopyFeedback,
    offset_rows: u16,
    position: ToastClipboardPosition,
) -> Rect {
    if area.width == 0 || area.height == 0 {
        return Rect::default();
    }

    let content_width = feedback.message.len() as u16 + 4;
    let width = content_width.min(area.width);
    let height = 3u16.min(area.height);
    let x = match position {
        ToastClipboardPosition::TopLeft | ToastClipboardPosition::BottomLeft => area.x,
        ToastClipboardPosition::TopCenter | ToastClipboardPosition::BottomCenter => {
            area.x + area.width.saturating_sub(width) / 2
        }
        ToastClipboardPosition::TopRight | ToastClipboardPosition::BottomRight => {
            area.x + area.width.saturating_sub(width)
        }
    };
    let y = match position {
        ToastClipboardPosition::TopLeft
        | ToastClipboardPosition::TopCenter
        | ToastClipboardPosition::TopRight => area.y + offset_rows.min(area.height),
        ToastClipboardPosition::BottomLeft
        | ToastClipboardPosition::BottomCenter
        | ToastClipboardPosition::BottomRight => {
            area.y + area.height.saturating_sub(height + offset_rows)
        }
    };
    Rect::new(x, y, width, height)
}

pub(crate) fn toast_notification_rect(
    area: Rect,
    toast: &ToastNotification,
    offset_for_warning: bool,
    position: ToastHerdrPosition,
) -> Rect {
    let content_width = display_width_u16(&toast.title)
        .max(display_width_u16(&toast.context))
        .saturating_add(4);
    let width = content_width.saturating_add(2).min(area.width);
    let content_height = if toast.context.is_empty() { 1 } else { 2 };
    let height = (content_height + 2).min(area.height);
    let x = match position {
        ToastHerdrPosition::TopLeft | ToastHerdrPosition::BottomLeft => area.x,
        ToastHerdrPosition::TopRight | ToastHerdrPosition::BottomRight => {
            area.x + area.width.saturating_sub(width)
        }
    };
    let warning_offset = u16::from(offset_for_warning);
    let y = match position {
        ToastHerdrPosition::TopLeft | ToastHerdrPosition::TopRight => {
            area.y + warning_offset.min(area.height)
        }
        ToastHerdrPosition::BottomLeft | ToastHerdrPosition::BottomRight => {
            area.y + area.height.saturating_sub(height + warning_offset)
        }
    };
    Rect::new(x, y, width, height)
}

pub(super) fn render_toast_notification(
    frame: &mut Frame,
    area: Rect,
    toast: &ToastNotification,
    offset_for_warning: bool,
    position: ToastHerdrPosition,
    p: &Palette,
) {
    let dot_color = match toast.kind {
        ToastKind::NeedsAttention => p.red,
        ToastKind::Finished => p.blue,
        ToastKind::UpdateInstalled => p.accent,
    };
    let toast_area = toast_notification_rect(area, toast, offset_for_warning, position);

    frame.render_widget(Clear, toast_area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(p.overlay0))
        .style(Style::default().bg(p.panel_bg));
    let inner = block.inner(toast_area);
    frame.render_widget(block, toast_area);

    if inner.height < 1 {
        return;
    }

    let [title_row, context_row] =
        Layout::vertical([Constraint::Length(1), Constraint::Length(1)]).areas(inner);

    let title = Line::from(vec![
        Span::styled("●", Style::default().fg(dot_color)),
        Span::raw(" "),
        Span::styled(
            &toast.title,
            Style::default().fg(p.text).add_modifier(Modifier::BOLD),
        ),
    ]);
    let context = Line::from(vec![
        Span::styled("  ", Style::default().fg(p.overlay0)),
        Span::styled(&toast.context, Style::default().fg(p.overlay0)),
    ]);

    frame.render_widget(Paragraph::new(title), title_row);
    if !toast.context.is_empty() && inner.height >= 2 {
        frame.render_widget(Paragraph::new(context), context_row);
    }
}

pub(super) fn render_copy_feedback(
    frame: &mut Frame,
    area: Rect,
    feedback: &CopyFeedback,
    offset_rows: u16,
    position: ToastClipboardPosition,
    p: &Palette,
) {
    let feedback_area = copy_feedback_rect(area, feedback, offset_rows, position);
    if feedback_area.is_empty() {
        return;
    }

    frame.render_widget(Clear, feedback_area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(p.green))
        .style(Style::default().bg(p.panel_bg));
    let inner = block.inner(feedback_area);
    frame.render_widget(block, feedback_area);

    if inner.height == 0 {
        return;
    }

    let text = Line::from(vec![
        Span::styled("●", Style::default().fg(p.green).bg(p.panel_bg)),
        Span::raw(" "),
        Span::styled(
            &feedback.message,
            Style::default()
                .fg(p.text)
                .bg(p.panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
    ]);
    frame.render_widget(Paragraph::new(text), inner);
}

pub(super) fn render_config_diagnostic(frame: &mut Frame, area: Rect, message: &str, p: &Palette) {
    let style = Style::default()
        .fg(panel_contrast_fg(p))
        .bg(p.yellow)
        .add_modifier(Modifier::BOLD);

    for (row, line) in message
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(area.height as usize)
        .enumerate()
    {
        let text = format!(" {line} ");
        let width = (text.len() as u16).min(area.width);
        let notif_area = Rect::new(
            area.x + area.width.saturating_sub(width),
            area.y + row as u16,
            width,
            1,
        );

        frame.render_widget(Clear, notif_area);
        frame.render_widget(Paragraph::new(Span::styled(text, style)), notif_area);
    }
}

pub(super) fn state_dot(state: AgentState, seen: bool, p: &Palette) -> (&'static str, Style) {
    match (state, seen) {
        (AgentState::Blocked, _) => ("●", Style::default().fg(p.red)),
        (AgentState::Working, _) => ("●", Style::default().fg(p.yellow)),
        (AgentState::Idle, false) => ("●", Style::default().fg(p.teal)),
        (AgentState::Idle, true) => ("○", Style::default().fg(p.green)),
        (AgentState::Unknown, _) => ("·", Style::default().fg(p.overlay0)),
    }
}

pub(super) fn agent_icon(
    state: AgentState,
    seen: bool,
    tick: u32,
    p: &Palette,
) -> (&'static str, Style) {
    match (state, seen) {
        (AgentState::Blocked, _) => ("◉", Style::default().fg(p.red)),
        (AgentState::Working, _) => (super::spinner_frame(tick), Style::default().fg(p.yellow)),
        (AgentState::Idle, false) => ("●", Style::default().fg(p.teal)),
        (AgentState::Idle, true) => ("✓", Style::default().fg(p.green)),
        (AgentState::Unknown, _) => ("○", Style::default().fg(p.overlay0)),
    }
}

pub(super) fn state_label(state: AgentState, seen: bool) -> &'static str {
    match (state, seen) {
        (AgentState::Blocked, _) => "blocked",
        (AgentState::Working, _) => "working",
        (AgentState::Idle, false) => "done",
        (AgentState::Idle, true) => "idle",
        (AgentState::Unknown, _) => "idle",
    }
}

pub(super) fn state_label_color(state: AgentState, seen: bool, p: &Palette) -> Color {
    match (state, seen) {
        (AgentState::Blocked, _) => p.red,
        (AgentState::Working, _) => p.yellow,
        (AgentState::Idle, false) => p.teal,
        (AgentState::Idle, true) => p.green,
        (AgentState::Unknown, _) => p.overlay0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{ToastClipboardPosition, ToastHerdrPosition};

    fn toast() -> ToastNotification {
        ToastNotification {
            kind: ToastKind::Finished,
            title: "done".to_string(),
            context: "workspace".to_string(),
            position: None,
            target: None,
        }
    }

    fn feedback() -> CopyFeedback {
        CopyFeedback {
            message: "copied to clipboard".to_string(),
        }
    }

    #[test]
    fn toast_rect_uses_configured_corner() {
        let area = Rect::new(10, 20, 100, 40);
        let toast = toast();

        let top_left = toast_notification_rect(area, &toast, false, ToastHerdrPosition::TopLeft);
        assert_eq!(top_left.x, area.x);
        assert_eq!(top_left.y, area.y);

        let top_right = toast_notification_rect(area, &toast, false, ToastHerdrPosition::TopRight);
        assert_eq!(top_right.x + top_right.width, area.x + area.width);
        assert_eq!(top_right.y, area.y);

        let bottom_left =
            toast_notification_rect(area, &toast, false, ToastHerdrPosition::BottomLeft);
        assert_eq!(bottom_left.x, area.x);
        assert_eq!(bottom_left.y + bottom_left.height, area.y + area.height);

        let bottom_right =
            toast_notification_rect(area, &toast, false, ToastHerdrPosition::BottomRight);
        assert_eq!(bottom_right.x + bottom_right.width, area.x + area.width);
        assert_eq!(bottom_right.y + bottom_right.height, area.y + area.height);
    }

    #[test]
    fn toast_rect_uses_display_width_for_cjk_labels() {
        let area = Rect::new(0, 0, 100, 20);
        let toast = ToastNotification {
            kind: ToastKind::NeedsAttention,
            title: "重构用户认证模块".to_string(),
            context: "提交 herdr 的反馈".to_string(),
            position: None,
            target: None,
        };

        let rect = toast_notification_rect(area, &toast, false, ToastHerdrPosition::TopRight);

        let expected_content_width =
            display_width_u16(&toast.title).max(display_width_u16(&toast.context)) + 6;
        assert_eq!(rect.width, expected_content_width);
        assert_eq!(rect.x + rect.width, area.x + area.width);
    }

    #[test]
    fn copy_feedback_rect_uses_configured_position() {
        let area = Rect::new(10, 20, 100, 40);
        let feedback = feedback();

        let top_center = copy_feedback_rect(area, &feedback, 0, ToastClipboardPosition::TopCenter);
        assert_eq!(top_center.y, area.y);
        assert_eq!(
            top_center.x,
            area.x + area.width.saturating_sub(top_center.width) / 2
        );

        let bottom_center =
            copy_feedback_rect(area, &feedback, 0, ToastClipboardPosition::BottomCenter);
        assert_eq!(bottom_center.y + bottom_center.height, area.y + area.height);
        assert_eq!(
            bottom_center.x,
            area.x + area.width.saturating_sub(bottom_center.width) / 2
        );
    }

    #[test]
    fn diagnostic_card_uses_top_right_and_stacks_below_toast() {
        let area = Rect::new(10, 20, 100, 40);
        let (card, close) = diagnostic_card_geometry(area, 0, None);
        assert_eq!(card.width, DIAGNOSTIC_CARD_WIDTH);
        assert_eq!(card.height, DIAGNOSTIC_CARD_HEIGHT);
        assert_eq!(card.x + card.width, area.x + area.width);
        assert_eq!(card.y, area.y);
        assert!(rects_overlap(card, close));

        let toast = Rect::new(card.x, card.y, card.width, 3);
        let (stacked, _) = diagnostic_card_geometry(area, 0, Some(toast));
        assert_eq!(stacked.y, toast.y + toast.height);
        assert!(!rects_overlap(stacked, toast));
    }

    #[test]
    fn diagnostic_card_geometry_clamps_to_small_viewports() {
        let area = Rect::new(2, 3, 18, 6);
        let (card, close) = diagnostic_card_geometry(area, 1, None);

        assert_eq!(card, Rect::new(2, 3, 18, 6));
        assert!(close.x >= card.x);
        assert!(close.x + close.width <= card.x + card.width);
        assert!(close.y >= card.y);
        assert!(close.y + close.height <= card.y + card.height);
    }
}
