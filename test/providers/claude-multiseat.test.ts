import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalConfigDirs = process.env.CLAUDE_CONFIG_DIRS;
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-multiseat-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIRS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir;
  if (originalConfigDirs === undefined) delete process.env.CLAUDE_CONFIG_DIRS;
  else process.env.CLAUDE_CONFIG_DIRS = originalConfigDirs;
  if (originalXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = originalXdgCacheHome;
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function seat(name: string, token = `fixture-token-${name}`): string {
  const dir = join(tempDir as string, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, ".credentials.json"),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: token,
        expiresAt: "2035-01-01T00:00:00.000Z",
      },
    }),
  );
  return dir;
}

function headerResponse(fiveHour: number, sevenDay: number): Response {
  return new Response(null, {
    status: 429,
    headers: {
      "anthropic-ratelimit-unified-5h-utilization": String(fiveHour),
      "anthropic-ratelimit-unified-5h-reset": "1900000000",
      "anthropic-ratelimit-unified-5h-status": "allowed",
      "anthropic-ratelimit-unified-7d-utilization": String(sevenDay),
      "anthropic-ratelimit-unified-7d-reset": "1900604800",
      "anthropic-ratelimit-unified-7d-status": "allowed",
    },
  });
}

describe("Claude multi-seat quota", () => {
  it("discovers configured seats, probes headers, and isolates one failed seat", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    const nyu = seat("nyu");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr, nyu].join(":");
    let active = 0;
    let maxActive = 0;
    const fetchMock = vi.fn(
      async (input: string | URL | Request, options?: RequestInit) => {
        const headers = options?.headers as Record<string, string> | undefined;
        const authorization = String(
          headers?.Authorization ?? headers?.authorization,
        );
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (authorization.includes("fixture-token-jr")) {
          throw new TypeError("seat network unavailable");
        }
        if (String(input).endsWith("/v1/messages")) {
          return authorization.includes("fixture-token-arcs")
            ? headerResponse(0.25, 0.5)
            : headerResponse(0.75, 0.9);
        }
        throw new TypeError("unexpected fallback");
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(result.state.status).toBe("fresh");
    expect(result.windows).toMatchObject([
      { id: "arcs:five_hour", percentUsed: 25, percentRemaining: 75 },
      { id: "arcs:seven_day", percentUsed: 50, percentRemaining: 50 },
      { id: "nyu:five_hour", percentUsed: 75, percentRemaining: 25 },
      { id: "nyu:seven_day", percentUsed: 90, percentRemaining: 10 },
    ]);
    expect(result.windows.some(({ id }) => id.startsWith("jr:"))).toBe(false);
    expect(result.attempts).toContainEqual({
      source: "claude:jr",
      status: "failed",
      error: "seat network unavailable",
    });
    expect(JSON.stringify(result)).not.toContain("fixture-token");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/oauth/usage"),
      ),
    ).toHaveLength(1);
  });

  it("falls back to OAuth usage when probe headers are unavailable", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(":");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/messages"))
        return new Response(null, { status: 200 });
      if (String(input).endsWith("/api/oauth/usage")) {
        return new Response(
          JSON.stringify({
            five_hour: { utilization: 12 },
            seven_day: { utilization: 34 },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          account: { uuid: "11111111-2222-4333-8444-555555555555" },
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.windows).toContainEqual(
      expect.objectContaining({ id: "arcs:five_hour", percentUsed: 12 }),
    );
    expect(result.windows).toContainEqual(
      expect.objectContaining({ id: "jr:five_hour", percentUsed: 12 }),
    );
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/oauth/usage"),
      ),
    ).toHaveLength(2);
  });

  it("reuses a matching multi-seat snapshot for the short cache window", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(":");
    const fetchMock = vi.fn(async () => headerResponse(0.1, 0.2));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const first = await fetchQuota({ allowKeychainPrompt: false });
    writeCachedProviders([first]);
    fetchMock.mockClear();

    const second = await fetchQuota({ allowKeychainPrompt: false });

    expect(second.source).toBe("cache");
    expect(second.windows.map(({ id }) => id)).toEqual([
      "arcs:five_hour",
      "arcs:seven_day",
      "jr:five_hour",
      "jr:seven_day",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the default profile as the primary seat when configured seats are added", async () => {
    const defaultDir = join(tempDir as string, ".claude");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "default-token" } }),
    );
    const house = seat("arcs");
    process.env.CLAUDE_CONFIG_DIRS = house;

    const { resolveClaudeSeats } =
      await import("../../src/providers/claude.js");
    expect(resolveClaudeSeats().map(({ name }) => name)).toEqual([
      "default",
      "arcs",
    ]);
  });
});
