import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  isDefinitiveOAuthRefreshError,
  refreshOAuthJsonFile,
} from "../lib/oauth.js";

export const KIMI_CODE_CLI_CREDENTIAL_SOURCE = "kimi-code-cli";

const CREDENTIAL_FILE_LIMIT_BYTES = 64 * 1024;
const MINIMUM_FRESHNESS_SECONDS = 60;

export type KimiCodeCliCredentialResolution =
  | { status: "available"; accessToken: string }
  | { status: "missing" | "invalid" | "error" }
  | {
      status: "expired";
      refreshFailed?: boolean;
      refreshDefinitive?: boolean;
    };

export type KimiCodeCliCredentialInspection =
  KimiCodeCliCredentialResolution["status"];

export type KimiCodeCliCredentialResolveOptions = {
  refresh?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

export type KimiCodeCliCredentialSource = {
  resolve(
    options?: KimiCodeCliCredentialResolveOptions,
  ): Promise<KimiCodeCliCredentialResolution>;
  inspect(
    options?: KimiCodeCliCredentialResolveOptions,
  ): Promise<KimiCodeCliCredentialInspection>;
};

type CredentialSourceDependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  homeDirectory: () => string;
  now: () => number;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
};

export function createKimiCodeCliCredentialSource(
  overrides: Partial<CredentialSourceDependencies> = {},
): KimiCodeCliCredentialSource {
  const dependencies: CredentialSourceDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    now: Date.now,
    readFile: readBoundedFile,
    ...overrides,
  };

  const inspect = async (
    options: KimiCodeCliCredentialResolveOptions = {},
  ): Promise<KimiCodeCliCredentialInspection> =>
    (await resolveCredential(dependencies, options)).status;

  return {
    resolve: (options = {}) => resolveCredential(dependencies, options),
    inspect,
  };
}

async function resolveCredential(
  dependencies: CredentialSourceDependencies,
  options: KimiCodeCliCredentialResolveOptions,
): Promise<KimiCodeCliCredentialResolution> {
  const path = credentialPath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, CREDENTIAL_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > CREDENTIAL_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }
  const credential = objectValue(parsed);
  const accessToken =
    typeof credential?.access_token === "string"
      ? credential.access_token.trim()
      : "";
  const expiresAt = expirySeconds(credential?.expires_at);
  if (!accessToken || expiresAt === undefined) return { status: "invalid" };
  if (expiresAt <= dependencies.now() / 1_000 + MINIMUM_FRESHNESS_SECONDS) {
    const refreshToken = stringValue(credential?.refresh_token);
    if (options.refresh !== true || !refreshToken || !options.fetch) {
      return { status: "expired" };
    }
    try {
      const token = await refreshOAuthJsonFile({
        filePath: path,
        tokenUrl: "https://auth.kimi.com/api/oauth/token",
        clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
        fetch: options.fetch,
        signal: options.signal,
        minimumFreshnessMs: MINIMUM_FRESHNESS_SECONDS * 1_000,
        now: dependencies.now,
        readRefreshToken: (document) =>
          stringValue(objectValue(document)?.refresh_token),
        updateDocument: (document, refreshed) => {
          const current = objectValue(document);
          if (!current) return document;
          current.access_token = refreshed.accessToken;
          current.expires_at = refreshed.expiresAtMs / 1_000;
          if (refreshed.refreshToken)
            current.refresh_token = refreshed.refreshToken;
          return current;
        },
      });
      return { status: "available", accessToken: token.accessToken };
    } catch (error) {
      return {
        status: "expired",
        refreshFailed: true,
        refreshDefinitive: isDefinitiveOAuthRefreshError(error),
      };
    }
  }
  return { status: "available", accessToken };
}

function credentialPath(dependencies: CredentialSourceDependencies): string {
  const configuredHome = nonempty(dependencies.environment.KIMI_CODE_HOME);
  const codeHome =
    configuredHome ??
    join(
      nonempty(dependencies.environment.HOME) ?? dependencies.homeDirectory(),
      ".kimi-code",
    );
  return join(codeHome, "credentials", "kimi-code.json");
}

async function readBoundedFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const contents = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const { bytesRead } = await file.read(
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return Buffer.from(contents.buffer, contents.byteOffset, offset);
  } finally {
    await file.close();
  }
}

function expirySeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(normalized)) {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
