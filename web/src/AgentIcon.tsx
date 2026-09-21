import { agentMark } from "./brandIcons";

/**
 * The mark of the agent behind a pane, when one is known.
 *
 * Drawn in the brand's own colour rather than the surrounding text colour, so a
 * row of agents reads apart at a glance and the mark still reads as the owner's
 * rather than as this UI's decoration.
 *
 * Nothing is rendered for an unrecognised agent: herdr detects agents no icon
 * set has heard of, and a placeholder would say less than the silence does.
 */
export function AgentIcon({ agent, size = 16 }: { agent?: string | null; size?: number }) {
  const mark = agentMark(agent);
  if (!mark) return null;

  return (
    <svg
      className="agent-icon"
      role="img"
      aria-label={mark.title}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={`#${mark.hex}`}
    >
      <path d={mark.path} />
    </svg>
  );
}
