import {
  chmodSync,
  existsSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { homedir, userInfo } from "node:os";
import { basename, delimiter, join } from "node:path";
import { deleteCachedProvider, readCachedProvider } from "../cache.js";
import {
  claudeKeychainAccessMarkerPath,
  ensurePrivateParent,
  readJsonFileResult,
  type JsonFileReadResult,
} from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import { clampPercent, nowIso, retryAfterToIso } from "../lib/time.js";
import type {
  AuthProviderReport,
  AuthSourceReport,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
  ProviderStatus,
  QuotaWindow,
  SourceAttempt,
} from "../types.js";
import {
  failedProvider,
  sourceNames,
  statusFromError,
  successProvider,
  withRemaining,
} from "./common.js";

const API_URL = "https://api.anthropic.com/api/oauth/usage";
const PROFILE_API_URL = "https://api.anthropic.com/api/oauth/profile";
const HEADER_PROBE_URL = "https://api.anthropic.com/v1/messages";
const OAUTH_BETA = "oauth-2025-04-20";
const CLAUDE_CODE_USER_AGENT = "claude-code/2.1.202";
const API_TIMEOUT_MS = 15_000;
const HEADER_PROBE_TIMEOUT_MS = 5_000;
const HEADER_PROBE_MODEL = "claude-haiku-4-5-20251001";
const HEADER_CACHE_TTL_MS = 60_000;
// ponytail: two workers bound Anthropic probe load; raise only with a measured need.
const MAX_SEAT_CONCURRENCY = 2;
const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const DEFAULT_KEYCHAIN_SERVICE = "Claude Code-credentials";
const DEFAULT_KEYCHAIN_ACCOUNT = "claude-code-user";
const SAFE_KEYCHAIN_ACCOUNT = /^[a-zA-Z0-9._-]+$/;
const SAFE_SEAT_NAME = /^[a-zA-Z0-9_-]+$/;
const CLAUDE_CONFIG_DIRS_DELIMITER =
  process.platform === "win32" ? ";" : delimiter;
const FIVE_HOURS_MS = 5 * 60 * 60 * 1_000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1_000;
const FIVE_HOURS_SECONDS = 18_000;
const SEVEN_DAYS_SECONDS = 604_800;

type ClaudeCredentials = {
  source: "oauth-file" | "keychain";
  accessToken: string;
  plan?: string;
  expiresAt?: number;
};

type AvailableCredentialState = {
  status: "available";
  credentials: ClaudeCredentials;
};
type AdvisoryExpiredCredentialState = {
  status: "expired";
  credentials: ClaudeCredentials;
  source: AuthSourceReport;
};
type UnavailableCredentialState = {
  status: "missing" | "invalid";
  source: AuthSourceReport;
};
type SkippedCredentialState = { status: "skipped"; source: AuthSourceReport };
type CredentialState =
  | AvailableCredentialState
  | AdvisoryExpiredCredentialState
  | UnavailableCredentialState
  | SkippedCredentialState;
type KeychainItemPresence = "present" | "missing" | "unknown";
type ClaudeAccount = NonNullable<ProviderQuota["account"]>;
type ClaudeIdentityResult = {
  account: ClaudeAccount;
  error?: string;
};
type ClaudeProfileLocations = {
  credentialFile: string;
  keychainAccount: string;
  keychainService: string;
  keychainAccessMarker: string;
};

export type ClaudeSeat = {
  name: string;
  locations: ClaudeProfileLocations;
  keychain: boolean;
};

type ClaudeSeatQuota = {
  seat: ClaudeSeat;
  quota: {
    plan?: string;
    account?: ProviderQuota["account"];
    windows: QuotaWindow[];
    refreshedAt: string;
  };
};

type ClaudeSeatOutcome = {
  seat: ClaudeSeat;
  attempts: SourceAttempt[];
  quota?: ClaudeSeatQuota["quota"];
  failure?: ClaudeFailure;
};

type RawUsageWindow = {
  utilization?: unknown;
  resets_at?: unknown;
  reset_at?: unknown;
};

type ExtraUsageWindow = RawUsageWindow & {
  is_enabled?: unknown;
  monthly_limit?: unknown;
  used_credits?: unknown;
  decimal_places?: unknown;
};

type ClaudeFailureOptions = {
  status?: ProviderStatus;
  definitiveAuth?: boolean;
  staleEligible?: boolean;
  retryAfter?: string;
};

// A scoped-limit entry as returned in the `limits` array of the OAuth usage
// response. Unlike the fixed top-level fields (five_hour, seven_day, ...),
// this array self-describes every limit the account currently has, including
// ones scoped to a specific model (scope.model.display_name).
type ScopedLimitEntry = {
  kind?: unknown;
  group?: unknown;
  percent?: unknown;
  resets_at?: unknown;
  scope?: unknown;
};

export const claudeAdapter: ProviderAdapter = {
  id: "claude",
  label: "Claude",
  fetchQuota,
  inspectAuth,
};

export async function fetchQuota(
  options: ProviderOptions,
): Promise<ProviderQuota> {
  const seats = resolveClaudeSeats();
  if (seats.length <= 1) {
    return fetchSingleSeatQuota(options, seats[0] ?? primaryClaudeSeat());
  }
  return fetchMultiSeatQuota(options, seats);
}

async function fetchSingleSeatQuota(
  options: ProviderOptions,
  seat: ClaudeSeat,
): Promise<ProviderQuota> {
  const attempts: SourceAttempt[] = [];

  const credentialStates = await readCredentialStates(
    options,
    seat.locations,
    seat.keychain,
  );
  const credentials = credentialStates
    .filter(
      (
        state,
      ): state is AvailableCredentialState | AdvisoryExpiredCredentialState =>
        state.status === "available" || state.status === "expired",
    )
    .map((state) => state.credentials)
    .sort(sortClaudeCredentials);

  for (const state of credentialStates) {
    if (state.status === "available" || state.status === "expired") continue;
    if (state.status === "skipped") {
      const attempt: SourceAttempt = {
        source: state.source.source,
        status: "skipped",
        error: state.source.error,
      };
      if (state.source.credentialPresent) attempt.credentialPresent = true;
      attempts.push(attempt);
      continue;
    }
    attempts.push({
      source: state.source.source,
      status: "skipped",
      error: `credentials_${state.status}`,
    });
  }

  let definitiveFailure: ClaudeFailure | undefined;
  let transientFailure: ClaudeFailure | undefined;

  if (credentials.length > 0) {
    for (const credential of credentials) {
      attempts.push({ source: credential.source, status: "failed" });
      try {
        const quota = await fetchOauthUsage(credential);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "success",
        };
        attempts.push(
          quota.identityError
            ? {
                source: "oauth-profile",
                status: "failed",
                error: quota.identityError,
              }
            : { source: "oauth-profile", status: "success" },
        );
        return successProvider({
          provider: "claude",
          label: "Claude",
          source: "oauth",
          plan: quota.plan,
          account: quota.account,
          windows: quota.windows,
          refreshedAt: quota.refreshedAt,
          sourcesTried: sourceNames(attempts),
          attempts,
        });
      } catch (error) {
        const failure = claudeFailureFor(error);
        attempts[attempts.length - 1] = {
          source: credential.source,
          status: "failed",
          error: failure.code,
        };
        if (failure.definitiveAuth) definitiveFailure ??= failure;
        else transientFailure = failure;
      }
    }
  } else {
    const skipped = credentialStates.find(
      (state): state is SkippedCredentialState => state.status === "skipped",
    );
    if (skipped) {
      transientFailure = new ClaudeFailure(
        skipped.source.error ?? "Claude quota unavailable",
        { staleEligible: true },
      );
    } else {
      const invalid = credentialStates.some(
        (state) => state.status === "invalid",
      );
      definitiveFailure = new ClaudeFailure(
        invalid ? "credentials_invalid" : "credentials_missing",
        { status: "auth_required", definitiveAuth: true },
      );
    }
  }

  return failureReport(
    definitiveFailure ??
      transientFailure ??
      new ClaudeFailure("Claude quota unavailable", { staleEligible: true }),
    attempts,
  );
}

