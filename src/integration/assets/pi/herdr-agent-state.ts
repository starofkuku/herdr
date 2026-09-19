// installed by herdr
// managed by herdr; reinstalling or updating the integration overwrites this file.
// add custom hooks/plugins beside this file instead of editing it.
// HERDR_INTEGRATION_ID=pi
// HERDR_INTEGRATION_VERSION=6
// @ts-nocheck

import { createConnection } from "node:net";

const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const paneId = process.env.HERDR_PANE_ID;
const source = "herdr:pi";

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function sendRequestAttempt(request: unknown, timeoutMs: number): Promise<boolean> {
  if (!enabled()) {
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(delivered);
    };

    const socket = createConnection(socketPath!);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) {
    return;
  }
  await sendRequestAttempt(request, 1500);
}

type AgentState = "working" | "blocked" | "idle";

type QueuedState = {
  state: AgentState;
  message?: string;
  seq: number;
};

const idleDebounceMs = parseDurationEnv("HERDR_PI_IDLE_DEBOUNCE_MS", 250);
const retryGraceMs = parseDurationEnv("HERDR_PI_RETRY_GRACE_MS", 2500);
const retryableErrorPattern =
  /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;
let reportSeq = Date.now() * 1000;
let currentAgentSessionId: string | undefined;
let currentAgentSessionPath: string | undefined;

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function parseDurationEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function updateSessionRef(ctx: any): void {
  try {
    const file = ctx?.sessionManager?.getSessionFile?.();
    currentAgentSessionPath =
      typeof file === "string" && file.startsWith("/") ? file : undefined;
  } catch {
    currentAgentSessionPath = undefined;
  }

  try {
    const id = ctx?.sessionManager?.getSessionId?.();
    currentAgentSessionId = typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    currentAgentSessionId = undefined;
  }
}

