/*
 * The conversations the reader has already read, kept per gateway.
 *
 * Switching panes remounts the detail view, which is deliberate: it is what keeps
 * one pane's paging, reading position, and optimistic echo out of the next one.
 * The cost is that coming back has nothing to start from, so the whole
 * conversation is re-read and re-rendered — a visible wait, on a session of a few
 * hundred turns, for a screen the reader has already seen.
 *
 * Kept per gateway client rather than per pane id, because pane ids are only
 * unique within one: two gateways can both hold `w1:p1`. A `WeakMap` so a gateway
 * that goes away takes its memory with it.
 */

import type { Conversation, ConversationTurn } from "./conversation";

/** Everything a pane's view needs to come back as it was left. */
export interface ConversationSnapshot {
  conversation: Conversation;
  /** The newest page, as of the last visit. */
  newest: ConversationTurn[];
  /** The pages the reader had pulled in above it, newest-first. */
  older: ConversationTurn[][];
  /** Where paging into history had reached. */
  cursor: number | undefined;
  /** Whether the reader had paged at all, which changes how a refresh merges. */
  historyLoaded: boolean;
  /** How far the jump control was showing the reader from the newest output. */
  awayFromBottom: boolean;
  /** How far down the pane was, for a reader who was reading back. */
  scrollTop: number;
}

/**
 * How many panes keep their conversation.
 *
 * A session is usually a handful of panes, so this holds the whole working set;
 * beyond it the least recently visited goes, which is the one the reader is
 * least likely to come back to next.
 */
const MAX_PANES = 8;

const byClient = new WeakMap<object, Map<string, ConversationSnapshot>>();

function entriesFor(client: object): Map<string, ConversationSnapshot> {
  const existing = byClient.get(client);
  if (existing) return existing;
  const created = new Map<string, ConversationSnapshot>();
  byClient.set(client, created);
  return created;
}

/** The conversation this pane was last left with, if it is still held. */
export function readConversation(client: object, paneId: string): ConversationSnapshot | null {
  const entries = byClient.get(client);
  const snapshot = entries?.get(paneId);
  if (!entries || !snapshot) return null;
  // Reading is using: the pane the reader came back to is the last to be evicted.
  entries.delete(paneId);
  entries.set(paneId, snapshot);
  return snapshot;
}

/** Keeps a pane's conversation for the next visit. */
export function writeConversation(
  client: object,
  paneId: string,
  snapshot: ConversationSnapshot,
): void {
  const entries = entriesFor(client);
  entries.delete(paneId);
  entries.set(paneId, snapshot);
  while (entries.size > MAX_PANES) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    entries.delete(oldest.value);
  }
}

/**
 * Forgets one pane.
 *
 * For a conversation that is no longer the one being shown — a pane whose agent
 * started a new session, whose cached turns belong to the session before it.
 */
export function dropConversation(client: object, paneId: string): void {
  byClient.get(client)?.delete(paneId);
}
