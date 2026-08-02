import { randomUUID } from "node:crypto";
import {
  chmod,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

const JSON_LIMIT_BYTES = 64 * 1024;
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;

export type OAuthRefreshToken = {
  accessToken: string;
  expiresAtMs: number;
  refreshToken?: string;
};

export type OAuthJsonRefreshOptions = {
  filePath: string;
  tokenUrl: string;
  clientId: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  now?: () => number;
  readRefreshToken(document: unknown): string | undefined;
  updateDocument(document: unknown, token: OAuthRefreshToken): unknown;
};

export class OAuthRefreshError extends Error {
  constructor(
    readonly code:
      | "invalid_grant"
      | "unauthorized"
      | "missing_refresh_token"
      | "invalid_response"
      | "unavailable"
      | "lock_unavailable",
  ) {
    super(`oauth_refresh_${code}`);
  }
}

export async function refreshOAuthJsonFile(
  options: OAuthJsonRefreshOptions,
): Promise<OAuthRefreshToken> {
  const lock = await acquireLock(options.filePath);
  try {
    const document = parseJson(await readFile(options.filePath, "utf8"));
    const refreshToken = options.readRefreshToken(document);
    if (!refreshToken) throw new OAuthRefreshError("missing_refresh_token");

    const token = await requestRefreshToken({
      ...options,
      refreshToken,
    });
    await writeJsonAtomically(
      options.filePath,
      options.updateDocument(document, token),
    );
    return token;
  } finally {
    await releaseLock(lock);
  }
}

async function requestRefreshToken(options: {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<OAuthRefreshToken> {
  let response: Response;
  try {
    response = await options.fetch(options.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: options.clientId,
        grant_type: "refresh_token",
        refresh_token: options.refreshToken,
      }),
      signal: options.signal,
      credentials: "omit",
      redirect: "manual",
    });
  } catch {
    throw new OAuthRefreshError("unavailable");
  }

  const body = await readResponseObject(response);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new OAuthRefreshError("unauthorized");
    if (body?.error === "invalid_grant")
      throw new OAuthRefreshError("invalid_grant");
    throw new OAuthRefreshError("unavailable");
  }

  const accessToken = stringValue(body?.access_token);
  const now = options.now ?? Date.now;
  const expiresAtMs =
    expiryMs(body?.expires_at) ??
    expiresInMs(body?.expires_in, now()) ??
    undefined;
  if (!accessToken || expiresAtMs === undefined || expiresAtMs <= now())
    throw new OAuthRefreshError("invalid_response");
  const refreshToken = stringValue(body?.refresh_token);
  return {
    accessToken,
    expiresAtMs,
    ...(refreshToken ? { refreshToken } : {}),
  };
}

async function readResponseObject(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new OAuthRefreshError("unavailable");
  }
  if (Buffer.byteLength(text, "utf8") > JSON_LIMIT_BYTES)
    throw new OAuthRefreshError("invalid_response");
  try {
    return objectValue(JSON.parse(text) as unknown);
  } catch {
    throw new OAuthRefreshError("invalid_response");
  }
}

async function acquireLock(filePath: string): Promise<{
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
}> {
  const path = `${filePath}.quota-axi.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      return { handle, path };
    } catch (error) {
      if (errorCode(error) !== "EEXIST")
        throw new OAuthRefreshError("lock_unavailable");
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  throw new OAuthRefreshError("lock_unavailable");
}

async function releaseLock(lock: {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
}): Promise<void> {
  await lock.handle.close();
  try {
    await unlink(lock.path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function writeJsonAtomically(filePath: string, document: unknown) {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, filePath);
    await chmod(filePath, 0o600);
  } catch (error) {
    await removeTemporaryFile(temporaryPath);
    throw error;
  }
  await removeTemporaryFile(temporaryPath);
}

async function removeTemporaryFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return;
  }
}

function parseJson(text: string): unknown {
  if (Buffer.byteLength(text, "utf8") > JSON_LIMIT_BYTES)
    throw new OAuthRefreshError("invalid_response");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OAuthRefreshError("invalid_response");
  }
}

function expiryMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric))
    return numeric > 10_000_000_000 ? numeric : numeric * 1_000;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function expiresInMs(value: unknown, now: number): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? now + seconds * 1_000
    : undefined;
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
