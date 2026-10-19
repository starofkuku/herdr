/*
 * The pane as a terminal, for a client that draws the terminal itself.
 *
 * Everything here is a thin layer over the API: the geometry the terminal was laid
 * out for, the screen it is showing now, a new shell, and one keystroke. The bytes
 * that keep it live come from a `pane.terminal_output` subscription, which the
 * gateway proxies like any other.
 */

interface TerminalClient {
  call: <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
}

/** The grid a pane's terminal is laid out for, and where its cursor is. */
export interface TerminalGeometry {
  cols: number;
  rows: number;
  cursorX: number;
  cursorY: number;
  cursorVisible: boolean;
}

/**
 * The workspace web-created shells live in.
 *
 * One workspace rather than one per click: a browser that opened a shell and then
 * opened another should find both, and the TUI's own layout should not grow a tab
 * each time the reader taps a button on a phone. The label is how that workspace is
 * found again.
 */
export const SHELL_WORKSPACE_LABEL = "shell";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The grid the pane's terminal is laid out for.
 *
 * A client drawing the terminal has to use the same number of columns the bytes
 * were produced for; guessing from the window would re-wrap every line. The layout
 * is where the pane's size in cells is already published.
 */
export async function loadGeometry(
  client: TerminalClient,
  paneId: string,
): Promise<TerminalGeometry | null> {
  try {
    const response = await client.call<{ presentation?: unknown }>("pane.presentation", {
      pane_id: paneId,
    });
    const presentation = asRecord(response?.presentation);
    const terminal = asRecord(presentation?.terminal);
    if (!terminal) return null;
    const cols = asNumber(terminal.cols);
    const rows = asNumber(terminal.rows);
    if (!cols || !rows) return null;
    return {
      cols,
      rows,
      cursorX: asNumber(terminal.cursor_x) ?? 0,
      cursorY: asNumber(terminal.cursor_y) ?? 0,
      cursorVisible: terminal.cursor_visible === true,
    };
  } catch {
    return null;
  }
}

/**
 * What the pane is showing right now, with its colours.
 *
 * The stream only carries what happens next, so a terminal that has just been
 * opened has to be given the screen first — otherwise it would show nothing until
 * the next key is pressed.
 */
export async function loadScreen(client: TerminalClient, paneId: string): Promise<string> {
  try {
    const response = await client.call<{ read?: unknown }>("pane.read", {
      pane_id: paneId,
      source: "visible",
      format: "ansi",
      strip_ansi: false,
    });
    const read = asRecord(response?.read);
    return typeof read?.text === "string" ? read.text : "";
  } catch {
    return "";
  }
}

/** One keystroke, or a paste, written to the pane's terminal as bytes. */
export async function sendInput(
  client: TerminalClient,
  paneId: string,
  data: string,
): Promise<void> {
  // Sent as text and written verbatim: what the terminal hands us is already the
  // byte sequence the process expects — an arrow key, a Ctrl chord, a paste.
  await client.call("pane.send_text", { pane_id: paneId, text: data });
}

/**
 * The id of the workspace web-created shells live in, making one if needed.
 *
 * `cwd` only seeds a workspace that does not exist yet. There is one shell
 * workspace for the whole session, so it outlives the conversation that created
 * it: its own cwd is the first conversation's, not this one's. Where a new shell
 * actually starts is decided per pane by the `cwd` handed to `pane.split`.
 */
export async function ensureShellWorkspace(
  client: TerminalClient,
  cwd: string | null,
): Promise<string | null> {
  try {
    const response = await client.call<{ workspaces?: unknown }>("workspace.list");
    const workspaces = Array.isArray(response?.workspaces) ? response.workspaces : [];
    for (const entry of workspaces) {
      const workspace = asRecord(entry);
      if (typeof workspace?.label === "string" && workspace.label === SHELL_WORKSPACE_LABEL) {
        const id = typeof workspace.workspace_id === "string" ? workspace.workspace_id : null;
        if (id) return id;
      }
    }
    const created = await client.call<{ workspace?: unknown }>("workspace.create", {
      label: SHELL_WORKSPACE_LABEL,
      focus: false,
      ...(cwd ? { cwd } : {}),
    });
    const workspace = asRecord(created?.workspace);
    return typeof workspace?.workspace_id === "string" ? workspace.workspace_id : null;
  } catch {
    return null;
  }
}

/**
 * Opens a shell, and answers with the pane it is in.
 *
 * A split of the shell workspace's own pane, which starts the configured shell —
 * the same one the TUI opens — and leaves the workspace's layout to the server
 * rather than to whatever the browser happens to be.
 *
 * The `cwd` is the caller's project path and is passed straight to the split. It
 * has to be: the shell workspace is shared, so without it the server falls back
 * to following whatever pane that workspace already holds, and a shell opened
 * from one conversation would start in another conversation's directory.
 */
export async function createShellPane(
  client: TerminalClient,
  cwd: string | null,
): Promise<string | null> {
  const workspaceId = await ensureShellWorkspace(client, cwd);
  if (!workspaceId) return null;
  try {
    const response = await client.call<{ pane?: unknown }>("pane.split", {
      workspace_id: workspaceId,
      direction: "right",
      focus: true,
      ...(cwd ? { cwd } : {}),
    });
    const pane = asRecord(response?.pane);
    return typeof pane?.pane_id === "string" ? pane.pane_id : null;
  } catch {
    return null;
  }
}
