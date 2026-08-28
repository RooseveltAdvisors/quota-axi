import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAlibabaAdapter,
  extractAlibabaCredential,
  normalizeAlibabaPayload,
  resolveAlibabaCredential,
} from "../../src/providers/alibaba.js";

const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const KEY = "synthetic-alibaba-key-42";
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

describe("Alibaba provider", () => {
  it("discovers the Pi alibaba-plan credential without exposing it", () => {
    const path = "/synthetic/.pi/agent/auth.json";
    expect(
      extractAlibabaCredential(
        { "alibaba-plan": { type: "oauth", access: KEY } },
        path,
      ),
    ).toEqual({ status: "available", key: KEY, path });
    expect(
      extractAlibabaCredential(
        { "alibaba-plan": { access: "${ALIBABA_KEY}" } },
        path,
      ).status,
    ).toBe("invalid");
  });

  it("reads credential discovery from the standard Pi auth path", () => {
    tempDir = mkdtempSync(join(tmpdir(), "quota-axi-alibaba-"));
    const path = join(tempDir, "auth.json");
    writeFileSync(path, JSON.stringify({ "alibaba-plan": { access: KEY } }));
    expect(resolveAlibabaCredential(path)).toEqual({
      status: "available",
      key: KEY,
      path,
    });
  });

  it("queries DashScope and normalizes the seven-day window", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            planName: "Coding Plan Pro",
            usage: {
              weekly: { percentUsed: 37, resetsAt: "2026-09-03T00:00:00Z" },
            },
          }),
          { status: 200 },
        ),
    );
    const report = await createAlibabaAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: request,
      now: () => Date.parse("2026-08-28T00:00:00Z"),
    }).fetchQuota(OPTIONS);

    expect(request).toHaveBeenCalledTimes(1);
    expect(String(request.mock.calls[0][0])).toBe(
      "https://dashscope-intl.aliyuncs.com/api/v1/models/limits",
    );
    expect(
      new Headers(request.mock.calls[0][1]?.headers).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(report).toMatchObject({
      provider: "alibaba",
      plan: "Coding Plan Pro",
      source: "api",
      windows: [
        {
          id: "weekly",
          label: "week",
          kind: "weekly",
          percentUsed: 37,
          percentRemaining: 63,
          resetsAt: "2026-09-03T00:00:00.000Z",
        },
      ],
      state: { status: "fresh", stale: false },
    });
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("accepts DashScope model quota records when they include usage", () => {
    expect(
      normalizeAlibabaPayload({
        plan: "DashScope",
        output: {
          quotas: [
            {
              model: "qwen3-max",
              model_limit: {
                usage_limit: 1000,
                usage_limit_period: 604800,
                usage: 250,
                nextResetTime: 1_790_000_000,
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      plan: "DashScope",
      windows: [
        {
          id: "weekly",
          kind: "weekly",
          percentRemaining: 75,
        },
      ],
    });
  });

  it("maps rejected credentials and malformed responses to safe errors", async () => {
    const report = await createAlibabaAdapter({
      credential: () => ({ status: "available", key: KEY, path: "/auth.json" }),
      fetch: vi.fn(
        async () => new Response("provider secret", { status: 401 }),
      ),
    }).fetchQuota(OPTIONS);
    expect(report.state).toMatchObject({
      status: "auth_required",
      error: "provider_auth_rejected",
    });
    expect(JSON.stringify(report)).not.toContain("provider secret");
    expect(
      normalizeAlibabaPayload({ plan: "active", usage: {} }).windows,
    ).toEqual([]);
  });
});
