import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

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
    const launcherDirectory = await mkdtemp(
      path.join(tmpdir(), "quota-axi-powershell-"),
    );
    const launcherPath = path.join(launcherDirectory, "powershell.exe");
    const originalPath = process.env.PATH;
    await writeFile(
      launcherPath,
      `#!/usr/bin/env node
const encodedIndex = process.argv.indexOf("-EncodedCommand") + 1;
const script = Buffer.from(process.argv[encodedIndex], "base64").toString("utf16le");
const names = [...script.matchAll(/GetEnvironmentVariable\\('([^']+)'\\)/g)].map((match) => match[1]);
process.stdout.write(JSON.stringify(names.map((name) => process.env[name])));
`,
    );
    await chmod(launcherPath, 0o755);
    process.env.PATH = `${launcherDirectory}${path.delimiter}${originalPath ?? ""}`;
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    try {
      const { execFileText } = await import("../../src/lib/process.js");
      await expect(
        execFileText(
          "C:\\Tools\\bl.cmd",
          ["usage", "token-plan", "--output", "json"],
          1000,
        ),
      ).resolves.toBe(
        JSON.stringify([
          "C:\\Tools\\bl.cmd",
          "usage",
          "token-plan",
          "--output",
          "json",
        ]),
      );
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      await rm(launcherDirectory, { recursive: true, force: true });
    }
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