async function fetchMultiSeatQuota(
  options: ProviderOptions,
  seats: ClaudeSeat[],
): Promise<ProviderQuota> {
  const cached = readFreshMultiSeatCache(seats);
  if (cached) return cached;

  const outcomes = await mapWithConcurrency(
    seats,
    MAX_SEAT_CONCURRENCY,
    (seat) => fetchSeatQuota(options, seat),
  );
  const successful = outcomes.filter(
    (
      outcome,
    ): outcome is ClaudeSeatOutcome & { quota: ClaudeSeatQuota["quota"] } =>
      Boolean(outcome.quota),
  );
  const attempts = outcomes.flatMap((outcome) => outcome.attempts);

  if (successful.length === 0) {
    const failure =
      outcomes.find((outcome) => outcome.failure?.definitiveAuth)?.failure ??
      outcomes.find((outcome) => outcome.failure)?.failure ??
      new ClaudeFailure("Claude quota unavailable", { staleEligible: true });
    return failureReport(failure, attempts, seats);
  }

  const windows = successful.flatMap(({ seat, quota }) =>
    quota.windows.map((window) => prefixSeatWindow(seat.name, window)),
  );
  const plans = [
    ...new Set(successful.map(({ quota }) => quota.plan).filter(Boolean)),
  ];
  const failedSeats = outcomes.filter((outcome) => !outcome.quota);
  const failedSeatNames = failedSeats.map(({ seat }) => seat.name);
  const report = successProvider({
    provider: "claude",
    label: `Claude (${seats.map(({ name }) => name).join(", ")})`,
    source: "oauth",
    ...(plans.length === 1 ? { plan: plans[0] } : {}),
    windows,
    refreshedAt: nowIso(),
    sourcesTried: sourceNames(attempts),
    attempts,
  });
  const finalReport =
    failedSeats.length === 0
      ? report
      : {
          ...report,
          state: {
            ...report.state,
            reason: "partial_seat_failure",
            error: `unavailable_seats:${failedSeatNames.join(",")}`,
          },
        };
  return attachClaudeSeatCacheIdentity(finalReport, seats);
}

