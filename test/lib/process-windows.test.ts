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

  it("passes Windows shim arguments through an encoded launcher", async () => {
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
    const { execFileText } = await import("../../src/lib/process.js");
    await expect(
      execFileText(
        "C:\\Tools\\bl.cmd",
        ["usage", "token-plan", "--output", "json"],
        1000,
      ),
    ).resolves.toBe("ok");

    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        expect.any(String),
      ],
      {
        timeout: 1000,
        maxBuffer: 1024 * 1024,
        env: expect.objectContaining({
          QUOTA_AXI_COMMAND: "C:\\Tools\\bl.cmd",
          QUOTA_AXI_ARG_0: "usage",
          QUOTA_AXI_ARG_1: "token-plan",
          QUOTA_AXI_ARG_2: "--output",
          QUOTA_AXI_ARG_3: "json",
        }),
      },
      expect.any(Function),
    );
    const encodedCommand = execFile.mock.calls[0][1][6];
    expect(
      Buffer.from(encodedCommand, "base64").toString("utf16le"),
    ).toContain("[Environment]::GetEnvironmentVariable('QUOTA_AXI_ARG_0')");
  });

  it("preserves shell metacharacters and percent sequences", async () => {
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
    const { execFileText } = await import("../../src/lib/process.js");
    await expect(
      execFileText(
        "C:\\Tools\\bl.cmd",
        ['a"b', "C:\\path\\", "%PATH%", "a&b|c<d>e(f)", "caret^value"],
        1000,
      ),
    ).resolves.toBe("ok");

    expect(execFile).toHaveBeenCalledWith(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        expect.any(String),
      ],
      {
        timeout: 1000,
        maxBuffer: 1024 * 1024,
        env: expect.objectContaining({
          QUOTA_AXI_ARG_0: 'a"b',
          QUOTA_AXI_ARG_1: "C:\\path\\",
          QUOTA_AXI_ARG_2: "%PATH%",
          QUOTA_AXI_ARG_3: "a&b|c<d>e(f)",
          QUOTA_AXI_ARG_4: "caret^value",
        }),
      },
      expect.any(Function),
    );
  });

  it("rejects control characters instead of passing command syntax to ComSpec", async () => {
    const execFile = vi.fn();
    vi.doMock("node:child_process", () => ({ execFile }));
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    process.env.ComSpec = "C:\\Windows\\System32\\cmd.exe";

    const { execFileText } = await import("../../src/lib/process.js");

    await expect(
      execFileText("C:\\Tools\\bl.cmd", ["safe", "line\nbreak"], 1000),
    ).rejects.toThrow("Windows command arguments cannot contain controls");
    expect(execFile).not.toHaveBeenCalled();
  });
});
