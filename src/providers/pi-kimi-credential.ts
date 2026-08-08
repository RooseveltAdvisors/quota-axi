import { open } from "node:fs/promises";
import { homedir } from "node:os";
import {
  PI_AUTH_FILE_LIMIT_BYTES,
  PI_EXPIRY_SKEW_MS,
  piAuthFilePath,
  piGrantExpired,
  usablePiCredential,
  type PiEnvironment,
} from "./pi-auth.js";
import {
  isDefinitiveOAuthRefreshError,
  refreshOAuthJsonFile,
} from "../lib/oauth.js";

const PI_PROVIDER_ID = "kimi-coding";
const KIMI_TOKEN_URL = "https://auth.kimi.com/api/oauth/token";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export type KimiCredentialResolution =
  | {
      status: "available";
      kind: "oauth" | "api_key";
      /** Present only for in-memory probe use; never log or render. */
      credential: string;
    }
  | { status: "missing" }
  | {
      status: "expired";
      refreshable: boolean;
      refreshFailed?: boolean;
      refreshDefinitive?: boolean;
    }
  | { status: "unsupported" }
  | { status: "error" };

export type KimiCredentialInspection =
  | Exclude<KimiCredentialResolution["status"], "available">
  | "available";

export type KimiCredentialResolveOptions = {
  refresh?: boolean;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
};

export type KimiCredentialBroker = {
  resolve(
    options?: KimiCredentialResolveOptions,
  ): Promise<KimiCredentialResolution>;
  inspect(
    options?: KimiCredentialResolveOptions,
  ): Promise<KimiCredentialInspection>;
};

type BrokerDependencies = {
  environment: PiEnvironment;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiKimiCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): KimiCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: Date.now,
    ...overrides,
  };

  const inspect = async (
    options: KimiCredentialResolveOptions = {},
  ): Promise<KimiCredentialInspection> =>
    (await resolveCredential(dependencies, options)).status;

  return {
    resolve: (options = {}) => resolveCredential(dependencies, options),
    inspect,
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
  options: KimiCredentialResolveOptions,
): Promise<KimiCredentialResolution> {
  const path = authFilePath(dependencies);
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, PI_AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > PI_AUTH_FILE_LIMIT_BYTES) {
    return { status: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "missing" };
  }

  const root = objectValue(parsed);
  if (!root) return { status: "missing" };

  const entry = objectValue(root[PI_PROVIDER_ID]);
  if (!entry) return { status: "missing" };

  // Pi stores a `kimi-coding` login as either a literal API key or the OAuth
  // record it received from Kimi. OAuth grants are renewed only when the
  // caller explicitly enables refresh; all other reads are in place.
  const type = stringValue(entry.type)?.toLowerCase();
  if (type === "api_key") {
    const apiKey = usablePiCredential(entry.key);
    return apiKey !== undefined
      ? { status: "available", kind: "api_key", credential: apiKey }
      : { status: "missing" };
  }
  if (type === "oauth") {
    return oauthAccessToken(path, entry, dependencies, options);
  }
  if (type === undefined) return { status: "missing" };
  return { status: "unsupported" };
}

function authFilePath(dependencies: BrokerDependencies): string {
  return piAuthFilePath(dependencies.environment, dependencies.homeDirectory);
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

async function oauthAccessToken(
  path: string,
  entry: Record<string, unknown>,
  dependencies: BrokerDependencies,
  options: KimiCredentialResolveOptions,
): Promise<KimiCredentialResolution> {
  const accessToken = usablePiCredential(entry.access);
  if (accessToken === undefined) return { status: "missing" };
  const expiresAtMs = timestampMs(entry.expires);
  if (Object.hasOwn(entry, "expires") && expiresAtMs === undefined) {
    return { status: "missing" };
  }
  const grant = {
    accessToken,
    expiresAtMs,
    refreshable: usablePiCredential(entry.refresh) !== undefined,
  };
  if (!piGrantExpired(grant, dependencies.now())) {
    return {
      status: "available",
      kind: "oauth",
      credential: grant.accessToken,
    };
  }
  if (options.refresh !== true || !grant.refreshable || !options.fetch) {
    return { status: "expired", refreshable: grant.refreshable };
  }

  try {
    const token = await refreshOAuthJsonFile({
      filePath: path,
      tokenUrl: KIMI_TOKEN_URL,
      clientId: stringValue(entry.client_id) ?? KIMI_CLIENT_ID,
      fetch: options.fetch,
      signal: options.signal,
      minimumFreshnessMs: PI_EXPIRY_SKEW_MS,
      now: dependencies.now,
      readRefreshToken: (document) =>
        stringValue(
          objectValue(objectValue(document)?.[PI_PROVIDER_ID])?.refresh,
        ),
      updateDocument: (document, refreshed) => {
        const root = objectValue(document);
        const current = objectValue(root?.[PI_PROVIDER_ID]);
        if (!root || !current) return document;
        current.access = refreshed.accessToken;
        current.expires = refreshed.expiresAtMs;
        if (refreshed.refreshToken) current.refresh = refreshed.refreshToken;
        return root;
      },
    });
    return {
      status: "available",
      kind: "oauth",
      credential: token.accessToken,
    };
  } catch (error) {
    return {
      status: "expired",
      refreshable: true,
      refreshFailed: true,
      refreshDefinitive: isDefinitiveOAuthRefreshError(error),
    };
  }
}

/* Upstream expiry parsing is retained for ISO and epoch-string Pi grants. */
function timestampMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    // Pi stores numeric OAuth expiry values as epoch milliseconds. Keep the
    // numeric form exact; small values are useful in deterministic probes.
    return value;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      return asNumber < 1_000_000_000_000 ? asNumber * 1000 : asNumber;
    }
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
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
