import { afterEach, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const originalEnvironment = {
  HERDR_ENV: process.env.HERDR_ENV,
  HERDR_OMP_IDLE_DEBOUNCE_MS: process.env.HERDR_OMP_IDLE_DEBOUNCE_MS,
  HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  HERDR_PI_ASK_WAIT_MS: process.env.HERDR_PI_ASK_WAIT_MS,
  HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
};

let server: Server | undefined;
let socketPath: string | undefined;
let importCounter = 0;

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    if (!server) {
      resolve();
      return;
    }
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server = undefined;

  if (socketPath) {
    await rm(socketPath, { force: true });
    socketPath = undefined;
  }

  for (const [name, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
});

const integrations = [
  { name: "Pi", modulePath: "./pi/herdr-agent-state.ts" },
  { name: "Oh My Pi", modulePath: "./omp/herdr-agent-state.ts" },
] as const;

function importFresh(modulePath: string) {
  importCounter += 1;
  return import(`${modulePath}?test=${importCounter}`);
}

type Handler = (event: unknown, context: unknown) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    pi: {
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
      events: {
        on() {
          return () => {};
        },
      },
    },
  };
}

function configureIntegrationEnvironment(recordingSocketPath: string) {
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = recordingSocketPath;
  process.env.HERDR_PANE_ID = "test:p1";
}

async function startRecordingServer(name: string): Promise<unknown[]> {
  const recordingSocketPath = join(tmpdir(), `herdr-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      requests.push(JSON.parse(input.slice(0, newline)));
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });
  configureIntegrationEnvironment(recordingSocketPath);
  return requests;
}

for (const integration of integrations) {
  test(`${integration.name} reload preserves working state when the agent is active`, async () => {
    const requests = await startRecordingServer(
      integration.name.toLowerCase().replaceAll(" ", "-"),
    );
    const { handlers, pi } = createExtensionHarness();

    const { default: install } = await importFresh(integration.modulePath);
    install(pi);

    const sessionStart = handlers.get("session_start");
    expect(sessionStart).toBeDefined();
    await sessionStart?.(
      { reason: "reload" },
      {
        hasUI: true,
        isIdle: () => false,
        sessionManager: {
          getSessionFile: () => undefined,
          getSessionId: () => undefined,
        },
      },
    );

    const reportedState = () => {
      for (const request of requests) {
        if (!isRecord(request) || request.method !== "pane.report_agent") {
          continue;
        }
        const params = request.params;
        if (isRecord(params) && typeof params.state === "string") {
          return params.state;
        }
      }
      return undefined;
    };

    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline && reportedState() === undefined) {
      await Bun.sleep(5);
    }

    expect(reportedState()).toBe("working");
  });
}

test("Pi reports the session replacement source", async () => {
  const requests = await startRecordingServer("pi-session-source");
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  await sessionStart?.(
    { reason: "new" },
    {
      hasUI: true,
      isIdle: () => true,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-new.jsonl",
        getSessionId: () => "pi-new",
      },
    },
  );

  const reportedSession = () =>
    requests.find((request) => isRecord(request) && request.method === "pane.report_agent_session");
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && reportedSession() === undefined) {
    await Bun.sleep(5);
  }

  const request = reportedSession();
  expect(request).toBeDefined();
  expect(isRecord(request) && isRecord(request.params) ? request.params.session_start_source : null)
    .toBe("new");
});

test("Pi waits for a replacement session report before publishing state", async () => {
  const recordingSocketPath = join(tmpdir(), `herdr-pi-session-order-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  let acknowledgeSessionReport: (() => void) | undefined;
  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);
      if (isRecord(request) && request.method === "pane.report_agent_session") {
        acknowledgeSessionReport = () => socket.end("{}\n");
        return;
      }
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });

  configureIntegrationEnvironment(recordingSocketPath);
  const { handlers, pi } = createExtensionHarness();
  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  const sessionStartResult = sessionStart?.(
    { reason: "new" },
    {
      hasUI: true,
      isIdle: () => false,
      sessionManager: {
        getSessionFile: () => "/tmp/pi-new.jsonl",
        getSessionId: () => "pi-new",
      },
    },
  );

  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline && acknowledgeSessionReport === undefined) {
    await Bun.sleep(5);
  }
  expect(acknowledgeSessionReport).toBeDefined();
  expect(
    requests.some((request) => isRecord(request) && request.method === "pane.report_agent"),
  ).toBe(false);

  acknowledgeSessionReport?.();
  await sessionStartResult;

  const stateDeadline = Date.now() + 1_000;
  while (
    Date.now() < stateDeadline &&
    !requests.some((request) => isRecord(request) && request.method === "pane.report_agent")
  ) {
    await Bun.sleep(5);
  }
  expect(requests.map((request) => (isRecord(request) ? request.method : undefined))).toEqual([
    "pane.report_agent_session",
    "pane.report_agent",
  ]);
});

