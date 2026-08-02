import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshOAuthJsonFile,
  type OAuthJsonRefreshOptions,
} from "../../src/lib/oauth.js";

const NOW = 1_800_000_000_000;
let temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories)
    rmSync(directory, { recursive: true, force: true });
  temporaryDirectories = [];
});

function credentialFile(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-oauth-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "auth.json");
  writeFileSync(path, JSON.stringify({ refresh_token: "refresh" }), {
    mode: 0o600,
  });
  return path;
}

function refreshOptions(
  filePath: string,
  fetch: typeof globalThis.fetch,
  overrides: Partial<OAuthJsonRefreshOptions> = {},
): OAuthJsonRefreshOptions {
  return {
    filePath,
    tokenUrl: "https://auth.invalid/token",
    clientId: "client",
    fetch,
    now: () => NOW,
    readRefreshToken: (document) => {
      if (
        document === null ||
        typeof document !== "object" ||
        Array.isArray(document)
      )
        return undefined;
      const record = document as Record<string, unknown>;
      return typeof record.refresh_token === "string"
        ? record.refresh_token
        : undefined;
    },
    updateDocument: (document, token) => ({
      ...(typeof document === "object" && document !== null
        ? document
        : {}),
      access_token: token.accessToken,
      expires_at: token.expiresAtMs,
    }),
    ...overrides,
  };
}

describe("OAuth refresh helper", () => {
  it("rejects non-finite and insufficiently fresh expiry values", async () => {
    const cases = [
      JSON.stringify({ access_token: "fresh", expires_in: "1e309" }),
      JSON.stringify({ access_token: "fresh", expires_in: 10 }),
    ];
    for (const body of cases) {
      const path = credentialFile();
      const before = readFileSync(path);
      const fetch = vi.fn(async () => new Response(body, { status: 200 }));

      await expect(
        refreshOAuthJsonFile(
          refreshOptions(path, fetch, { minimumFreshnessMs: 30_000 }),
        ),
      ).rejects.toMatchObject({ code: "invalid_response" });
      expect(readFileSync(path)).toEqual(before);
      expect(existsSync(`${path}.quota-axi.lock`)).toBe(false);
    }
  });

  it("recovers a lock owned by a dead process", async () => {
    const path = credentialFile();
    writeFileSync(
      `${path}.quota-axi.lock`,
      JSON.stringify({
        pid: 999_999_999,
        token: "stale-lock",
        createdAtMs: NOW,
      }),
      { mode: 0o600 },
    );
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", expires_in: 900 }),
          { status: 200 },
        ),
    );

    await expect(
      refreshOAuthJsonFile(refreshOptions(path, fetch)),
    ).resolves.toMatchObject({ accessToken: "fresh" });
    expect(existsSync(`${path}.quota-axi.lock`)).toBe(false);
  });

  it("reclaims a malformed legacy lock marker", async () => {
    const path = credentialFile();
    writeFileSync(`${path}.quota-axi.lock`, "");
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ access_token: "fresh", expires_in: 900 }),
          { status: 200 },
        ),
    );

    await expect(
      refreshOAuthJsonFile(refreshOptions(path, fetch)),
    ).resolves.toMatchObject({ accessToken: "fresh" });
    expect(existsSync(`${path}.quota-axi.lock`)).toBe(false);
  });

  it("bounds oversized OAuth response bodies", async () => {
    const path = credentialFile();
    const fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(64 * 1024 + 1));
              controller.close();
            },
          }),
          { status: 200 },
        ),
    );

    await expect(
      refreshOAuthJsonFile(refreshOptions(path, fetch)),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(existsSync(`${path}.quota-axi.lock`)).toBe(false);
  });
});
