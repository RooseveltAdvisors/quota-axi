import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createKimiCodeCliCredentialSource } from "../../src/providers/kimi-code-cli-credential.js";

const NOW = 1_800_000_000_000;
let temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories) {
    rmSync(directory, { recursive: true, force: true });
  }
  temporaryDirectories = [];
});

describe("Kimi Code CLI credential discovery", () => {
  it("reads the official default location under HOME", async () => {
    const home = temporaryDirectory();
    writeCredential(join(home, ".kimi-code"), {
      access_token: "default-home-token",
      refresh_token: "ignored-refresh-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: home },
      homeDirectory: () => "/unused-system-home",
      now: () => NOW,
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "default-home-token",
    });
  });

  it("prefers KIMI_CODE_HOME over the default home", async () => {
    const home = temporaryDirectory();
    const override = temporaryDirectory();
    writeCredential(join(home, ".kimi-code"), {
      access_token: "wrong-default-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    writeCredential(override, {
      access_token: "override-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: home, KIMI_CODE_HOME: override },
      now: () => NOW,
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "override-token",
    });
  });

  it("distinguishes missing, malformed, expired, and near-expiry credentials", async () => {
    const cases: Array<{
      payload?: unknown;
      raw?: string;
      status: "missing" | "invalid" | "expired";
    }> = [
      { status: "missing" },
      { raw: "{not-json", status: "invalid" },
      { payload: [], status: "invalid" },
      {
        payload: { access_token: "", expires_at: NOW / 1_000 + 3_600 },
        status: "invalid",
      },
      { payload: { access_token: "token" }, status: "invalid" },
      {
        payload: { access_token: "token", expires_at: "not-an-expiry" },
        status: "invalid",
      },
      {
        payload: { access_token: "token", expires_at: NOW / 1_000 - 1 },
        status: "expired",
      },
      {
        payload: { access_token: "token", expires_at: NOW / 1_000 + 60 },
        status: "expired",
      },
    ];

    for (const fixture of cases) {
      const home = temporaryDirectory();
      if (fixture.raw !== undefined) writeCredentialRaw(home, fixture.raw);
      else if (fixture.payload !== undefined)
        writeCredential(home, fixture.payload);
      const source = createKimiCodeCliCredentialSource({
        environment: { KIMI_CODE_HOME: home },
        now: () => NOW,
      });

      await expect(source.resolve()).resolves.toEqual({
        status: fixture.status,
      });
      await expect(source.inspect()).resolves.toBe(fixture.status);
    }
  });

  it.each([
    NOW / 1_000 + 3_600.5,
    String(NOW / 1_000 + 3_600),
    `+${NOW / 1_000 + 3_600}`,
    "1.8000036e9",
  ])("accepts official numeric expiry encoding %s", async (expiresAt) => {
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: "/synthetic-home" },
      now: () => NOW,
      readFile: vi.fn(async () =>
        Buffer.from(
          JSON.stringify({
            access_token: "fresh-token",
            refresh_token: { deliberately: "not consumed" },
            expires_at: expiresAt,
          }),
        ),
      ),
    });

    await expect(source.resolve()).resolves.toEqual({
      status: "available",
      accessToken: "fresh-token",
    });
  });

  it("renews an expired credential and atomically stores rotated tokens", async () => {
    const home = temporaryDirectory();
    const refreshToken = "synthetic-kimi-cli-refresh-012";
    const credential = writeCredential(home, {
      access_token: "synthetic-kimi-cli-expired-013",
      refresh_token: refreshToken,
      expires_at: NOW / 1_000 - 1,
    });
    const rotatedRefreshToken = "synthetic-kimi-cli-refresh-rotated-014";
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe("https://auth.kimi.com/api/oauth/token");
        expect(init?.method).toBe("POST");
        expect(
          new URLSearchParams(String(init?.body)).get("refresh_token"),
        ).toBe(refreshToken);
        return new Response(
          JSON.stringify({
            access_token: "synthetic-kimi-cli-fresh-015",
            refresh_token: rotatedRefreshToken,
            expires_in: 900,
          }),
          { status: 200 },
        );
      },
    );
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: home },
      now: () => NOW,
    });

    const resolution = await source.resolve({
      refresh: true,
      fetch: fetchMock,
    });
    const stored = JSON.parse(readFileSync(credential, "utf8")) as Record<
      string,
      string | number
    >;

    expect(resolution).toEqual({
      status: "available",
      accessToken: "synthetic-kimi-cli-fresh-015",
    });
    expect(stored).toMatchObject({
      access_token: "synthetic-kimi-cli-fresh-015",
      refresh_token: rotatedRefreshToken,
      expires_at: NOW / 1_000 + 900,
    });
    expect(JSON.stringify(resolution)).not.toContain(refreshToken);
  });

  it("fails closed on invalid_grant without half-writing the credential", async () => {
    const home = temporaryDirectory();
    const refreshToken = "synthetic-kimi-cli-refresh-invalid-016";
    const credential = writeCredential(home, {
      access_token: "synthetic-kimi-cli-expired-017",
      refresh_token: refreshToken,
      expires_at: NOW / 1_000 - 1,
    });
    const before = readFileSync(credential);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
        }),
    );
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: home },
      now: () => NOW,
    });

    const resolution = await source.resolve({
      refresh: true,
      fetch: fetchMock,
    });

    expect(resolution).toEqual({
      status: "expired",
      refreshFailed: true,
      refreshDefinitive: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readFileSync(credential)).toEqual(before);
    expect(JSON.stringify(resolution)).not.toContain(refreshToken);
  });

  it("does not refresh or write when refresh is disabled", async () => {
    const home = temporaryDirectory();
    const credential = writeCredential(home, {
      access_token: "synthetic-kimi-cli-expired-018",
      refresh_token: "synthetic-kimi-cli-refresh-disabled-019",
      expires_at: NOW / 1_000 - 1,
    });
    const before = readFileSync(credential);
    const fetchMock = vi.fn();
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: home },
      now: () => NOW,
    });

    await expect(
      source.resolve({ refresh: false, fetch: fetchMock }),
    ).resolves.toEqual({ status: "expired" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readFileSync(credential)).toEqual(before);
  });

  it("performs only a read and leaves credential storage unchanged", async () => {
    const home = temporaryDirectory();
    const credential = writeCredential(home, {
      access_token: "read-only-token",
      refresh_token: "never-use-this-refresh-token",
      expires_at: NOW / 1_000 + 3_600,
    });
    const unrelated = join(home, "device_id");
    writeFileSync(unrelated, "existing-device-id\n", { mode: 0o600 });
    const before = snapshotTree(home);
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: home },
      now: () => NOW,
    });

    await source.resolve();

    expect(snapshotTree(home)).toEqual(before);
    expect(readFileSync(credential, "utf8")).toContain(
      "never-use-this-refresh-token",
    );
    expect(readdirSync(home).sort()).toEqual(["credentials", "device_id"]);
  });

  it("uses the shared refresh helper without a process-launch or Pi-auth surface", () => {
    const implementation = readFileSync(
      new URL(
        "../../src/providers/kimi-code-cli-credential.ts",
        import.meta.url,
      ),
      "utf8",
    );

    expect(implementation).not.toMatch(
      /node:child_process|\b(?:spawn|execFile)\b|device_id|\.pi\/agent\/auth\.json/,
    );
    expect(implementation).toContain("refreshOAuthJsonFile");
  });

  it("bounds malformed credential files without returning their contents", async () => {
    const sentinel = "CLI-CREDENTIAL-SENTINEL-938475";
    const readFile = vi.fn(async (_path: string, maxBytes: number) =>
      Buffer.alloc(maxBytes + 1, sentinel),
    );
    const source = createKimiCodeCliCredentialSource({
      environment: { HOME: "/synthetic-home" },
      now: () => NOW,
      readFile,
    });

    const resolution = await source.resolve();

    expect(resolution).toEqual({ status: "invalid" });
    expect(JSON.stringify(resolution)).not.toContain(sentinel);
    expect(readFile).toHaveBeenCalledWith(
      "/synthetic-home/.kimi-code/credentials/kimi-code.json",
      64 * 1_024,
    );
  });

  it("distinguishes credential I/O failures from invalid credentials", async () => {
    const source = createKimiCodeCliCredentialSource({
      environment: { KIMI_CODE_HOME: "/synthetic-home" },
      now: () => NOW,
      readFile: vi.fn(async () => {
        throw Object.assign(new Error("read failed"), { code: "EACCES" });
      }),
    });

    await expect(source.resolve()).resolves.toEqual({ status: "error" });
    await expect(source.inspect()).resolves.toBe("error");
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "quota-axi-kimi-code-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeCredential(home: string, payload: unknown): string {
  return writeCredentialRaw(home, JSON.stringify(payload));
}

function writeCredentialRaw(home: string, raw: string): string {
  const path = join(home, "credentials", "kimi-code.json");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, raw, { mode: 0o600 });
  return path;
}

function snapshotTree(root: string): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  visit(root, "", snapshot);
  return snapshot;
}

function visit(
  root: string,
  relative: string,
  snapshot: Record<string, unknown>,
): void {
  const directory = join(root, relative);
  for (const name of readdirSync(directory).sort()) {
    const childRelative = join(relative, name);
    const path = join(root, childRelative);
    const stat = statSync(path);
    snapshot[childRelative] = {
      type: stat.isDirectory() ? "directory" : "file",
      mode: stat.mode & 0o777,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(stat.isFile() ? { content: readFileSync(path, "utf8") } : {}),
    };
    if (stat.isDirectory()) visit(root, childRelative, snapshot);
  }
}
