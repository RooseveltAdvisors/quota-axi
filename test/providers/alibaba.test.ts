import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAlibabaAdapter,
  normalizeAlibabaUsage,
} from "../../src/providers/alibaba.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const originalPath = process.env.PATH;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-alibaba-"));
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("Alibaba bl usage provider", () => {
  it("runs the official bl command and normalizes fixture windows", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, readFixture());
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(readFileSync(argsFile, "utf8").trim().split("\n")).toEqual([
      "usage",
      "summary",
      "--days",
      "1",
      "--output",
      "json",
    ]);
    expect(report).toMatchObject({
      provider: "alibaba",
      label: "Alibaba Coding Plan",
      source: "cli",
      plan: "Alibaba Coding Plan Pro",
      state: {
        status: "fresh",
        stale: false,
        sourcesTried: ["bl-cli"],
      },
      attempts: [{ source: "bl-cli", status: "success" }],
    });
    expect(report.windows).toEqual([
      {
        id: "model:qwen3.8-max",
        label: "qwen3.8-max",
        kind: "model",
        percentUsed: 25,
        percentRemaining: 75,
        resetsAt: "2026-10-31T00:00:00.000Z",
      },
      {
        id: "model:kimi-k3",
        label: "kimi-k3",
        kind: "model",
        percentUsed: 75,
        percentRemaining: 25,
        resetsAt: "2026-11-16T00:00:00.000Z",
      },
    ]);
  });

  it("accepts remaining and total when remainingPercent is absent", () => {
    expect(
      normalizeAlibabaUsage({
        plan: "Coding Plan",
        freeTier: [
          {
            model: "fixture-model",
            remaining: 2,
            total: 8,
            resetAt: 1_800_000_000,
          },
        ],
      }),
    ).toEqual({
      plan: "Coding Plan",
      windows: [
        {
          id: "model:fixture-model",
          label: "fixture-model",
          kind: "model",
          percentUsed: 75,
          percentRemaining: 25,
          resetsAt: "2027-01-15T08:00:00.000Z",
        },
      ],
    });
  });

  it("reports unavailable when bl is not on PATH", async () => {
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report).toMatchObject({
      provider: "alibaba",
      source: "unavailable",
      windows: [],
      state: { status: "unavailable", error: "bl_cli_unavailable" },
      attempts: [
        { source: "bl-cli", status: "skipped", error: "bl_cli_unavailable" },
      ],
    });
  });

  it("reports a failed CLI without throwing", async () => {
    const argsFile = join(tempDir, "args");
    installMockBl(argsFile, "not used", true);
    process.env.PATH = tempDir;

    const report = await createAlibabaAdapter().fetchQuota(OPTIONS);

    expect(report.windows).toEqual([]);
    expect(report.state.status).toBe("error");
    expect(report.attempts?.[0]?.status).toBe("failed");
  });
});

function readFixture(): string {
  return readFileSync(
    join(process.cwd(), "test/fixtures/alibaba/usage-summary.json"),
    "utf8",
  );
}

function installMockBl(argsFile: string, output: string, fail = false): void {
  const script = join(tempDir, "bl");
  const shellQuote = (value: string): string =>
    `'${value.replaceAll("'", "'\\''")}'`;
  writeFileSync(
    script,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$@" > ${shellQuote(argsFile)}`,
      fail ? "exit 7" : `printf '%s' ${shellQuote(output)}`,
      "",
    ].join("\n"),
  );
  chmodSync(script, 0o755);
}
