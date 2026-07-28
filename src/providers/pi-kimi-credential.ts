import { open } from "node:fs/promises";
import { homedir } from "node:os";
import {
  PI_AUTH_FILE_LIMIT_BYTES,
  piAuthFilePath,
  piGrantExpired,
  piOAuthGrant,
  usablePiCredential,
  type PiEnvironment,
} from "./pi-auth.js";

const PI_PROVIDER_ID = "kimi-coding";

export type KimiCredentialResolution =
  | { status: "available"; apiKey: string }
  | { status: "missing" }
  | { status: "unsupported" }
  | { status: "expired" }
  | { status: "error" };

export type KimiCredentialInspection =
  | Exclude<KimiCredentialResolution["status"], "available">
  | "available";

export type KimiCredentialBroker = {
  resolve(): Promise<KimiCredentialResolution>;
  inspect(): Promise<KimiCredentialInspection>;
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

  const inspect = async (): Promise<KimiCredentialInspection> =>
    (await resolveCredential(dependencies)).status;

  return {
    resolve: () => resolveCredential(dependencies),
    inspect,
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
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

  // pi stores a subscription as an OAuth grant, not an API key. The quota
  // endpoints take `Authorization: Bearer <token>`, so an unexpired access
  // token is usable exactly like a key. Rejecting it stranded every
  // subscription behind "unsupported_credential_type".
  if (entry.type === "oauth") {
    return oauthAccessToken(entry, dependencies.now());
  }

  if (typeof entry.type === "string" && entry.type !== "api_key") {
    return { status: "unsupported" };
  }
  if (entry.type !== "api_key") {
    return { status: "missing" };
  }

  const apiKey = usablePiCredential(entry.key);
  return apiKey !== undefined
    ? { status: "available", apiKey }
    : { status: "missing" };
}

function oauthAccessToken(
  entry: Record<string, unknown>,
  nowMs: number,
): KimiCredentialResolution {
  const grant = piOAuthGrant(entry);
  if (!grant) return { status: "missing" };

  // `expires` is the access token's own lifetime. pi refreshes on use, but this
  // process only reads auth.json — it never refreshes — so an already-lapsed
  // token must be reported rather than sent and rejected upstream.
  return piGrantExpired(grant, nowMs)
    ? { status: "expired" }
    : { status: "available", apiKey: grant.accessToken };
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

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
