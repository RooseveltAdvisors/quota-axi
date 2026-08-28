import { afterEach, describe, expect, it, vi } from "vitest";

const originalComSpec = process.env.ComSpec;

describe("execFileText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:child_process");
    vi.resetModules();
    if (originalComSpec === undefined) delete process.env.ComSpec;
    else process.env.ComSpec = originalComSpec;
  });

  it("runs Windows command shims through ComSpec without enabling shell mode", async () => {
    const execFile = vi.fn(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => callback(null, "ok"),
    );
    vi.doMock("node:child_process", () => ({ execFile }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

    const { execFileText } = await import("../../src/lib/process.js");
    await expect(
      execFileText("C:\\Tools\\bl.cmd", ["usage", "token-plan"], 1000),
    ).resolves.toBe("ok");

    expect(execFile).toHaveBeenCalledWith(
      "C:\\Windows\\System32\\cmd.exe",
      ["/d", "/s", "/c", '"C:\\Tools\\bl.cmd" "usage" "token-plan"'],
      { timeout: 1000, maxBuffer: 1024 * 1024 },
      expect.any(Function),
    );
  });
});
