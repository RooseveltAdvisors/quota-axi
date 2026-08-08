import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { JsonFileReadResult } from "../lib/fs.js";

export const PI_AUTH_FILE_LIMIT_BYTES = 64 * 1024;
// Treat an access token expiring within this window as already expired, so a
// token cannot lapse between the check here and the request that uses it.
export const PI_EXPIRY_SKEW_MS = 30_000;

export type PiEnvironment = Readonly<Record<string, string | undefined>>;

export type PiOAuthGrant = {
  accessToken: string;
  expiresAtMs: number | undefined;
  refreshable: boolean;
};

export function piAuthFilePath(
  environment: PiEnvironment = process.env,
  homeDirectory: () => string = homedir,
): string {
  return join(piAgentDirectory(environment, homeDirectory), "auth.json");
}

export function piOAuthGrant(
  entry: Record<string, unknown>,
): PiOAuthGrant | undefined {
  const accessToken = usablePiCredential(entry.access);
  if (accessToken === undefined) return undefined;
  const hasExpiry = Object.hasOwn(entry, "expires");
  const expiresAtMs = piOAuthExpiryMs(entry.expires);
  if (hasExpiry && expiresAtMs === undefined) return undefined;
  return {
    accessToken,
    expiresAtMs,
    // Keep only presence in the grant summary; the refresh token stays private
    // and is read again under the shared file lock only when renewal is enabled.
    refreshable: usablePiCredential(entry.refresh) !== undefined,
  };
}

export function piOAuthExpiryMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
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

export function piGrantExpired(
  grant: PiOAuthGrant,
  nowMs: number,
  skewMs = PI_EXPIRY_SKEW_MS,
): boolean {
  return grant.expiresAtMs !== undefined && grant.expiresAtMs - skewMs <= nowMs;
}

export function usablePiCredential(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  // Reject environment, template, and command references without resolving them.
  if (value.startsWith("!") || value.includes("$")) {
    return undefined;
  }
  if (
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return undefined;
  }
  return value;
}

export function readPiAuthFile(path: string): JsonFileReadResult {
  let contents: Buffer | undefined;
  try {
    contents = readBoundedFileSync(path, PI_AUTH_FILE_LIMIT_BYTES);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "invalid", error: "file_read_error" };
  }
  if (contents === undefined) return { status: "missing" };
  try {
    return {
      status: "success",
      value: JSON.parse(contents.toString("utf8")) as unknown,
    };
  } catch {
    return { status: "invalid", error: "json_parse_error" };
  }
}

function piAgentDirectory(
  environment: PiEnvironment,
  homeDirectory: () => string,
): string {
  const home = () => nonempty(environment.HOME) ?? homeDirectory();
  const configured = nonempty(environment.PI_CODING_AGENT_DIR);
  if (configured === undefined) {
    return join(home(), ".pi", "agent");
  }
  if (configured === "~") return home();
  if (
    configured.startsWith("~/") ||
    (process.platform === "win32" && configured.startsWith("~\\"))
  ) {
    return join(home(), configured.slice(2));
  }
  return configured;
}

function readBoundedFileSync(
  path: string,
  maxBytes: number,
): Buffer | undefined {
  const file = openSync(path, "r");
  try {
    const contents = new Uint8Array(maxBytes + 1);
    let offset = 0;
    while (offset < contents.byteLength) {
      const bytesRead = readSync(
        file,
        contents,
        offset,
        contents.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes
      ? undefined
      : Buffer.from(contents.buffer, contents.byteOffset, offset);
  } finally {
    closeSync(file);
  }
}

function nonempty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}