async function fetchSeatQuota(
  options: ProviderOptions,
  seat: ClaudeSeat,
): Promise<ClaudeSeatOutcome> {
  const credentialStates = await readCredentialStates(
    options,
    seat.locations,
    seat.keychain,
  );
  const attempts: SourceAttempt[] = [];
  const credentials = credentialStates
    .filter(
      (
        state,
      ): state is AvailableCredentialState | AdvisoryExpiredCredentialState =>
        state.status === "available" || state.status === "expired",
    )
    .map((state) => state.credentials)
    .sort(sortClaudeCredentials);

  for (const state of credentialStates) {
    if (state.status === "available" || state.status === "expired") continue;
    attempts.push({
      source: seatAttemptSource(seat.name),
      status: "skipped",
      error:
        state.status === "skipped"
          ? state.source.error
          : `credentials_${state.status}`,
      ...(state.status === "skipped" && state.source.credentialPresent
        ? { credentialPresent: true }
        : {}),
    });
  }

  let definitiveFailure: ClaudeFailure | undefined;
  let transientFailure: ClaudeFailure | undefined;
  for (const credential of credentials) {
    try {
      const quota = await fetchSeatCredential(credential);
      attempts.push({
        source: seatAttemptSource(seat.name),
        status: "success",
      });
      return { seat, attempts, quota };
    } catch (error) {
      const failure = claudeFailureFor(error);
      attempts.push({
        source: seatAttemptSource(seat.name),
        status: "failed",
        error: failure.code,
      });
      if (failure.definitiveAuth) definitiveFailure ??= failure;
      else transientFailure ??= failure;
    }
  }

  if (credentials.length === 0) {
    const skipped = credentialStates.find(
      (state): state is SkippedCredentialState => state.status === "skipped",
    );
    if (skipped) {
      transientFailure = new ClaudeFailure(
        skipped.source.error ?? "Claude quota unavailable",
        { staleEligible: true },
      );
    } else {
      definitiveFailure = new ClaudeFailure(
        credentialStates.some((state) => state.status === "invalid")
          ? "credentials_invalid"
          : "credentials_missing",
        { status: "auth_required", definitiveAuth: true },
      );
    }
  }

  return {
    seat,
    attempts,
    failure: definitiveFailure ?? transientFailure,
  };
}

async function fetchSeatCredential(
  credentials: ClaudeCredentials,
): Promise<ClaudeSeatQuota["quota"]> {
  const headerQuota = await fetchHeaderProbe(credentials);
  if (!headerQuota) return fetchOauthUsage(credentials);
  try {
    return await fetchOauthUsage(credentials);
  } catch (error) {
    if (error instanceof ClaudeFailure && error.definitiveAuth) throw error;
    return headerQuota;
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  async function run(): Promise<void> {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => run()),
  );
  return results;
}

function seatAttemptSource(name: string): string {
  return `claude:${name}`;
}

function sortClaudeCredentials(
  a: ClaudeCredentials,
  b: ClaudeCredentials,
): number {
  if (process.platform === "darwin") {
    if (a.source === "keychain" && b.source !== "keychain") return -1;
    if (b.source === "keychain" && a.source !== "keychain") return 1;
  }
  return (b.expiresAt ?? 0) - (a.expiresAt ?? 0);
}

function prefixSeatWindow(seat: string, window: QuotaWindow): QuotaWindow {
  return {
    ...window,
    id: `${seat}:${window.id}`,
    label: `${seat} ${window.label}`,
  };
}

function attachClaudeSeatCacheIdentity(
  report: ProviderQuota,
  seats: ClaudeSeat[],
): ProviderQuota {
  Object.defineProperty(report.state, "cacheIdentity", {
    value: claudeSeatCacheIdentity(seats),
    enumerable: false,
    configurable: true,
  });
  return report;
}

function claudeSeatCacheIdentity(seats: ClaudeSeat[]): string {
  return createHash("sha256")
    .update(
      seats
        .map(({ name, locations }) => `${name}\0${locations.credentialFile}`)
        .sort()
        .join("\0"),
    )
    .digest("hex");
}

function failureReport(
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  seats?: ClaudeSeat[],
): ProviderQuota {
  if (failure.definitiveAuth) {
    try {
      deleteCachedProvider("claude");
    } catch {
      // Current authentication remains definitive when cache I/O is blocked.
    }
  }

  if (failure.staleEligible) {
    try {
      const cached = readCachedProvider("claude");
      const stale = cached
        ? staleClaudeReport(cached, failure, attempts, Date.now(), seats)
        : undefined;
      if (stale) return stale;
    } catch {
      // Cache I/O cannot replace the current bounded provider failure.
    }
  }

  return failedProvider({
    provider: "claude",
    label: "Claude",
    status: failure.status,
    error: failure.code,
    retryAfter: failure.retryAfter,
    sourcesTried: sourceNames(attempts),
    attempts,
  });
}

