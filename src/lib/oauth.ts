import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";

const JSON_LIMIT_BYTES = 64 * 1024;
const LOCK_ATTEMPTS = 40;
const LOCK_WAIT_MS = 25;
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;

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
  minimumFreshnessMs?: number;
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

export function isDefinitiveOAuthRefreshError(error: unknown): boolean {
  return (
    error instanceof OAuthRefreshError &&
    (error.code === "invalid_grant" || error.code === "unauthorized")
  );
}

export async function refreshOAuthJsonFile(
  options: OAuthJsonRefreshOptions,
): Promise<OAuthRefreshToken> {
  const deadline = createRefreshDeadline(options.signal);
  let lock: OAuthLock | undefined;
  try {
    lock = await acquireLock(options.filePath, deadline.signal);
    const document = parseJson(await readBoundedText(options.filePath));
    const refreshToken = options.readRefreshToken(document);
    if (!refreshToken) throw new OAuthRefreshError("missing_refresh_token");

    const token = await requestRefreshToken({
      ...options,
      refreshToken,
      signal: deadline.signal,
    });
    await writeJsonAtomically(
      options.filePath,
      options.updateDocument(document, token),
    );
    return token;
  } finally {
    try {
      if (lock) await releaseLock(lock);
    } finally {
      deadline.dispose();
    }
  }
}

async function requestRefreshToken(options: {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  fetch: typeof globalThis.fetch;
  signal?: AbortSignal;
  minimumFreshnessMs?: number;
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

  let body: Record<string, unknown> | undefined;
  try {
    body = await readResponseObject(response);
  } catch (error) {
    if (!response.ok && (response.status === 401 || response.status === 403))
      throw new OAuthRefreshError("unauthorized");
    throw error;
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403)
      throw new OAuthRefreshError("unauthorized");
    if (body?.error === "invalid_grant")
      throw new OAuthRefreshError("invalid_grant");
    throw new OAuthRefreshError("unavailable");
  }

  const accessToken = stringValue(body?.access_token);
  const now = options.now ?? Date.now;
  const nowMs = now();
  const expiresAtMs =
    expiryMs(body?.expires_at) ??
    expiresInMs(body?.expires_in, nowMs) ??
    undefined;
  const minimumFreshnessMs = options.minimumFreshnessMs ?? 0;
  if (
    !accessToken ||
    expiresAtMs === undefined ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs + minimumFreshnessMs
  )
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
  const bytes = await readBoundedResponseBody(response);
  try {
    return objectValue(
      JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    );
  } catch {
    throw new OAuthRefreshError("invalid_response");
  }
}

async function readBoundedResponseBody(
  response: Response,
): Promise<Uint8Array> {
  const contentLength = response.headers.get("content-length")?.trim();
  if (contentLength && /^\d+$/.test(contentLength)) {
    if (BigInt(contentLength) > BigInt(JSON_LIMIT_BYTES))
      throw new OAuthRefreshError("invalid_response");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) throw new OAuthRefreshError("unavailable");
      length += value.byteLength;
      if (length > JSON_LIMIT_BYTES) {
        await cancelResponseReader(reader);
        throw new OAuthRefreshError("invalid_response");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OAuthRefreshError) throw error;
    throw new OAuthRefreshError("unavailable");
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function cancelResponseReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  try {
    await reader.cancel();
  } catch {
    return;
  }
}

async function readBoundedText(filePath: string): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    const bytes = new Uint8Array(JSON_LIMIT_BYTES + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        bytes.byteLength - offset,
        null,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > JSON_LIMIT_BYTES)
      throw new OAuthRefreshError("invalid_response");
    return Buffer.from(bytes.buffer, bytes.byteOffset, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

type OAuthLock = {
  handle: Awaited<ReturnType<typeof open>>;
  path: string;
  contents: string;
};

async function acquireLock(
  filePath: string,
  signal: AbortSignal,
): Promise<OAuthLock> {
  const path = `${filePath}.quota-axi.lock`;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
    if (signal.aborted) throw new OAuthRefreshError("unavailable");
    const contents = `${JSON.stringify({
      pid: process.pid,
      token: randomUUID(),
      createdAtMs: Date.now(),
    })}\n`;
    const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let linked = false;
    try {
      await writeFile(temporaryPath, contents, { mode: 0o600 });
      await chmod(temporaryPath, 0o600);
      await link(temporaryPath, path);
      linked = true;
      const handle = await open(path, "r");
      await removeTemporaryFile(temporaryPath);
      return { handle, path, contents };
    } catch (error) {
      await removeTemporaryFile(temporaryPath);
      if (linked) await reclaimLockMarker(path, contents);
      if (!linked && errorCode(error) === "EEXIST") {
        if (await recoverStaleLock(path)) continue;
        await waitForLock(signal);
        continue;
      }
      throw new OAuthRefreshError("lock_unavailable");
    }
  }
  throw new OAuthRefreshError("lock_unavailable");
}

async function releaseLock(lock: OAuthLock): Promise<void> {
  await lock.handle.close();
  await reclaimLockMarker(lock.path, lock.contents);
}

async function recoverStaleLock(path: string): Promise<boolean> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  let metadata: unknown;
  try {
    metadata = JSON.parse(contents) as unknown;
  } catch {
    return reclaimLockMarker(path, contents);
  }
  const lock = objectValue(metadata);
  const pid = lock?.pid;
  const token = lock?.token;
  const createdAtMs = lock?.createdAtMs;
  if (
    typeof pid !== "number" ||
    !Number.isSafeInteger(pid) ||
    pid <= 0 ||
    typeof token !== "string" ||
    token.length === 0 ||
    typeof createdAtMs !== "number" ||
    !Number.isFinite(createdAtMs)
  )
    return reclaimLockMarker(path, contents);
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (errorCode(error) !== "ESRCH") return false;
  }
  return reclaimLockMarker(path, contents);
}

async function reclaimLockMarker(
  path: string,
  expectedContents: string,
): Promise<boolean> {
  const quarantinePath = `${path}.${process.pid}.${randomUUID()}.stale`;
  try {
    const contents = await readFile(path, "utf8");
    if (contents !== expectedContents) return false;
    await rename(path, quarantinePath);
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
  try {
    await unlink(quarantinePath);
    return true;
  } catch (error) {
    return errorCode(error) === "ENOENT";
  }
}

function waitForLock(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new OAuthRefreshError("unavailable"));
      return;
    }
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new OAuthRefreshError("unavailable"));
    };
    timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, LOCK_WAIT_MS);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createRefreshDeadline(parentSignal?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    OAUTH_REFRESH_TIMEOUT_MS,
  );
  const abort = () => controller.abort();
  if (parentSignal) {
    if (parentSignal.aborted) controller.abort();
    else parentSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", abort);
    },
  };
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
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const expiresAtMs = now + seconds * 1_000;
  return Number.isFinite(expiresAtMs) ? expiresAtMs : undefined;
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
