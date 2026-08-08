import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiAlibabaCredentialBroker } from "../../src/providers/pi-alibaba-credential.js";

const NOW = Date.parse("2027-08-01T00:00:00.000Z");
let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

function writeAuth(entry: unknown): string {
  tempDir = mkdtempSync(join(tmpdir(), "quota-axi-pi-alibaba-"));
  const file = join(tempDir, "auth.json");
  writeFileSync(file, JSON.stringify({ "alibaba-plan": entry }));
  return file;
}

function broker() {
  return createPiAlibabaCredentialBroker({
    environment: { PI_CODING_AGENT_DIR: tempDir },
    homeDirectory: () => tempDir!,
    readFile: async (path) => readFileSync(path),
    now: () => NOW,
  });
}

describe("Pi Alibaba Coding Plan credentials", () => {
  it("reads the exact OAuth entry and never exposes the endpoint refresh blob", async () => {
    const accessToken = "synthetic-alibaba-access-token";
    writeAuth({
      type: "oauth",
      access: accessToken,
      refresh: JSON.stringify({
        openai: "https://token-plan.example.invalid/openai",
        anthropic: "https://token-plan.example.invalid/anthropic",
      }),
      expires: NOW + 86_400_000,
    });

    const result = await broker().resolve({ refresh: true });

    expect(result).toEqual({
      status: "available",
      accessToken,
      expiresAtMs: NOW + 86_400_000,
    });
  });

  it("fails closed for an expired access token without attempting refresh or writing auth", async () => {
    const file = writeAuth({
      type: "oauth",
      access: "expired-alibaba-access-token",
      refresh: JSON.stringify({ openai: "not-a-refresh-token" }),
      expires: NOW - 1,
    });
    const before = readFileSync(file, "utf8");
    const fetch = vi.fn();

    const result = await broker().resolve({ refresh: true, fetch });

    expect(result).toEqual({
      status: "expired",
      expiresAtMs: NOW - 1,
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("honors the no-refresh read-only path for near-expiry grants", async () => {
    const file = writeAuth({
      type: "oauth",
      access: "near-expiry-alibaba-access-token",
      refresh: JSON.stringify({ openai: "not-a-refresh-token" }),
      expires: NOW + 10_000,
    });

    const result = await broker().resolve({ refresh: false });

    expect(result.status).toBe("expired");
    expect(readFileSync(file, "utf8")).toContain("near-expiry-alibaba");
  });

  it.each([Number.MAX_VALUE, -Number.MAX_VALUE])(
    "rejects out-of-range expiry %s",
    async (expires) => {
      writeAuth({
        type: "oauth",
        access: "out-of-range-alibaba-access-token",
        expires,
      });

      await expect(broker().resolve()).resolves.toEqual({ status: "invalid" });
    },
  );

  it.each([
    [{ type: "api_key", key: "wrong-kind" }, "unsupported"],
    [{ type: "oauth", access: "missing-expiry" }, "invalid"],
    [{ type: "oauth", access: "$UNSAFE", expires: NOW + 1_000 }, "invalid"],
  ] as const)(
    "rejects unsupported or malformed entries",
    async (entry, status) => {
      writeAuth(entry);
      const result = await broker().resolve();
      expect(result.status).toBe(status);
    },
  );
});