function readFreshMultiSeatCache(
  seats: ClaudeSeat[],
): ProviderQuota | undefined {
  const cached = readCachedProvider("claude");
  if (
    !cached ||
    cached.source !== "oauth" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  )
    return undefined;
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (
    !Number.isFinite(refreshedAt) ||
    refreshedAt > Date.now() ||
    Date.now() - refreshedAt >= HEADER_CACHE_TTL_MS
  )
    return undefined;
  const cacheIdentity = (
    cached.state as ProviderQuota["state"] & { cacheIdentity?: string }
  ).cacheIdentity;
  if (
    cacheIdentity !== claudeSeatCacheIdentity(seats) ||
    !hasSeatWindows(cached.windows, seats)
  )
    return undefined;
  return {
    ...cached,
    label: `Claude (${seats.map(({ name }) => name).join(", ")})`,
    source: "cache",
    attempts: undefined,
    state: { ...cached.state, sourcesTried: ["cache"] },
  };
}

function hasSeatWindows(windows: QuotaWindow[], seats: ClaudeSeat[]): boolean {
  const expected = new Set(seats.map(({ name }) => name));
  const found = new Set<string>();
  for (const window of windows) {
    const separator = window.id.indexOf(":");
    if (separator <= 0) return false;
    found.add(window.id.slice(0, separator));
  }
  return (
    found.size === expected.size &&
    [...expected].every((name) => found.has(name))
  );
}

function staleClaudeReport(
  cached: ProviderQuota,
  failure: ClaudeFailure,
  attempts: SourceAttempt[],
  now: number,
  seats?: ClaudeSeat[],
): ProviderQuota | undefined {
  if (
    cached.provider !== "claude" ||
    cached.source !== "oauth" ||
    cached.state.status !== "fresh" ||
    !cached.state.refreshedAt
  ) {
    return undefined;
  }
  if (seats) {
    const cacheIdentity = (
      cached.state as ProviderQuota["state"] & { cacheIdentity?: string }
    ).cacheIdentity;
    if (
      cacheIdentity !== claudeSeatCacheIdentity(seats) ||
      !hasSeatWindows(cached.windows, seats)
    )
      return undefined;
  }
  const refreshedAt = Date.parse(cached.state.refreshedAt);
  if (!Number.isFinite(refreshedAt) || refreshedAt > now) return undefined;
  const ageMilliseconds = now - refreshedAt;
  if (ageMilliseconds >= SEVEN_DAYS_MS) return undefined;

  const windows = cached.windows.filter((window) => {
    if (window.resetsAt !== undefined) {
      const resetsAt = Date.parse(window.resetsAt);
      return Number.isFinite(resetsAt) && resetsAt > now;
    }
    const maxAge = resetlessWindowMaxAge(window);
    return maxAge !== undefined && ageMilliseconds < maxAge;
  });
  if (windows.length === 0) return undefined;

  return {
    provider: "claude",
    label: "Claude",
    source: "cache",
    ...(cached.plan ? { plan: cached.plan } : {}),
    windows,
    state: {
      status: "stale",
      stale: true,
      refreshedAt: cached.state.refreshedAt,
      error: failure.code,
      ...(failure.retryAfter ? { retryAfter: failure.retryAfter } : {}),
      sourcesTried: [...new Set([...sourceNames(attempts), "cache"])],
    },
    attempts,
  };
}

function resetlessWindowMaxAge(window: QuotaWindow): number | undefined {
  if (window.kind === "weekly" || window.kind === "model") {
    return SEVEN_DAYS_MS;
  }
  if (
    window.kind === "session" ||
    window.kind === "monthly" ||
    window.kind === "credits"
  ) {
    return FIVE_HOURS_MS;
  }
  return undefined;
}

function claudeFailureFor(error: unknown): ClaudeFailure {
  if (error instanceof ClaudeFailure) return error;
  return new ClaudeFailure(errorMessage(error), { staleEligible: true });
}

export async function inspectAuth(
  options: ProviderOptions,
): Promise<AuthProviderReport> {
  const seats = resolveClaudeSeats();
  const reports = await mapWithConcurrency(
    seats,
    MAX_SEAT_CONCURRENCY,
    async (seat) => {
      const states = await readCredentialStates(
        options,
        seat.locations,
        seat.keychain,
      );
      return states.map((state): AuthSourceReport => {
        const source =
          seats.length > 1
            ? seatAttemptSource(seat.name) +
              ":" +
              (state.status === "available"
                ? state.credentials.source
                : state.source.source)
            : state.status === "available"
              ? state.credentials.source
              : state.source.source;
        if (state.status === "available") {
          return {
            source,
            path:
              state.credentials.source === "oauth-file"
                ? seat.locations.credentialFile
                : undefined,
            status: "available",
          };
        }
        return { ...state.source, source };
      });
    },
  );
  const sources = reports.flat();
  return { provider: "claude", sources };
}

