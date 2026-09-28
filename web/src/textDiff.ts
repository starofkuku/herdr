/*
 * A line diff, ported from ZCode's own implementation (its shared
 * `computeLineChangeStat` and `toolDiffPreview`): trim the lines the two sides
 * share at the top and bottom, diff the middle with an LCS, and report the
 * counts that differ. Porting it whole — rather than counting both blocks —
 * is what makes an edit that changes three lines read as +3 -3 instead of as
 * the size of the blocks it was cut from.
 *
 * Above a size threshold an LCS would stall the page, so the middle falls back
 * to counting both blocks, exactly as the original does.
 */

const MAX_LCS_CELLS = 400_000;

/** Longest diff the row renders; past this the tail is summarised. */
const MAX_DIFF_ROWS = 500;

export interface LineChangeStat {
  added: number;
  removed: number;
}

export interface DiffRow {
  kind: "context" | "add" | "remove";
  text: string;
}

export interface LineDiff {
  rows: DiffRow[];
  stat: LineChangeStat;
  /** Lines not rendered because the diff was longer than `MAX_DIFF_ROWS`. */
  omitted: number;
}

function splitLines(content: string | null | undefined): string[] {
  if (!content) return [];
  const lines = content.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * The rows and counts of changing `before` into `after`.
 *
 * `before` may be null for a file that is being created, which is all-added.
 */
export function lineDiff(before: string | null | undefined, after: string): LineDiff {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);

  // The shared head and tail are context, never changes.
  let head = 0;
  while (
    head < beforeLines.length &&
    head < afterLines.length &&
    beforeLines[head] === afterLines[head]
  ) {
    head += 1;
  }
  let beforeTail = beforeLines.length - 1;
  let afterTail = afterLines.length - 1;
  while (
    beforeTail >= head &&
    afterTail >= head &&
    beforeLines[beforeTail] === afterLines[afterTail]
  ) {
    beforeTail -= 1;
    afterTail -= 1;
  }
  const trimmedBefore = beforeLines.slice(head, beforeTail + 1);
  const trimmedAfter = afterLines.slice(head, afterTail + 1);

  let middle: DiffRow[];
  let stat: LineChangeStat;

  if (trimmedBefore.length === 0) {
    stat = { added: trimmedAfter.length, removed: 0 };
    middle = trimmedAfter.map((text) => ({ kind: "add" as const, text }));
  } else if (trimmedAfter.length === 0) {
    stat = { added: 0, removed: trimmedBefore.length };
    middle = trimmedBefore.map((text) => ({ kind: "remove" as const, text }));
  } else if (trimmedBefore.length * trimmedAfter.length > MAX_LCS_CELLS) {
    // Too large to diff without a stall; both blocks count as changed.
    stat = { added: trimmedAfter.length, removed: trimmedBefore.length };
    middle = [
      ...trimmedBefore.map((text) => ({ kind: "remove" as const, text })),
      ...trimmedAfter.map((text) => ({ kind: "add" as const, text })),
    ];
  } else {
    // One rolling row of the LCS table, then a second pass rebuilt for the
    // walk — the walk needs the whole table, so it is materialised once.
    const rows = trimmedBefore.length + 1;
    const columns = trimmedAfter.length + 1;
    const table: number[][] = Array.from({ length: rows }, () => new Array<number>(columns).fill(0));
    for (let i = 1; i < rows; i += 1) {
      for (let j = 1; j < columns; j += 1) {
        table[i][j] =
          trimmedBefore[i - 1] === trimmedAfter[j - 1]
            ? table[i - 1][j - 1] + 1
            : Math.max(table[i - 1][j], table[i][j - 1]);
      }
    }
    const unchanged = table[rows - 1][columns - 1];
    stat = {
      added: trimmedAfter.length - unchanged,
      removed: trimmedBefore.length - unchanged,
    };
    // Walk from the end so the rows come out in reading order.
    middle = [];
    let i = rows - 1;
    let j = columns - 1;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && trimmedBefore[i - 1] === trimmedAfter[j - 1]) {
        middle.push({ kind: "context", text: trimmedBefore[i - 1] });
        i -= 1;
        j -= 1;
      } else if (j > 0 && (i === 0 || table[i][j - 1] >= table[i - 1][j])) {
        middle.push({ kind: "add", text: trimmedAfter[j - 1] });
        j -= 1;
      } else {
        middle.push({ kind: "remove", text: trimmedBefore[i - 1] });
        i -= 1;
      }
    }
    middle.reverse();
  }

  const contextBefore: DiffRow[] = beforeLines
    .slice(0, head)
    .map((text) => ({ kind: "context" as const, text }));
  const contextAfter: DiffRow[] = beforeLines
    .slice(beforeTail + 1)
    .map((text) => ({ kind: "context" as const, text }));
  const rows_ = [...contextBefore, ...middle, ...contextAfter];

  if (rows_.length <= MAX_DIFF_ROWS) {
    return { rows: rows_, stat, omitted: 0 };
  }
  const kept = rows_.slice(0, MAX_DIFF_ROWS);
  return { rows: kept, stat, omitted: rows_.length - kept.length };
}
