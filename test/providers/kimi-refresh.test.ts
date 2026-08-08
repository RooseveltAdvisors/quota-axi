import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createKimiAdapter } from "../../src/providers/kimi.js";

const NOW = Date.parse("2027-02-03T04:05:06.000Z");
const TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const QUOTA_URL = "https://api.kimi.com/coding/v1/usages";
const originalHome = process.env.HOME;
const originalPiDirectory = process.env.PI_CODING_AGENT_DIR;
let tempDir: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-kimi-refresh-"));
  process.env.HOME = tempDir;
  process.env.PI_CODING_AGENT_DIR = join(tempDir, "pi-agent");
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalPiDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalPiDirectory;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writePiCredential(value: Record<string, unknown>): string {
  const path = join(process.env.PI_CODING_AGENT_DIR!, "auth.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify({ "kimi-coding": value }), {
    mode: 0o600,
  });
  return path;
}

function quotaResponse(): Response {
  return new Response(
    JSON.stringify({
      usage: {
        limit: 100,
        used: 20,
        resetTime: "2099-01-08T00:00:00Z",
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

describe("Kimi renew-on-read", () => {
  it("renews before quota and uses the fresh access token", async () => {
    const authPath = writePiCredential({
      type: "oauth",
      access: "synthetic-kimi-expired-026",
      refresh: "synthetic-kimi-refresh-027",
      expires: Date.now() - 1,
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === TOKEN_URL) {
        return new Response(
          JSON.stringify({
            access_token: "synthetic-kimi-fresh-028",
            refresh_token: "synthetic-kimi-refresh-rotated-029",
            expires_in: 900,
          }),
          { status: 200 },
        );
      }
      expect(String(input)).toBe(QUOTA_URL);
      return quotaResponse();
    });
    const adapter = createKimiAdapter({
      fetch: fetchMock,
      now: () => NOW,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });
    const stored = JSON.parse(readFileSync(authPath, "utf8")) as Record<
      string,
      Record<string, unknown>
    >;

    expect(result.state.status).toBe("fresh");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization"),
    ).toBe("Bearer synthetic-kimi-fresh-028");
    expect(stored["kimi-coding"]).toMatchObject({
      access: "synthetic-kimi-fresh-028",
      refresh: "synthetic-kimi-refresh-rotated-029",
      expires: expect.any(Number),
    });
    expect(stored["kimi-coding"].expires).toBeGreaterThan(Date.now());
    expect(JSON.stringify(result)).not.toContain("synthetic-kimi-refresh");
  });

  it("reports invalid_grant without calling quota or half-writing auth", async () => {
    const authPath = writePiCredential({
      type: "oauth",
      access: "synthetic-kimi-expired-030",
      refresh: "synthetic-kimi-refresh-invalid-031",
      expires: Date.now() - 1,
    });
    const before = readFileSync(authPath);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    );
    const adapter = createKimiAdapter({
      fetch: fetchMock,
      now: () => NOW,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result.state).toMatchObject({
      status: "auth_required",
      error: "kimi_credential_refresh_failed",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(authPath)).toEqual(before);
    expect(JSON.stringify(result)).not.toContain("synthetic-kimi-refresh");
  });

  it("uses cached quota when OAuth refresh is transiently unavailable", async () => {
    writePiCredential({
      type: "oauth",
      access: "synthetic-kimi-expired-transient-034",
      refresh: "synthetic-kimi-refresh-transient-035",
      expires: Date.now() - 1,
    });
    const deleteCachedProvider = vi.fn();
    const fetchMock = vi.fn(async () => Promise.reject(new Error("offline")));
    const adapter = createKimiAdapter({
      fetch: fetchMock,
      now: () => NOW,
      readCachedProvider: () => ({
        provider: "kimi",
        label: "Kimi",
        source: "api",
        windows: [
          {
            id: "five_hour",
            label: "session",
            kind: "session",
            percentUsed: 20,
            percentRemaining: 80,
            resetsAt: "2099-01-08T00:00:00Z",
          },
        ],
        state: {
          status: "fresh",
          stale: false,
          refreshedAt: new Date(NOW - 1_000).toISOString(),
          sourcesTried: ["api"],
        },
      }),
      deleteCachedProvider,
    });

    const result = await adapter.fetchQuota({ allowKeychainPrompt: false });

    expect(result).toMatchObject({
      source: "cache",
      state: { status: "stale", stale: true },
    });
    expect(deleteCachedProvider).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps read-only mode from refreshing or writing auth", async () => {
    const authPath = writePiCredential({
      type: "oauth",
      access: "synthetic-kimi-expired-032",
      refresh: "synthetic-kimi-refresh-disabled-033",
      expires: Date.now() - 1,
    });
    const before = readFileSync(authPath);
    const fetchMock = vi.fn();
    const adapter = createKimiAdapter({
      fetch: fetchMock,
      now: () => NOW,
      readCachedProvider: () => undefined,
      deleteCachedProvider: () => undefined,
    });

    const result = await adapter.fetchQuota({
      allowKeychainPrompt: false,
      refreshCredentials: false,
    });

    expect(result.state.status).toBe("auth_required");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(authPath)).toEqual(before);
  });
});