export function normalizeClaudeApiUsage(
  raw: unknown,
  plan?: string,
): { plan?: string; windows: QuotaWindow[]; refreshedAt: string } | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;

  // The `limits` array (when present) is the vendor's own authoritative list
  // of every window the account currently has, including ones scoped to a
  // specific model (e.g. Fable, Opus). Prefer it over the fixed top-level
  // fields so newly introduced scoped limits show up without code changes.
  const scopedWindows = normalizeScopedLimits(data.limits);
  const windows =
    scopedWindows.length > 0
      ? scopedWindows
      : [
          normalizeWindow(data.five_hour, "five_hour", "session", "session"),
          normalizeWindow(data.seven_day, "seven_day", "week", "weekly"),
          normalizeWindow(
            data.seven_day_opus,
            "seven_day_opus",
            "opus week",
            "model",
          ),
        ].filter((window): window is QuotaWindow => Boolean(window));

  const extraUsage = normalizeExtraUsage(data.extra_usage);
  if (extraUsage) windows.push(extraUsage);

  if (windows.length === 0) return undefined;
  return { plan, windows, refreshedAt: nowIso() };
}

export function normalizeClaudeProfile(
  raw: unknown,
): ClaudeAccount | undefined {
  const data = objectValue(raw);
  if (!data) return undefined;
  const account = objectValue(data.account);
  const accountId = stringValue(account?.uuid);
  if (!accountId) return undefined;

  const organization = objectValue(data.organization);
  return {
    accountId,
    email:
      stringValue(account?.email) ??
      stringValue(account?.email_address) ??
      stringValue(account?.emailAddress) ??
      stringValue(data.email_address) ??
      stringValue(data.emailAddress) ??
      stringValue(data.email),
    organization:
      stringValue(organization?.name) ??
      stringValue(data.organization_name) ??
      stringValue(data.organizationName),
    identityStatus: "verified",
  };
}

function normalizeScopedLimits(raw: unknown): QuotaWindow[] {
  if (!Array.isArray(raw)) return [];
  const windows: QuotaWindow[] = [];
  for (const entry of raw) {
    const window = normalizeScopedLimitEntry(entry);
    if (window) windows.push(window);
  }
  return windows;
}

function normalizeScopedLimitEntry(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as ScopedLimitEntry;
  const percent = typeof entry.percent === "number" ? entry.percent : undefined;
  if (percent === undefined) return undefined;
  const resetsAt = stringValue(entry.resets_at);

  const scope = objectValue(entry.scope);
  const model = scope ? objectValue(scope.model) : undefined;
  const modelName = model ? stringValue(model.display_name) : undefined;
  if (modelName) {
    const modelKey = stringValue(model?.id) ?? slugify(modelName);
    return withRemaining({
      id: `model:${modelKey}`,
      label: `${modelName} week`,
      kind: "model",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: SEVEN_DAYS_SECONDS,
    });
  }

  const group = stringValue(entry.group);
  if (group === "session") {
    return withRemaining({
      id: "five_hour",
      label: "session",
      kind: "session",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: FIVE_HOURS_SECONDS,
    });
  }
  if (group === "weekly") {
    return withRemaining({
      id: "seven_day",
      label: "week",
      kind: "weekly",
      percentUsed: clampPercent(percent),
      resetsAt,
      windowSeconds: SEVEN_DAYS_SECONDS,
    });
  }

  const kind = stringValue(entry.kind);
  return withRemaining({
    id: kind ?? "limit",
    label: kind ?? "limit",
    kind: "unknown",
    percentUsed: clampPercent(percent),
    resetsAt,
  });
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function readCredentialStates(
  options: ProviderOptions,
  locations = resolveClaudeProfileLocations(),
  includeKeychain = process.platform === "darwin",
): Promise<CredentialState[]> {
  const states: CredentialState[] = [];

  const fileState = extractCredentialState(
    readJsonFileResult(locations.credentialFile),
    "oauth-file",
    locations.credentialFile,
  );
  states.push(fileState);

  if (includeKeychain && process.platform === "darwin") {
    if (options.allowKeychainPrompt || hasKeychainAccessMarker(locations)) {
      states.push(await readKeychainCredentialState(locations));
    } else {
      states.push(await readSkippedKeychainCredentialState(locations));
    }
  }

  return states;
}

async function readSkippedKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  const presence = await readKeychainItemPresence(locations);
  if (presence === "present") {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_required",
        credentialPresent: true,
      },
    };
  }
  if (presence === "missing") {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_presence_check_failed",
    },
  };
}

async function readKeychainItemPresence(
  locations: ClaudeProfileLocations,
): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

async function readKeychainCredentialState(
  locations: ClaudeProfileLocations,
): Promise<CredentialState> {
  let blob: string;
  try {
    blob = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        locations.keychainAccount,
        "-w",
        "-s",
        locations.keychainService,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    return keychainFailureState(error);
  }
  writeKeychainAccessMarkerBestEffort(locations);
  try {
    return extractCredentialState(
      { status: "success", value: JSON.parse(blob) },
      "keychain",
    );
  } catch {
    return {
      status: "invalid",
      source: {
        source: "keychain",
        status: "invalid",
        error: "json_parse_error",
      },
    };
  }
}