function withSessionRef(params: Record<string, unknown>): Record<string, unknown> {
  if (currentAgentSessionPath) {
    return { ...params, agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { ...params, agent_session_id: currentAgentSessionId };
  }
  return params;
}

function currentSessionRef(): Record<string, unknown> | undefined {
  if (currentAgentSessionPath) {
    return { agent_session_path: currentAgentSessionPath };
  }
  if (currentAgentSessionId) {
    return { agent_session_id: currentAgentSessionId };
  }
  return undefined;
}

function reportSession(sessionStartSource?: string): Promise<void> {
  const sessionRef = currentSessionRef();
  if (!sessionRef) {
    return Promise.resolve();
  }

  return sendRequest({
    id: `${source}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
      session_start_source: sessionStartSource,
      ...sessionRef,
    },
  });
}

function sendState(state: AgentState, message?: string, seq = nextReportSeq()): Promise<void> {
  return sendRequest({
    id: `${source}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: withSessionRef({
      pane_id: paneId,
      source,
      agent: "pi",
      state,
      message,
      seq,
    }),
  });
}

function releaseAgent(): Promise<void> {
  return sendRequest({
    id: `${source}:release:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.release_agent",
    params: {
      pane_id: paneId,
      source,
      agent: "pi",
      seq: nextReportSeq(),
    },
  });
}

/**
 * Sends one request and returns its decoded response, or undefined on failure.
 *
 * `sendRequest` above deliberately ignores the response: reporting state only
 * needs the write to land. Answering a question needs to read the answer back,
 * so this variant keeps it. One connection per request, because Herdr serves one
 * request per connection.
 */
function askRequest(request: unknown, timeoutMs: number): Promise<any> {
  if (!enabled()) {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: any) => {
      if (done) return;
      done = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      socket.destroy();
      resolve(value);
    };

    const socket = createConnection(socketPath!);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => finish(undefined));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }
      try {
        finish(JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(undefined);
      }
    });
    socket.on("end", () => finish(undefined));
    timeout = setTimeout(() => finish(undefined), timeoutMs);
    timeout.unref?.();
  });
}

/**
 * The rpiv-ask-user-question plugin's public event contract.
 *
 * Stable by its own documented policy: channel names are immutable and payload
 * changes are append-only, so reading these fields is safe. Herdr only reads
 * them; it never depends on the plugin internals.
 */
const ASK_USER_PROMPT_EVENT = "rpiv:ask-user:prompt";
const ASK_USER_BLOCKED_EVENT = "rpiv:ask-user:blocked";

/**
 * How long to keep waiting for an answer before giving the question back.
 *
 * The dialog is still on screen the whole time and the user can answer it in
 * the terminal, so this is only how long Herdr keeps offering to answer it for
 * them. On timeout the request is withdrawn and the dialog is left untouched.
 */
const askUserWaitMs = parseDurationEnv("HERDR_PI_ASK_WAIT_MS", 120000);

/**
 * Walks the plugin's canvas-free TUI dialog to the chosen row.
 *
 * The dialog has no number keys: `routeKey` reacts only to arrows, Enter, Esc,
 * Tab, Space, and a few control chords. So a choice is delivered by moving the
 * cursor and pressing Enter, which is exactly what a person would do. The
 * dialog opens with the first row focused, so the key sequence is derived from
 * the option's position rather than from any absolute address.
 */
function keysForOptionIndex(index: number): string[] {
  const keys: string[] = [];
  for (let step = 0; step < index; step += 1) {
    keys.push("down");
  }
  keys.push("enter");
  return keys;
}

/**
 * Publishes a structured question and, if the web UI answers it, delivers that
 * choice to the TUI dialog.
 *
 * The dialog itself is never replaced, so a reader can always answer in the
 * terminal instead. The request is withdrawn on every exit path, which is what
 * keeps a panel from outliving the dialog it describes.
 */
async function bridgeAskUserQuestion(payload: any, signal: { abort: boolean }): Promise<void> {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  if (questions.length !== 1) {
    // Only a single-question dialog maps onto "pick a row and press Enter". A
    // multi-question dialog (tabs, checkboxes, per-question custom answers) has
    // no faithful key sequence, so it is left to the terminal rather than
    // answered approximately.
    return;
  }

  const question = questions[0];
  const options = Array.isArray(question?.options) ? question.options : [];
  if (options.length === 0) {
    return;
  }

  const requestId = `${source}:ask:${Date.now()}:${Math.random().toString(36).slice(2)}`;
  // The plugin reports the short header separately from the question text, and
  // omits both previews (only whether one exists), so the options are presented
  // as label plus description.
  const reported = await askRequest(
    {
      id: `${source}:ask-report:${Date.now()}`,
      method: "pane.report_interaction",
      params: {
        pane_id: paneId,
        source,
        request_id: requestId,
        kind: "question",
        title: typeof question?.header === "string" ? question.header : undefined,
        summary: typeof question?.question === "string" ? question.question : undefined,
        created_unix_ms: Date.now(),
        seq: nextReportSeq(),
        ttl_ms: askUserWaitMs + 5000,
        questions: [
          {
            id: "answer",
            header: typeof question?.header === "string" ? question.header : undefined,
            question: typeof question?.question === "string" ? question.question : "Choose an option",
            multi_select: question?.multiSelect === true,
            // The plugin always offers a custom-answer row, but reaching it means
            // typing into a multiline editor, which a key sequence cannot fill
            // reliably. Choosing an option is supported; typing is left to the
            // terminal.
            allow_custom: false,
            options: options.map((option, index) => ({
              // The index is the stable identity here: the plugin answers with the
              // option's label, and the label is what the dialog row displays.
              id: String(index),
              label: String(option?.label ?? ""),
              description:
                typeof option?.description === "string" && option.description.length > 0
                  ? option.description
                  : undefined,
            })),
          },
        ],
      },
    },
    2000,
  );

  if (!reported || reported.error) {
    return;
  }

  try {
    const deadline = Date.now() + askUserWaitMs;
    while (Date.now() < deadline && !signal.abort) {
      const polled = await askRequest(
        {
          id: `${source}:ask-poll:${Date.now()}`,
          method: "pane.take_interaction_answer",
          params: { pane_id: paneId, source, request_id: requestId },
        },
        2000,
      );

      const result = polled?.result;
      if (result) {
        for (const answer of Array.isArray(result.answers) ? result.answers : []) {
          if (answer?.question_id !== "answer") {
            continue;
          }
          for (const optionId of Array.isArray(answer.option_ids) ? answer.option_ids : []) {
            const index = Number.parseInt(String(optionId), 10);
            if (!Number.isInteger(index) || index < 0 || index >= options.length) {
              continue;
            }
            await sendRequest({
              id: `${source}:ask-keys:${Date.now()}`,
              method: "pane.send_keys",
              params: { pane_id: paneId, keys: keysForOptionIndex(index) },
            });
            return;
          }
        }
        // A poll that collected nothing distinguishes "not answered yet" from
        // "the question is gone": only the latter ends the wait early.
        if (result.pending === false) {
          return;
        }
      }

      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    // Withdraw either way: on success taking the answer already cleared it, and
    // on timeout this is what stops a panel outliving the dialog. On timeout the
    // dialog is deliberately left alone, so the user still has it in the
    // terminal and nothing has been answered on their behalf.
    await askRequest(
      {
        id: `${source}:ask-clear:${Date.now()}`,
        method: "pane.clear_interaction",
        params: { pane_id: paneId, source, request_id: requestId },
      },
      2000,
    );
  }
}

/**
 * Whether the question payload has changed since the dialog opened.
 *
 * The plugin clears the prompt event on close by re-emitting the same payload,
 * so an identical payload means "still the same dialog" and a different one
 * means a new dialog, which supersedes the previous request.
 */
function promptSignature(payload: any): string {
  const questions = Array.isArray(payload?.questions) ? payload.questions : [];
  return JSON.stringify(
    questions.map((question) => [
      question?.question ?? "",
      question?.header ?? "",
      (Array.isArray(question?.options) ? question.options : []).map((option) => [
        option?.label ?? "",
        option?.description ?? "",
      ]),
    ]),
  );
}

function shouldReleaseOnSessionShutdown(event: any): boolean {
  // Pi tears down and rebinds extension runtimes for internal lifecycle actions
  // such as /reload, /new, /resume, and /fork. Those do not mean the pane's
  // agent process has exited, and releasing hook authority there can suppress
  // legitimate reports from the replacement runtime. Only a user/process quit
  // should release Herdr's full-lifecycle authority.
  const reason = event?.reason;
  return reason === "quit";
}

let sendInFlight = false;
let queuedState: QueuedState | undefined;

function queueState(state: AgentState, message?: string): void {
  queuedState = { state, message, seq: nextReportSeq() };
  if (!sendInFlight) {
    void drainStateQueue();
  }
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) {
    return;
  }

  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq);
    }
  } finally {
    sendInFlight = false;
    if (queuedState) {
      void drainStateQueue();
    }
  }
}

function lastAssistantMessage(messages: unknown[]): any | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as any;
    if (message?.role === "assistant") {
      return message;
    }
  }
  return undefined;
}

function retryableErrorMessage(event: any): string | undefined {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  const assistant = lastAssistantMessage(messages);
  if (assistant?.stopReason !== "error") {
    return undefined;
  }

  const errorMessage = String(assistant.errorMessage ?? "");
  if (!retryableErrorPattern.test(errorMessage)) {
    return undefined;
  }
  return errorMessage || "retryable provider error";
}

export default function (pi) {
  if (!enabled()) {
    return;
  }

  let agentActive = false;
  let retryHoldActive = false;
  let failureBlocked = false;
  let failureMessage: string | undefined;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: AgentState | undefined;
  let lastMessage: string | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let rootSession = false;
  let activePromptSignature: string | undefined;
  let activePrompt: { signature: string; signal: { abort: boolean } } | undefined;

  function clearTimer(timer: ReturnType<typeof setTimeout> | undefined) {
    if (timer) {
      clearTimeout(timer);
    }
  }

  function clearPendingTimers() {
    clearTimer(idleTimer);
    clearTimer(retryTimer);
    idleTimer = undefined;
    retryTimer = undefined;
  }

  function clearFailureState() {
    retryHoldActive = false;
    failureBlocked = false;
    failureMessage = undefined;
  }

  function desiredState() {
    if (blockedCount > 0) {
      return { state: "blocked" as const, message: blockedMessage };
    }
    if (failureBlocked) {
      return { state: "blocked" as const, message: failureMessage };
    }
    if (agentActive || retryHoldActive) {
      return { state: "working" as const, message: undefined };
    }
    return { state: "idle" as const, message: undefined };
  }

  function publishState(force = false) {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) {
      return;
    }
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message);
  }

  function scheduleIdle() {
    clearPendingTimers();
    clearFailureState();
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      publishState();
    }, idleDebounceMs);
    idleTimer.unref?.();
  }

  function holdForRetry(message: string) {
    clearPendingTimers();
    retryHoldActive = true;
    failureBlocked = false;
    failureMessage = message;
    publishState();

    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryHoldActive = false;
      failureBlocked = true;
      publishState();
    }, retryGraceMs);
    retryTimer.unref?.();
  }

  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) {
      return;
    }
    if (!data?.active) {
      blockedCount = Math.max(0, blockedCount - 1);
      if (blockedCount === 0) {
        blockedMessage = undefined;
      }
      publishState();
      return;
    }

    clearPendingTimers();
    blockedCount += 1;
    blockedMessage = data.label;
    publishState();
  });

  // The ask-user-question plugin publishes the question it is waiting on, so
  // the web UI can offer the options the agent actually authored instead of a
  // screen scrape. Herdr mirrors them back to the dialog, which stays on screen
  // and remains answerable in the terminal the whole time.
  pi.events.on(ASK_USER_PROMPT_EVENT, (payload) => {
    if (!rootSession) {
      return;
    }
    // The plugin re-emits the same payload to signal that a dialog closed, so an
    // unchanged payload means "the dialog this bridge is already tracking". It
    // must not supersede the request being answered, but it must also not be
    // remembered past that dialog: the baseline is cleared when the wait ends
    // (below), so the next dialog publishes even when its text is identical —
    // the same question asked twice in a turn is two separate dialogs.
    const signature = promptSignature(payload);
    if (signature === activePromptSignature) {
      return;
    }
    activePromptSignature = signature;
    // A dialog that closes while this bridge is waiting — answered or cancelled
    // in the terminal — must withdraw the panel immediately rather than leave it
    // offering a question that is gone until the wait happens to expire.
    const signal = { abort: false };
    activePrompt?.signal && (activePrompt.signal.abort = true);
    activePrompt = { signature, signal };
    void bridgeAskUserQuestion(payload, signal).finally(() => {
      // Only clear our own dialog's baseline: a newer dialog may already have
      // replaced it while this wait was finishing.
      if (activePromptSignature === signature) {
        activePromptSignature = undefined;
        activePrompt = undefined;
      }
    });
  });

  pi.events.on(ASK_USER_BLOCKED_EVENT, (data) => {
    if (!rootSession) {
      return;
    }
    // The plugin brackets the dialog with these events, so `active: false` means
    // the wait is over: the dialog was answered, cancelled, or errored. Ending
    // the bridge's wait here is what makes the panel disappear as soon as the
    // user answers in the terminal, instead of lingering until it times out.
    const active = data?.active === true;
    if (!active && activePrompt) {
      activePrompt.signal.abort = true;
    }
    // Precise blocked signal from the plugin, and the one the state machine
    // above already reads: it knows a question is on screen, which screen-text
    // detection can only guess at.
    const event = { active, label: "waiting for your answer" };
    pi.events.emit("herdr:blocked", event);
  });

  pi.on("session_start", async (event, ctx) => {
    if (ctx?.hasUI !== true) {
      return;
    }
    rootSession = true;
    updateSessionRef(ctx);
    await reportSession(event?.reason);
    // A reload can replace this extension mid-run without emitting another agent_start.
    agentActive = ctx?.isIdle?.() === false;
    publishState(true);
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) {
      return;
    }
    updateSessionRef(ctx);
    void reportSession();
    clearPendingTimers();
    clearFailureState();
    agentActive = true;
    publishState();
  });

  pi.on("agent_end", (event) => {
    if (!rootSession) {
      return;
    }
    if (!agentActive) {
      // Pi can emit duplicate/late end events while auto-retry is already
      // holding the pane in Working. Do not let an unqualified duplicate end
      // cancel the retry hold and publish a false Idle.
      return;
    }

    agentActive = false;

    const retryableMessage = retryableErrorMessage(event);
    if (retryableMessage) {
      holdForRetry(retryableMessage);
      return;
    }

    scheduleIdle();
  });

  pi.on("session_shutdown", async (event) => {
    if (!rootSession) {
      return;
    }
    clearPendingTimers();
    if (shouldReleaseOnSessionShutdown(event)) {
      await releaseAgent();
    }
  });
}
