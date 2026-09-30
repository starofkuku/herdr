import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentView } from "./api";
import { cycleOrder, nextIndex } from "./agent-cycle";

/**
 * The agents being walked, frozen for as long as the chord is held.
 *
 * Frozen on purpose: the list refreshes from the socket while the overlay is up,
 * and an order that rearranged itself under the highlight would move the choice
 * out from under the reader's finger.
 */
export interface CycleState {
  order: AgentView[];
  index: number;
}

/** The live cycle: what is on the ring, and how to move around it. */
export interface Cycle extends CycleState {
  /** Moves the highlight to a card, for the pointer. */
  highlight: (index: number) => void;
  /** Opens the card at an index and takes the ring down, for a click. */
  pick: (index: number) => void;
}

/**
 * How fast a held chord walks the list.
 *
 * Holding Tab auto-repeats at the OS rate, which is far too fast to stop on
 * anything: at the usual thirty steps a second a six-agent ring is a blur. Each
 * repeat is therefore allowed one step per interval, while the first press is
 * never delayed.
 */
const REPEAT_STEP_MS = 140;

/**
 * Shift+Tab as a window switcher, in the shape Windows has always used: hold
 * the chord, the candidates turn, let go and the highlighted one is opened.
 *
 * Hold-and-release rather than press-to-open because it is the gesture that
 * already means "switch" everywhere, and because a chord that opened something
 * per press would fill the history with screens passed through on the way.
 *
 * The whole page is intercepted, not just the conversation: a Tab that reached
 * the page would move focus, and focus moving out from under a held chord is how
 * a switcher ends up half-applied. With fewer than two agents there is nothing
 * to switch to, so the key is left alone and keeps its ordinary meaning.
 *
 * Returns the live cycle, or null when no chord is down.
 */
export function useAgentCycle({
  agents,
  onCommit,
}: {
  /** Every agent on every backend: the cycle crosses gateways. */
  agents: AgentView[];
  /** Opens the chosen agent. */
  onCommit: (paneId: string, backendId?: string) => void;
}): Cycle | null {
  const [state, setState] = useState<CycleState | null>(null);
  /** The same cycle, readable from the listeners without re-registering them. */
  const live = useRef<CycleState | null>(null);
  /**
   * The newest props, for the listeners.
   *
   * The listeners are registered once per "can cycle" state rather than on every
   * list refresh, so what they read has to come from somewhere current.
   */
  const newest = useRef({ agents, onCommit });
  newest.current = { agents, onCommit };
  const lastStep = useRef(0);

  const show = useCallback((next: CycleState | null) => {
    live.current = next;
    setState(next);
  }, []);

  /** Moves the highlight without opening anything: what the pointer does. */
  const highlight = useCallback(
    (index: number) => {
      const current = live.current;
      if (!current || index === current.index) return;
      show({ order: current.order, index });
    },
    [show],
  );

  /** Opens a card and takes the ring down: what a click, and the key release, do. */
  const pick = useCallback(
    (index: number) => {
      const current = live.current;
      if (!current) return;
      const chosen = current.order[index];
      show(null);
      if (chosen) newest.current.onCommit(chosen.paneId, chosen.backendId);
    },
    [show],
  );

  const canCycle = agents.length >= 2;

  useEffect(() => {
    if (!canCycle) return;

    const start = () => {
      const order = cycleOrder(newest.current.agents);
      if (order.length < 2) return;
      // The head of an attention-first order is the most demanding agent there
      // is, so one press is enough to reach whoever is waiting.
      show({ order, index: 0 });
    };

    const step = () => {
      const current = live.current;
      if (!current) return;
      show({ order: current.order, index: nextIndex(current.index, current.order.length) });
    };

    const commit = () => {
      if (live.current) pick(live.current.index);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!live.current) return;
        event.preventDefault();
        show(null);
        return;
      }
      if (event.key !== "Tab" || !event.shiftKey) return;
      event.preventDefault();
      if (!live.current) {
        start();
        lastStep.current = event.timeStamp;
        return;
      }
      // Repeats are paced; a deliberate second press is not.
      if (event.repeat && event.timeStamp - lastStep.current < REPEAT_STEP_MS) return;
      lastStep.current = event.timeStamp;
      step();
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (!live.current) return;
      // Shift is the modifier that holds the cycle open, so letting go of it is
      // the commit — in Windows too, the window opens when Alt comes up.
      if (event.key === "Shift") {
        commit();
        return;
      }
      // Tab released with Shift already up: the reader let go of the two in the
      // other order, and this is the last event the page sees of the chord.
      if (event.key === "Tab" && !event.shiftKey) commit();
    };

    /*
     * A chord held while the window loses focus never delivers its keyup — the
     * browser that took the focus owns the keyboard now — so the cycle is
     * abandoned rather than left hanging over the page.
     *
     * Abandoned, not committed: a lost focus says nothing about what the reader
     * chose, and navigating to a guess is worse than doing nothing. They can
     * press again once they are back.
     */
    const onBlur = () => show(null);

    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
      show(null);
    };
  }, [canCycle, show, pick]);

  return useMemo(
    () => (state ? { ...state, highlight, pick } : null),
    [state, highlight, pick],
  );
}