function hasKeychainAccessMarker(locations: ClaudeProfileLocations): boolean {
  return existsSync(locations.keychainAccessMarker);
}

function writeKeychainAccessMarkerBestEffort(
  locations: ClaudeProfileLocations,
): void {
  try {
    const file = locations.keychainAccessMarker;
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

export function claudeCredentialFile(): string {
  return resolveClaudeProfileLocations().credentialFile;
}

export function claudeKeychainService(): string {
  return resolveClaudeProfileLocations().keychainService;
}

export function claudeKeychainAccount(): string {
  let candidate = process.env.USER;
  if (!candidate) {
    try {
      candidate = userInfo().username;
    } catch {
      candidate = undefined;
    }
  }
  return candidate && SAFE_KEYCHAIN_ACCOUNT.test(candidate)
    ? candidate
    : DEFAULT_KEYCHAIN_ACCOUNT;
}

function resolveClaudeProfileLocations(): ClaudeProfileLocations {
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  const configDir = (configuredDir ?? join(homedir(), ".claude")).normalize(
    "NFC",
  );
  return locationsForConfigDir(
    configDir,
    configuredDir ? configDir : undefined,
  );
}

function primaryClaudeSeat(): ClaudeSeat {
  const locations = resolveClaudeProfileLocations();
  const configuredDir = process.env.CLAUDE_CONFIG_DIR;
  const name = safeSeatName(
    configuredDir
      ? basename((configuredDir || ".").normalize("NFC"))
      : "default",
  );
  return { name, locations, keychain: true };
}

export function resolveClaudeSeats(): ClaudeSeat[] {
  const primary = primaryClaudeSeat();
  const configuredDirs = process.env.CLAUDE_CONFIG_DIRS;
  const seats: ClaudeSeat[] = [];
  const seenFiles = new Set<string>();
  const seenNames = new Set<string>();
  const add = (seat: ClaudeSeat): void => {
    if (seenFiles.has(seat.locations.credentialFile)) return;
    const name = uniqueSeatName(seat.name, seenNames);
    seenFiles.add(seat.locations.credentialFile);
    seenNames.add(name);
    seats.push({ ...seat, name });
  };

  if (configuredDirs !== undefined) {
    if (existsSync(primary.locations.credentialFile)) add(primary);
    for (const configDir of configuredDirs
      .split(CLAUDE_CONFIG_DIRS_DELIMITER)
      .filter(Boolean)
      .sort()) {
      const normalized = configDir.normalize("NFC");
      add({
        name: safeSeatName(basename(normalized)),
        locations: locationsForConfigDir(normalized, normalized),
        keychain: false,
      });
    }
  } else if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    add(primary);
  } else {
    if (existsSync(primary.locations.credentialFile)) add(primary);
    for (const seat of discoverHouseSeats()) add(seat);
  }

  if (seats.length === 0) add(primary);
  return seats;
}

function discoverHouseSeats(): ClaudeSeat[] {
  const root = "/opt/claude";
  const seats: ClaudeSeat[] = [];
  const configRoot = join(root, "config");
  try {
    if (existsSync(configRoot)) {
      for (const entry of readdirSync(configRoot, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (!entry.isDirectory() || !SAFE_SEAT_NAME.test(entry.name)) continue;
        const configDir = join(configRoot, entry.name);
        const credentialFile = join(configDir, ".credentials.json");
        if (!existsSync(credentialFile)) continue;
        seats.push({
          name: entry.name,
          locations: locationsForConfigDir(configDir, undefined),
          keychain: false,
        });
      }
    }
    if (seats.length > 0 || !existsSync(root)) return seats;
    for (const entry of readdirSync(root, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      const match = /^credentials-([a-zA-Z0-9_-]+)\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) continue;
      const credentialFile = join(root, entry.name);
      seats.push({
        name: match[1],
        locations: locationsForCredentialFile(credentialFile),
        keychain: false,
      });
    }
  } catch {
    console.error("Claude house seat discovery failed");
  }
  return seats;
}

function locationsForConfigDir(
  configDir: string,
  keychainConfigDir?: string,
): ClaudeProfileLocations {
  const keychainAccount = claudeKeychainAccount();
  return {
    credentialFile: join(configDir, ".credentials.json"),
    keychainAccount,
    keychainService: keychainServiceForConfigDir(keychainConfigDir),
    keychainAccessMarker: claudeKeychainAccessMarkerPath(
      keychainAccount,
      keychainConfigDir,
    ),
  };
}

function locationsForCredentialFile(
  credentialFile: string,
): ClaudeProfileLocations {
  const keychainAccount = claudeKeychainAccount();
  return {
    credentialFile,
    keychainAccount,
    keychainService: DEFAULT_KEYCHAIN_SERVICE,
    keychainAccessMarker: claudeKeychainAccessMarkerPath(keychainAccount),
  };
}

function safeSeatName(value: string): string {
  return SAFE_SEAT_NAME.test(value) ? value : "default";
}

function uniqueSeatName(name: string, seen: Set<string>): string {
  if (!seen.has(name)) return name;
  let suffix = 2;
  while (seen.has(`${name}_${suffix}`)) suffix += 1;
  return `${name}_${suffix}`;
}

function keychainServiceForConfigDir(configDir?: string): string {
  if (!configDir) return DEFAULT_KEYCHAIN_SERVICE;
  const suffix = createHash("sha256")
    .update(configDir)
    .digest("hex")
    .slice(0, 8);
  return `${DEFAULT_KEYCHAIN_SERVICE}-${suffix}`;
}

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE
  );
}