async function startDroppedFirstResponseServer(name: string) {
  const recordingSocketPath = join(tmpdir(), `herdr-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  let connectionCount = 0;
  const attemptedRequests: unknown[] = [];
  const deliveredRequests: unknown[] = [];
  const recordingServer = createServer((socket) => {
    connectionCount += 1;
    const connectionNumber = connectionCount;
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newline));
      attemptedRequests.push(request);
      if (connectionNumber === 1) {
        return;
      }
      deliveredRequests.push(request);
      socket.end("{}\n");
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });

  configureIntegrationEnvironment(recordingSocketPath);
  return {
    attemptedRequests,
    deliveredRequests,
    connectionCount: () => connectionCount,
  };
}

test("Oh My Pi retries working before a queued idle state", async () => {
  const { attemptedRequests } = await startDroppedFirstResponseServer("omp-retry");
  process.env.HERDR_OMP_IDLE_DEBOUNCE_MS = "0";
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./omp/herdr-agent-state.ts");
  install(pi);

  const context = {
    hasUI: true,
    isIdle: () => false,
    sessionManager: {
      getSessionFile: () => undefined,
      getSessionId: () => undefined,
    },
  };
  handlers.get("session_start")?.({ reason: "startup" }, context);
  handlers.get("agent_end")?.({ messages: [] }, context);

  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline && attemptedRequests.length < 3) {
    await Bun.sleep(5);
  }

  expect(attemptedRequests).toHaveLength(3);
  expect(attemptedRequests[1]).toEqual(attemptedRequests[0]);
  expect(requestState(attemptedRequests[0])).toBe("working");
  expect(requestState(attemptedRequests[2])).toBe("idle");
});

test("Pi retries working state after an unanswered socket attempt", async () => {
  const { attemptedRequests, deliveredRequests, connectionCount } =
    await startDroppedFirstResponseServer("pi-retry");
  const { handlers, pi } = createExtensionHarness();

  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  const sessionStart = handlers.get("session_start");
  expect(sessionStart).toBeDefined();
  await sessionStart?.(
    { reason: "startup" },
    {
      hasUI: true,
      isIdle: () => false,
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
      },
    },
  );

  const reportedWorking = () =>
    deliveredRequests.some((request) => {
      if (!isRecord(request) || request.method !== "pane.report_agent") {
        return false;
      }
      const params = request.params;
      return isRecord(params) && params.state === "working";
    });

  const deadline = Date.now() + 2_500;
  while (Date.now() < deadline && !reportedWorking()) {
    await Bun.sleep(5);
  }

  expect(connectionCount()).toBeGreaterThanOrEqual(2);
  expect(attemptedRequests.length).toBeGreaterThanOrEqual(2);
  expect(attemptedRequests[1]).toEqual(attemptedRequests[0]);
  expect(reportedWorking()).toBe(true);
});

function requestState(request: unknown): unknown {
  if (!isRecord(request) || !isRecord(request.params)) {
    return undefined;
  }
  return request.params.state;
}

/**
 * A recording server that answers interaction requests, so the bridge's polling
 * loop and its key sequence can be exercised end to end.
 */
async function startInteractionServer(
  name: string,
  options: { answerAfterPolls?: number; optionIds?: string[] } = {},
): Promise<{ requests: unknown[]; prompts: () => unknown[] }> {
  const recordingSocketPath = join(tmpdir(), `herdr-${name}-${process.pid}.sock`);
  socketPath = recordingSocketPath;
  await rm(recordingSocketPath, { force: true });

  const requests: unknown[] = [];
  // Live prompts are tracked from the recorded calls so the prompt event can be
  // emitted without the test having to know the generated request id.
  const prompts = () =>
    requests.filter((request) => isRecord(request) && request.method === "pane.report_interaction");
  let polls = 0;

  const recordingServer = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline === -1) {
        return;
      }
      const request = JSON.parse(input.slice(0, newline));
      requests.push(request);

      if (request.method === "pane.take_interaction_answer") {
        polls += 1;
        if (options.answerAfterPolls !== undefined && polls >= options.answerAfterPolls) {
          socket.end(
            `${JSON.stringify({
              id: request.id,
              result: {
                answers: [
                  { question_id: "answer", option_ids: options.optionIds ?? ["0"] },
                ],
                pending: false,
              },
            })}\n`,
          );
          return;
        }
        socket.end(
          `${JSON.stringify({ id: request.id, result: { answers: [], pending: true } })}\n`,
        );
        return;
      }

      socket.end(`${JSON.stringify({ id: request.id, result: {} })}\n`);
    });
  });
  server = recordingServer;
  await new Promise<void>((resolve, reject) => {
    recordingServer.once("error", reject);
    recordingServer.listen(recordingSocketPath, resolve);
  });
  configureIntegrationEnvironment(recordingSocketPath);
  return { requests, prompts };
}

function askUserPrompt(questions: unknown[]): unknown {
  return { questions };
}

/**
 * The plugin's event bus, with `emit` wired so a listener re-emitting on the bus
 * (as the blocked bridge does) reaches the other listeners.
 */
function createEventBusHarness() {
  const eventHandlers = new Map<string, ((data: unknown) => void)[]>();
  return {
    emit(event: string, data: unknown) {
      for (const handler of eventHandlers.get(event) ?? []) {
        handler(data);
      }
    },
    events: {
      emit(event: string, data: unknown) {
        for (const handler of eventHandlers.get(event) ?? []) {
          handler(data);
        }
      },
      on(event: string, handler: (data: unknown) => void) {
        const list = eventHandlers.get(event) ?? [];
        list.push(handler);
        eventHandlers.set(event, list);
        return () => {};
      },
    },
  };
}

async function installPiWithPrompt(
  requests: unknown[],
  questions: unknown[],
  options: { waitMs?: string } = {},
): Promise<ReturnType<typeof createEventBusHarness>> {
  // Read at module scope by the extension, so it must be set before the import.
  if (options.waitMs !== undefined) {
    process.env.HERDR_PI_ASK_WAIT_MS = options.waitMs;
  } else {
    delete process.env.HERDR_PI_ASK_WAIT_MS;
  }
  const bus = createEventBusHarness();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const pi = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
    },
    events: bus.events,
  };

  const { default: install } = await importFresh("./pi/herdr-agent-state.ts");
  install(pi);

  await handlers.get("session_start")?.(
    { reason: "startup" },
    {
      hasUI: true,
      isIdle: () => true,
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
      },
    },
  );

  bus.emit("rpiv:ask-user:prompt", askUserPrompt(questions));
  return bus;
}

function reportCount(requests: unknown[]): number {
  return requests.filter(
    (request) => isRecord(request) && request.method === "pane.report_interaction",
  ).length;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) {
    await Bun.sleep(5);
  }
}

const singleQuestion = [
  {
    question: "Which approach?",
    header: "Approach",
    multiSelect: false,
    options: [
      { label: "Option A", description: "First", hasPreview: false },
      { label: "Option B", description: "Second", hasPreview: false },
      { label: "Option C", description: "Third", hasPreview: false },
    ],
  },
];

test("Pi publishes the plugin's question so a client can offer its options", async () => {
  const { requests } = await startInteractionServer("pi-ask-publish");
  await installPiWithPrompt(requests, singleQuestion);

  await waitFor(() =>
    requests.some((request) => isRecord(request) && request.method === "pane.report_interaction"),
  );

  const reported = requests.find(
    (request) => isRecord(request) && request.method === "pane.report_interaction",
  );
  expect(isRecord(reported)).toBe(true);
  const params = isRecord(reported) ? reported.params : undefined;
  expect(isRecord(params)).toBe(true);
  if (!isRecord(params)) return;

  expect(params.kind).toBe("question");
  expect(params.title).toBe("Approach");
  expect(params.summary).toBe("Which approach?");
  const questions = params.questions as Record<string, unknown>[];
  expect(questions).toHaveLength(1);
  expect(questions[0].question).toBe("Which approach?");
  expect(questions[0].multi_select).toBe(false);
  // The plugin omits preview content and reports only whether one exists, so no
  // preview is offered rather than an empty one.
  expect(questions[0].options).toEqual([
    { id: "0", label: "Option A", description: "First" },
    { id: "1", label: "Option B", description: "Second" },
    { id: "2", label: "Option C", description: "Third" },
  ]);
});

test("Pi answers a question by moving the dialog cursor and confirming", async () => {
  // The dialog has no number keys, so the third option must be reached with two
  // Down presses and then Enter.
  const { requests } = await startInteractionServer("pi-ask-answer", {
    answerAfterPolls: 1,
    optionIds: ["2"],
  });
  await installPiWithPrompt(requests, singleQuestion);

  const sentKeys = () =>
    requests.find(
      (request) =>
        isRecord(request) &&
        request.method === "pane.send_keys" &&
        isRecord(request.params) &&
        Array.isArray(request.params.keys),
    );

  await waitFor(() => sentKeys() !== undefined);

  const keys = sentKeys();
  expect(isRecord(keys)).toBe(true);
  expect(isRecord(keys) ? (keys.params as Record<string, unknown>).keys : undefined).toEqual([
    "down",
    "down",
    "enter",
  ]);
});

test("Pi confirms the first option with Enter and no movement", async () => {
  const { requests } = await startInteractionServer("pi-ask-first", {
    answerAfterPolls: 1,
    optionIds: ["0"],
  });
  await installPiWithPrompt(requests, singleQuestion);

  const sentKeys = () =>
    requests.find((request) => isRecord(request) && request.method === "pane.send_keys");
  await waitFor(() => sentKeys() !== undefined);

  const keys = sentKeys();
  expect(isRecord(keys) ? (keys.params as Record<string, unknown>).keys : undefined).toEqual([
    "enter",
  ]);
});

test("Pi withdraws the request once it has answered", async () => {
  const { requests } = await startInteractionServer("pi-ask-clear", {
    answerAfterPolls: 1,
    optionIds: ["1"],
  });
  await installPiWithPrompt(requests, singleQuestion);

  await waitFor(() =>
    requests.some((request) => isRecord(request) && request.method === "pane.clear_interaction"),
  );
  expect(
    requests.some((request) => isRecord(request) && request.method === "pane.clear_interaction"),
  ).toBe(true);
});

test("Pi publishes an identical question again after the previous wait ended", async () => {
  // The plugin re-emits the same payload to signal a dialog closed, so an
  // unchanged payload must not supersede a live request. But the same question
  // asked twice is two dialogs, so the baseline has to be cleared when the first
  // wait ends rather than remembered for the whole session.
  const { requests } = await startInteractionServer("pi-ask-repeat");
  const bus = await installPiWithPrompt(requests, singleQuestion, { waitMs: "150" });

  await waitFor(() => reportCount(requests) >= 1);
  // Let the first wait expire, then ask exactly the same question again.
  await waitFor(() =>
    requests.some((request) => isRecord(request) && request.method === "pane.clear_interaction"),
  );
  bus.emit("rpiv:ask-user:prompt", askUserPrompt(singleQuestion));
  await waitFor(() => reportCount(requests) >= 2);

  expect(reportCount(requests)).toBeGreaterThanOrEqual(2);
});

test("Pi withdraws the panel as soon as the dialog ends", async () => {
  // Answering in the terminal ends the plugin's wait. The panel must go away
  // then, not when the bridge's own (much longer) timeout happens to expire.
  const { requests } = await startInteractionServer("pi-ask-close");
  const bus = await installPiWithPrompt(requests, singleQuestion, { waitMs: "60000" });

  await waitFor(() =>
    requests.some((request) => isRecord(request) && request.method === "pane.report_interaction"),
  );
  bus.emit("rpiv:ask-user:blocked", { active: false });

  await waitFor(() =>
    requests.some((request) => isRecord(request) && request.method === "pane.clear_interaction"),
  );
  expect(
    requests.some((request) => isRecord(request) && request.method === "pane.clear_interaction"),
  ).toBe(true);
});

test("Pi leaves a multi-question dialog to the terminal", async () => {
  // Tabs and checkboxes have no faithful key sequence, so nothing is published
  // rather than publishing a question the UI could not answer correctly.
  const { requests } = await startInteractionServer("pi-ask-multi");
  await installPiWithPrompt(requests, [
    singleQuestion[0],
    { ...singleQuestion[0], question: "Second question?" },
  ]);

  await Bun.sleep(250);
  expect(
    requests.some((request) => isRecord(request) && request.method === "pane.report_interaction"),
  ).toBe(false);
});

test("Pi maps the plugin's blocked event onto the blocked state it already reads", async () => {
  const { requests } = await startInteractionServer("pi-ask-blocked");
  const bus = await installPiWithPrompt(requests, singleQuestion);

  // The plugin brackets the dialog with these, so this is the order it emits in.
  bus.emit("rpiv:ask-user:blocked", { active: true });

  await waitFor(() =>
    requests.some(
      (request) =>
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params) &&
        request.params.state === "blocked",
    ),
  );

  expect(
    requests.some(
      (request) =>
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params) &&
        request.params.state === "blocked",
    ),
  ).toBe(true);

  // Clearing the plugin's blocked event must not leave the pane blocked.
  bus.emit("rpiv:ask-user:blocked", { active: false });
  await waitFor(() =>
    requests.some(
      (request) =>
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params) &&
        request.params.state === "idle",
    ),
  );
  expect(
    requests.some(
      (request) =>
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params) &&
        request.params.state === "idle",
    ),
  ).toBe(true);
});

test("Pi keeps the pane working while the subagents extension reports busy", async () => {
  // A child agent can outlive the turn that started it. The subagents extension
  // announces that through `herdr:busy`, so without honoring it the pane falls
  // back to idle while the child is still running.
  const { requests } = await startInteractionServer("pi-busy");
  const bus = await installPiWithPrompt(requests, singleQuestion);

  const reported = (state: string) =>
    requests.some(
      (request) =>
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params) &&
        request.params.state === state,
    );

  bus.emit("herdr:busy", { active: true, label: "2 subagents (worker)" });
  await waitFor(() => reported("working"));
  expect(reported("working")).toBe(true);

  // The turn ending must not clear the busy hold.
  await Bun.sleep(400);
  expect(reported("working")).toBe(true);

  // Only the extension retiring its last child ends the work.
  bus.emit("herdr:busy", { active: false });
  await waitFor(() => reported("idle"));
  expect(reported("idle")).toBe(true);
});

test("Pi reports blocked while a child needs attention, even with others running", async () => {
  // A waiting child outranks a running one: the pane should read as blocked
  // until someone answers, not as ordinary work in progress.
  const { requests } = await startInteractionServer("pi-busy-blocked");
  const bus = await installPiWithPrompt(requests, singleQuestion);

  const latestState = () => {
    let state: unknown;
    for (const request of requests) {
      if (
        isRecord(request) &&
        request.method === "pane.report_agent" &&
        isRecord(request.params)
      ) {
        state = request.params.state;
      }
    }
    return state;
  };

  bus.emit("herdr:busy", { active: true, label: "1 subagent (worker)" });
  await waitFor(() => latestState() === "working");
  expect(latestState()).toBe("working");

  bus.emit("herdr:blocked", { active: true, label: "needs your answer" });
  await waitFor(() => latestState() === "blocked");
  expect(latestState()).toBe("blocked");

  // Answering it returns to working because the child is still running.
  bus.emit("herdr:blocked", { active: false });
  await waitFor(() => latestState() === "working");
  expect(latestState()).toBe("working");
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
