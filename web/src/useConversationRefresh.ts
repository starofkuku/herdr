import { useEffect } from "react";
import type { DetailClient } from "./AgentDetail";
import { LIVE_POLL_MS, paneIdOfEvent } from "./api";

/** Runtime status and transcript completion arrive independently. */
export function useConversationRefresh(
  client: DetailClient,
  paneId: string,
  working: boolean,
  unfinished: boolean,
  refresh: () => void,
) {
  useEffect(() => {
    let timer: number | null = null;
    const subscription = client.subscribe(
      ["pane.updated", { type: "pane.agent_status_changed", pane_id: paneId }],
      (payload) => {
        const eventPane = paneIdOfEvent(payload);
        if (eventPane !== undefined && eventPane !== paneId) return;
        if (timer !== null) return;
        timer = window.setTimeout(() => {
          timer = null;
          refresh();
        }, 500);
      },
    );
    return () => {
      subscription.close();
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [client, paneId, refresh]);

  useEffect(() => {
    refresh();
    // An idle runtime does not prove that the last transcript read included
    // the completion event. Keep reading without inventing a terminal status.
    if (!working && !unfinished) return;
    const timer = window.setInterval(refresh, LIVE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [working, unfinished, refresh]);
}