function keychainFailureState(error: unknown): CredentialState {
  const failure = error as {
    killed?: boolean;
    signal?: string | null;
    code?: number | string | null;
  };
  if (failure.killed || failure.signal) {
    return {
      status: "skipped",
      source: {
        source: "keychain",
        status: "skipped",
        error: "keychain_prompt_timeout",
      },
    };
  }
  if (isKeychainItemNotFound(error)) {
    return {
      status: "missing",
      source: { source: "keychain", status: "missing" },
    };
  }
  return {
    status: "skipped",
    source: {
      source: "keychain",
      status: "skipped",
      error: "keychain_access_denied",
    },
  };
}

function extractCredentialState(
  raw: JsonFileReadResult,
  source: ClaudeCredentials["source"],
  path?: string,
): CredentialState {
  if (raw.status === "missing")
    return { status: "missing", source: { source, path, status: "missing" } };
  if (raw.status === "invalid")
    return {
      status: "invalid",
      source: { source, path, status: "invalid", error: raw.error },
    };
  const data = objectValue(raw.value);
  if (!data)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const oauth =
    data.claudeAiOauth && typeof data.claudeAiOauth === "object"
      ? (data.claudeAiOauth as Record<string, unknown>)
      : data;
  const accessToken =
    stringValue(oauth.accessToken) ?? stringValue(oauth.access_token);
  if (!accessToken)
    return { status: "invalid", source: { source, path, status: "invalid" } };
  const expiresAt = expiresAtMillis(oauth.expiresAt);
  const plan =
    stringValue(oauth.subscriptionType) ?? stringValue(data.subscriptionType);
  const credentials = { source, accessToken, plan, expiresAt };
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    return {
      status: "expired",
      credentials,
      source: { source, path, status: "expired" },
    };
  }
  return {
    status: "available",
    credentials,
  };
}

export function normalizeClaudeRateLimitHeaders(
  headers: Headers,
  plan?: string,
): ClaudeSeatQuota["quota"] | undefined {
  const fiveHourUtilization = parseHeaderRatio(
    headers.get("anthropic-ratelimit-unified-5h-utilization"),
  );
  const sevenDayUtilization = parseHeaderRatio(
    headers.get("anthropic-ratelimit-unified-7d-utilization"),
  );
  const fiveHourReset = parseHeaderEpoch(
    headers.get("anthropic-ratelimit-unified-5h-reset"),
  );
  const sevenDayReset = parseHeaderEpoch(
    headers.get("anthropic-ratelimit-unified-7d-reset"),
  );
  if (
    fiveHourUtilization === undefined ||
    sevenDayUtilization === undefined ||
    fiveHourReset === undefined ||
    sevenDayReset === undefined
  )
    return undefined;
  return {
    plan,
    windows: [
      withRemaining({
        id: "five_hour",
        label: "session",
        kind: "session",
        percentUsed: clampPercent(fiveHourUtilization * 100),
        resetsAt: fiveHourReset,
        windowSeconds: FIVE_HOURS_SECONDS,
      }),
      withRemaining({
        id: "seven_day",
        label: "week",
        kind: "weekly",
        percentUsed: clampPercent(sevenDayUtilization * 100),
        resetsAt: sevenDayReset,
        windowSeconds: SEVEN_DAYS_SECONDS,
      }),
    ],
    refreshedAt: nowIso(),
  };
}

