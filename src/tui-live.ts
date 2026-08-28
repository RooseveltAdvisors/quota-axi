/**
 * Live loop for the human terminal report: paint a frame, then repaint on a
 * fixed refresh interval until the operator quits with `q` or Ctrl+C. Every
 * terminal effect is injected so the loop is exercised without a real TTY, and
 * the alternate screen, cursor, and raw mode are always restored - including
 * when a refresh throws. This is presentation only; it derives nothing new.
 */

export type LiveTuiWriter = {
  write(chunk: string): unknown;
  /** Terminal height in rows, when available. */
  readonly rows?: number;
};

export type LiveTuiInput = {
  setRawMode?(mode: boolean): unknown;
  resume?(): unknown;
  pause?(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export type LiveTuiIo = {
  stdout: LiveTuiWriter;
  stdin: LiveTuiInput;
  setTimer(callback: () => void, milliseconds: number): unknown;
  clearTimer(handle: unknown): void;
  /** Subscribe to terminal resize; returns the unsubscribe function. */
  onResize?(listener: () => void): () => void;
  /** Subscribe to termination signals; returns the unsubscribe function. */
  onSignal?(listener: () => void): () => void;
};

export type LiveTuiOptions<T> = {
  /** Refresh the report. Bounded by the caller, not by this loop. */
  load(): Promise<T>;
  /** Render the current snapshot at the current terminal width. */
  render(value: T): string;
  intervalMillis: number;
  io: LiveTuiIo;
};

const ENTER_SCREEN = "\x1b[?1049h\x1b[?25l";
const LEAVE_SCREEN = "\x1b[?25h\x1b[?1049l";
const CLEAR_SCREEN = "\x1b[H\x1b[2J";

type WakeReason = "tick" | "resize" | "scroll" | "quit";
export type LiveTuiScrollAction = "up" | "down" | "pageUp" | "pageDown";

const SCROLL_HINT = "↕ j/k scroll";
const SCROLL_KEYS: ReadonlyArray<readonly [string, LiveTuiScrollAction]> = [
  ["j", "down"],
  ["k", "up"],
  ["\x1b[B", "down"],
  ["\x1b[A", "up"],
  ["\x04", "pageDown"],
  ["\x15", "pageUp"],
  ["\x1b[6~", "pageDown"],
  ["\x1b[5~", "pageUp"],
];

/** Decode complete raw-mode keys, retaining an incomplete escape sequence. */
export function decodeLiveTuiInput(input: string): {
  actions: LiveTuiScrollAction[];
  quit: boolean;
  remainder: string;
} {
  const actions: LiveTuiScrollAction[] = [];
  let quit = false;
  let index = 0;
  while (index < input.length) {
    const remaining = input.slice(index);
    const match = SCROLL_KEYS.find(([key]) => remaining.startsWith(key));
    if (match) {
      actions.push(match[1]);
      index += match[0].length;
      continue;
    }
    const isPartialEscape = SCROLL_KEYS.some(
      ([key]) => key.startsWith(remaining) && remaining.length < key.length,
    );
    if (isPartialEscape) break;
    const character = input[index];
    if (character === "q" || character === "Q" || character === "\x03") {
      quit = true;
    }
    index += 1;
  }
  return { actions, quit, remainder: input.slice(index) };
}

export type LiveTuiViewport = {
  text: string;
  offset: number;
  maxOffset: number;
  height: number;
};

/** Clip a rendered frame to the terminal and retain a bounded scroll offset. */
export function renderLiveTuiViewport(
  frame: string,
  requestedOffset: number,
  terminalRows?: number,
): LiveTuiViewport {
  const lines = frame.split("\n");
  const height =
    terminalRows !== undefined && terminalRows > 0
      ? Math.floor(terminalRows)
      : lines.length;
  const maxOffset = Math.max(0, lines.length - height);
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(requestedOffset)));
  const visible = lines.slice(offset, offset + height);
  if (offset > 0 && visible.length > 0) {
    visible[0] = `${SCROLL_HINT}  ${visible[0]}`;
  }
  return { text: visible.join("\n"), offset, maxOffset, height };
}

/**
 * Run the live report until the operator quits, and return the last snapshot
 * that was painted so the caller can echo a final frame on the normal screen.
 */
export async function runLiveTui<T>({
  load,
  render,
  intervalMillis,
  io,
}: LiveTuiOptions<T>): Promise<T | undefined> {
  let quit = false;
  let scrollOffset = 0;
  let inputBuffer = "";
  let wake: ((reason: WakeReason) => void) | undefined;
  // Resize bursts coalesce: every wake-up repaints at the current terminal
  // width, so an event that lands with no waiter armed is already covered by
  // the next paint rather than needing its own frame.
  const notify = (reason: WakeReason): void => {
    const pending = wake;
    wake = undefined;
    pending?.(reason);
  };
  const requestQuit = (): void => {
    quit = true;
    notify("quit");
  };
  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    const decoded = decodeLiveTuiInput(inputBuffer + text);
    inputBuffer = decoded.remainder;
    if (decoded.quit) requestQuit();
    if (decoded.actions.length === 0 || quit) return;
    for (const action of decoded.actions) {
      const halfPage = Math.max(
        1,
        Math.floor((io.stdout.rows ?? Number.MAX_SAFE_INTEGER) / 2),
      );
      scrollOffset +=
        action === "up"
          ? -1
          : action === "down"
            ? 1
            : action === "pageUp"
              ? -halfPage
              : halfPage;
    }
    notify("scroll");
  };

  const stopResize = io.onResize?.(() => {
    scrollOffset = 0;
    notify("resize");
  });
  const stopSignal = io.onSignal?.(requestQuit);
  io.stdin.on("data", onData);
  io.stdin.setRawMode?.(true);
  io.stdin.resume?.();
  io.stdout.write(ENTER_SCREEN);

  let value: T | undefined;
  try {
    while (!quit) {
      if (value === undefined) io.stdout.write(`${CLEAR_SCREEN}\n  loading…\n`);
      value = await load();
      if (quit) break;
      const snapshot = value;
      const paint = (): void => {
        const viewport = renderLiveTuiViewport(
          render(snapshot),
          scrollOffset,
          io.stdout.rows,
        );
        scrollOffset = viewport.offset;
        io.stdout.write(`${CLEAR_SCREEN}${viewport.text}\n`);
      };
      paint();

      let ticked = false;
      const handle = io.setTimer(() => {
        ticked = true;
        notify("tick");
      }, intervalMillis);
      try {
        while (!quit && !ticked) {
          const reason = await new Promise<WakeReason>((resolve) => {
            wake = resolve;
          });
          if (reason !== "resize" && reason !== "scroll") break;
          paint();
        }
      } finally {
        wake = undefined;
        io.clearTimer(handle);
      }
    }
  } finally {
    io.stdout.write(LEAVE_SCREEN);
    io.stdin.off("data", onData);
    io.stdin.setRawMode?.(false);
    io.stdin.pause?.();
    stopResize?.();
    stopSignal?.();
  }
  return value;
}

/** Render a whole-unit refresh interval as "45s", "5m", or "2h". */
export function formatInterval(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}
