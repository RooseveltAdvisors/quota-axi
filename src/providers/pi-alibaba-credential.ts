import { open } from "node:fs/promises";
import { homedir } from "node:os";
import {
  PI_AUTH_FILE_LIMIT_BYTES,
  PI_EXPIRY_SKEW_MS,
  piAuthFilePath,
  piGrantExpired,
  piOAuthGrant,
  type PiEnvironment,
} from "./pi-auth.js";

const PI_PROVIDER_ID = "alibaba-plan";
const MAX_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

export type AlibabaCredentialResolution =
  | { status: "available"; accessToken: string; expiresAtMs: number }
  | { status: "missing" | "invalid" | "unsupported" | "error" }
  | { status: "expired"; expiresAtMs: number };

export type AlibabaCredentialInspection = AlibabaCredentialResolution["status"];

export type AlibabaCredentialResolveOptions = {
  /** Kept for the shared provider contract; Alibaba has no refresh grant. */
  refresh?: boolean;
  /** Accepted for hermetic callers; no refresh request is ever issued. */
  fetch?: typeof globalThis.fetch;
};

export type AlibabaCredentialBroker = {
  resolve(
    options?: AlibabaCredentialResolveOptions,
  ): Promise<AlibabaCredentialResolution>;
  inspect(
    options?: AlibabaCredentialResolveOptions,
  ): Promise<AlibabaCredentialInspection>;
};

type BrokerDependencies = {
  environment: PiEnvironment;
  homeDirectory: () => string;
  readFile: (path: string, maxBytes: number) => Promise<Buffer>;
  now: () => number;
};

export function createPiAlibabaCredentialBroker(
  overrides: Partial<BrokerDependencies> = {},
): AlibabaCredentialBroker {
  const dependencies: BrokerDependencies = {
    environment: process.env,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    now: Date.now,
    ...overrides,
  };

  const inspect = async (
    options: AlibabaCredentialResolveOptions = {},
  ): Promise<AlibabaCredentialInspection> =>
    (await resolveCredential(dependencies, options)).status;

  return {
    resolve: (options = {}) => resolveCredential(dependencies, options),
    inspect,
  };
}

async function resolveCredential(
  dependencies: BrokerDependencies,
  _options: AlibabaCredentialResolveOptions,
): Promise<AlibabaCredentialResolution> {
  const path = piAuthFilePath(
    dependencies.environment,
    dependencies.homeDirectory,
  );
  let contents: Buffer;
  try {
    contents = await dependencies.readFile(path, PI_AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "error" };
  }
  if (contents.byteLength > PI_AUTH_FILE_LIMIT_BYTES) {
    return { status: "invalid" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.toString("utf8")) as unknown;
  } catch {
    return { status: "invalid" };
  }

  const root = objectValue(parsed);
  const entry = objectValue(root?.[PI_PROVIDER_ID]);
  if (!entry) return { status: "missing" };
  if (entry.type !== "oauth") {
    return typeof entry.type === "string"
      ? { status: "unsupported" }
      : { status: "invalid" };
  }

  const grant = piOAuthGrant(entry);
  if (
    !grant ||
    grant.expiresAtMs === undefined ||
    Math.abs(grant.expiresAtMs) > MAX_EPOCH_MILLISECONDS
  )
    return { status: "invalid" };
  if (piGrantExpired(grant, dependencies.now(), PI_EXPIRY_SKEW_MS)) {
    // pi-alibaba-models stores endpoint configuration JSON in `refresh`; it is
    // not an OAuth refresh grant and no Alibaba refresh exchange is documented.
    // Never send it anywhere or treat an expired access token as usable.
    return { status: "expired", expiresAtMs: grant.expiresAtMs };
  }
  return {
    status: "available",
    accessToken: grant.accessToken,
    expiresAtMs: grant.expiresAtMs,
  };
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