async function fetchHeaderProbe(
  credentials: ClaudeCredentials,
): Promise<ClaudeSeatQuota["quota"] | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HEADER_PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(HEADER_PROBE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": OAUTH_BETA,
        Authorization: `Bearer ${credentials.accessToken}`,
      },
      body: JSON.stringify({
        model: HEADER_PROBE_MODEL,
        max_tokens: 1,
        messages: [{ role: "user", content: "." }],
      }),
      signal: controller.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new ClaudeFailure("Claude sign-in required", {
        status: "auth_required",
        definitiveAuth: true,
      });
    }
    if (!response.ok) return undefined;
    return normalizeClaudeRateLimitHeaders(response.headers, credentials.plan);
  } catch (error) {
    if (error instanceof ClaudeFailure) throw error;
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function parseHeaderRatio(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseHeaderEpoch(value: string | null): string | undefined {
  if (value === null || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const date = new Date(parsed * 1_000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

async function fetchOauthUsage(credentials: ClaudeCredentials): Promise<{
  plan?: string;
  account?: ProviderQuota["account"];
  identityError?: string;
  windows: QuotaWindow[];
  refreshedAt: string;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "anthropic-beta": OAUTH_BETA,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    rejectUnusableUsageResponse(response);
    const quota = normalizeClaudeApiUsage(
      await response.json(),
      credentials.plan,
    );
    if (!quota) throw new Error("Claude quota unavailable");
    const identity = await fetchOauthProfile(credentials);
    return {
      ...quota,
      account: identity.account,
      identityError: identity.error,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchOauthProfile(
  credentials: ClaudeCredentials,
): Promise<ClaudeIdentityResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(PROFILE_API_URL, {
      headers: {
        authorization: `Bearer ${credentials.accessToken}`,
        "User-Agent": CLAUDE_CODE_USER_AGENT,
        "Content-Type": "application/json",
        "Cache-Control": "no-cache",
        accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return unverifiedClaudeIdentity(
        `identity_profile_http_${response.status}`,
      );
    }
    const account = normalizeClaudeProfile(await response.json());
    return account
      ? { account }
      : unverifiedClaudeIdentity("identity_profile_unrecognized");
  } catch (error) {
    return unverifiedClaudeIdentity(
      error instanceof Error && error.name === "AbortError"
        ? "identity_profile_timeout"
        : "identity_profile_unavailable",
    );
  } finally {
    clearTimeout(timer);
  }
}

function unverifiedClaudeIdentity(error: string): ClaudeIdentityResult {
  return {
    account: { identityStatus: "unverified" },
    error,
  };
}

// Anthropic's OAuth usage endpoint follows plain HTTP semantics: 401/403 mean
// the access token no longer authenticates, and 429 means the caller must
// back off, honoring the standard `Retry-After` header (RFC 9110 - either a
// delay in seconds or an HTTP-date).
function rejectUnusableUsageResponse(response: Response): void {
  if (response.status === 401 || response.status === 403) {
    throw new ClaudeFailure("Claude sign-in required", {
      status: "auth_required",
      definitiveAuth: true,
    });
  }
  if (response.status === 429) {
    throw new ClaudeFailure("Claude quota endpoint rate limited", {
      status: "rate_limited",
      staleEligible: true,
      retryAfter: retryAfterToIso(response.headers.get("retry-after")),
    });
  }
  if (!response.ok) {
    throw new ClaudeFailure(`Claude quota unavailable (${response.status})`, {
      staleEligible: true,
    });
  }
}

function normalizeWindow(
  raw: unknown,
  id: string,
  label: string,
  kind: QuotaWindow["kind"],
): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as RawUsageWindow;
  const used =
    typeof data.utilization === "number" ? data.utilization : undefined;
  if (used === undefined) return undefined;
  const windowSeconds = trustedClaudeWindowSeconds(id, kind);
  return withRemaining({
    id,
    label,
    kind,
    percentUsed: clampPercent(used),
    resetsAt: stringValue(data.resets_at) ?? stringValue(data.reset_at),
    ...(windowSeconds !== undefined ? { windowSeconds } : {}),
  });
}

function trustedClaudeWindowSeconds(
  id: string,
  kind: QuotaWindow["kind"],
): number | undefined {
  if (id === "five_hour" || kind === "session") return FIVE_HOURS_SECONDS;
  if (
    id === "seven_day" ||
    id === "seven_day_opus" ||
    kind === "weekly" ||
    kind === "model"
  ) {
    return SEVEN_DAYS_SECONDS;
  }
  return undefined;
}

function normalizeExtraUsage(raw: unknown): QuotaWindow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as ExtraUsageWindow;
  if (data.is_enabled !== true) return undefined;
  const decimalPlaces =
    typeof data.decimal_places === "number" ? data.decimal_places : 2;
  const minorUnitDivisor = 10 ** decimalPlaces;
  const spentUsd =
    typeof data.used_credits === "number"
      ? data.used_credits / minorUnitDivisor
      : undefined;
  const limitUsd =
    typeof data.monthly_limit === "number"
      ? data.monthly_limit / minorUnitDivisor
      : undefined;
  const percentUsed =
    typeof data.utilization === "number"
      ? clampPercent(data.utilization)
      : spentUsd !== undefined && limitUsd && limitUsd > 0
        ? clampPercent((spentUsd / limitUsd) * 100)
        : undefined;
  return withRemaining({
    id: "extra_usage",
    label: "extra usage",
    kind: "credits",
    percentUsed,
    spentUsd,
    limitUsd,
  });
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function expiresAtMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError")
    return "Claude quota request timed out";
  return error instanceof Error ? error.message : "Claude quota unavailable";
}

class ClaudeFailure extends Error {
  readonly status: ProviderStatus;
  readonly definitiveAuth: boolean;
  readonly staleEligible: boolean;
  readonly retryAfter: string | undefined;

  constructor(
    readonly code: string,
    options: ClaudeFailureOptions = {},
  ) {
    super(code);
    this.name = "ClaudeFailure";
    this.status = options.status ?? statusFromError(code);
    this.definitiveAuth = options.definitiveAuth ?? false;
    this.staleEligible = options.staleEligible ?? false;
    this.retryAfter = options.retryAfter;
  }
}
