import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalConfigDirs = process.env.CLAUDE_CONFIG_DIRS;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
let tempDir: string | undefined;

beforeEach(() => {
  vi.resetModules();
  Object.defineProperty(process, "platform", {
    configurable: true,
    value: "linux",
  });
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-multiseat-"));
  process.env.HOME = tempDir;
  process.env.USERPROFILE = tempDir;
  process.env.XDG_CACHE_HOME = join(tempDir, "cache");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIRS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalPlatform)
    Object.defineProperty(process, "platform", originalPlatform);
  vi.doUnmock("../../src/lib/process.js");
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
    status: 200,
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
          if (authorization.includes("fixture-token-jr"))
            throw new TypeError("seat network unavailable");
          return authorization.includes("fixture-token-arcs")
            ? headerResponse(0.25, 0.5)
            : headerResponse(0.75, 0.9);
        }
        if (String(input).endsWith("/api/oauth/usage")) {
          if (authorization.includes("fixture-token-jr"))
            throw new TypeError("seat network unavailable");
          const arcs = authorization.includes("fixture-token-arcs");
          return new Response(
            JSON.stringify({
              five_hour: { utilization: arcs ? 25 : 75 },
              seven_day: { utilization: arcs ? 50 : 90 },
            }),
            { status: 200 },
          );
        }
        if (String(input).endsWith("/api/oauth/profile"))
          return new Response(JSON.stringify({}), { status: 200 });
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
    ).toHaveLength(3);
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

  it("keeps authoritative scoped limits when header probes succeed", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(":");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/messages"))
        return headerResponse(0.1, 0.2);
      if (String(input).endsWith("/api/oauth/usage"))
        return new Response(
          JSON.stringify({
            limits: [
              {
                group: "session",
                percent: 11,
                resets_at: "2026-07-06T22:15:00Z",
              },
              {
                group: "weekly",
                percent: 22,
                resets_at: "2026-07-10T16:00:00Z",
              },
              {
                kind: "weekly",
                percent: 33,
                resets_at: "2026-07-11T09:30:00Z",
                scope: { model: { id: "fable", display_name: "Fable" } },
              },
            ],
            extra_usage: {
              is_enabled: true,
              used_credits: 5,
              monthly_limit: 20,
            },
          }),
          { status: 200 },
        );
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.windows).toContainEqual(
      expect.objectContaining({
        id: "arcs:model:fable",
        percentUsed: 33,
      }),
    );
    expect(result.windows).toContainEqual(
      expect.objectContaining({ id: "jr:extra_usage", spentUsd: 0.05 }),
    );
    expect(result.windows).not.toContainEqual(
      expect.objectContaining({ id: "arcs:five_hour", percentUsed: 10 }),
    );
  });

  it("rejects rate-limit headers from unsuccessful probes", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(":");
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      if (String(input).endsWith("/v1/messages"))
        return new Response(null, {
          status: 503,
          headers: {
            "anthropic-ratelimit-unified-5h-utilization": "0.1",
            "anthropic-ratelimit-unified-5h-reset": "1900000000",
            "anthropic-ratelimit-unified-7d-utilization": "0.2",
            "anthropic-ratelimit-unified-7d-reset": "1900604800",
          },
        });
      if (String(input).endsWith("/api/oauth/usage"))
        return new Response(
          JSON.stringify({ five_hour: { utilization: 44 } }),
          { status: 200 },
        );
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("fresh");
    expect(result.windows).toContainEqual(
      expect.objectContaining({ id: "arcs:five_hour", percentUsed: 44 }),
    );
    expect(result.windows).not.toContainEqual(
      expect.objectContaining({ id: "arcs:five_hour", percentUsed: 10 }),
    );
  });

  it("does not hide an authentication failure from the header probe", async () => {
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(":");
    const fetchMock = vi.fn(
      async (input: string | URL | Request, options?: RequestInit) => {
        const headers = options?.headers as Record<string, string> | undefined;
        const authorization = String(
          headers?.Authorization ?? headers?.authorization,
        );
        if (String(input).endsWith("/v1/messages"))
          return new Response(null, {
            status: authorization.includes("fixture-token-arcs") ? 401 : 503,
            headers: {
              "anthropic-ratelimit-unified-5h-utilization": "0.1",
              "anthropic-ratelimit-unified-5h-reset": "1900000000",
              "anthropic-ratelimit-unified-7d-utilization": "0.2",
              "anthropic-ratelimit-unified-7d-reset": "1900604800",
            },
          });
        throw new TypeError("seat network unavailable");
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: false });

    expect(result.state.status).toBe("auth_required");
    expect(result.state.error).toBe("Claude sign-in required");
    expect(
      fetchMock.mock.calls.filter(([input]) =>
        String(input).endsWith("/api/oauth/usage"),
      ),
    ).toHaveLength(1);
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
    writeCachedProviders([second]);
    fetchMock.mockClear();
    const third = await fetchQuota({ allowKeychainPrompt: false });

    expect(second.source).toBe("cache");
    expect(third.source).toBe("cache");
    expect(second.windows.map(({ id }) => id)).toEqual([
      "arcs:five_hour",
      "arcs:seven_day",
      "jr:five_hour",
      "jr:seven_day",
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps macOS Keychain credentials first for the primary seat", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "darwin",
    });
    const defaultDir = join(tempDir as string, ".claude");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    const emptySeat = join(tempDir as string, "empty");
    mkdirSync(emptySeat, { recursive: true });
    process.env.CLAUDE_CONFIG_DIRS = emptySeat;
    const execFileText = vi.fn(async () =>
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "keychain-token",
          expiresAt: "2035-01-01T00:00:00.000Z",
        },
      }),
    );
    vi.doMock("../../src/lib/process.js", () => ({ execFileText }));
    const probeTokens: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, options?: RequestInit) => {
        if (!String(input).endsWith("/v1/messages"))
          return headerResponse(0.1, 0.2);
        const headers = options?.headers as Record<string, string>;
        probeTokens.push(headers.Authorization.replace("Bearer ", ""));
        return headerResponse(0.1, 0.2);
      }),
    );

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const result = await fetchQuota({ allowKeychainPrompt: true });

    expect(result.state.status).toBe("fresh");
    expect(probeTokens).toEqual(["keychain-token"]);
  });

  it("rejects cached quota when a same-named seat is replaced", async () => {
    const firstArcs = seat("first/arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [firstArcs, jr].join(":");
    const fetchMock = vi.fn(async () => headerResponse(0.1, 0.2));
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const first = await fetchQuota({ allowKeychainPrompt: false });
    writeCachedProviders([first]);
    fetchMock.mockClear();

    const replacementArcs = seat("second/arcs");
    process.env.CLAUDE_CONFIG_DIRS = [replacementArcs, jr].join(":");
    await fetchQuota({ allowKeychainPrompt: false });

    expect(fetchMock).toHaveBeenCalled();
  });

  it("uses the Windows delimiter for configured seats", async () => {
    Object.defineProperty(process, "platform", {
      configurable: true,
      value: "win32",
    });
    const arcs = seat("arcs");
    const jr = seat("jr");
    process.env.CLAUDE_CONFIG_DIRS = [arcs, jr].join(";");

    const { resolveClaudeSeats } =
      await import("../../src/providers/claude.js");
    expect(resolveClaudeSeats().map(({ name }) => name)).toEqual([
      "arcs",
      "jr",
    ]);
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
