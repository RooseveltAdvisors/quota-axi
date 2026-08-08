import type {
  ProviderQuota,
  QuotaAxiResponse,
  SourceAttempt,
} from "./types.js";

export const KEYCHAIN_ACCESS_REASON = "keychain_access_required";
export const KEYCHAIN_ACCESS_REMEDY_COMMAND =
  "quota-axi --allow-keychain-prompt";
export const CREDENTIALS_EXPIRED_REASON = "credentials_expired";
export const GROK_TOKEN_REFRESH_REMEDY_COMMAND = "grok";
export const GROK_ACCESS_TOKEN_EXPIRED_ERROR = "Grok access token expired";
export const PI_TOKEN_REFRESH_REMEDY_COMMAND = "pi";
export const GROK_PI_ACCESS_TOKEN_EXPIRED_ERROR =
  "Grok access token expired in Pi";

const GROK_TOKEN_REMEDIES: Readonly<Record<string, string>> = {
  [GROK_ACCESS_TOKEN_EXPIRED_ERROR]: GROK_TOKEN_REFRESH_REMEDY_COMMAND,
  [GROK_PI_ACCESS_TOKEN_EXPIRED_ERROR]: PI_TOKEN_REFRESH_REMEDY_COMMAND,
};

const BLOCKED_CREDENTIAL_ERRORS = new Set([
  "credentials_expired",
  "credentials_missing",
]);

export function annotateQuotaAdvice(
  response: Omit<QuotaAxiResponse, "schemaVersion">,
): QuotaAxiResponse {
  const providers = response.providers.map(annotateProviderAdvice);
  const help = providers.flatMap(providerHelpLines);
  return {
    generatedAt: response.generatedAt,
    schemaVersion: 3,
    providers,
    ...(help.length > 0 ? { help } : {}),
  };
}

export function quotaHelpLines(response: QuotaAxiResponse): string[] {
  return [
    ...(response.help ?? []),
    "Default TOON reports effective headroom, usable runway, and pace diagnostics; use --full for account, source-attempt, and projection details",
    "Run `quota-axi --provider claude --json` for JSON output",
    "Run `quota-axi --full` to include account, source-attempt, and reserve details",
    "Run `quota-axi auth` to inspect local auth source availability without printing secrets",
  ];
}

function annotateProviderAdvice(provider: ProviderQuota): ProviderQuota {
  if (needsKeychainAccessAdvice(provider)) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: KEYCHAIN_ACCESS_REASON,
        remedyCommand: KEYCHAIN_ACCESS_REMEDY_COMMAND,
      },
    };
  }
  const grokRemedy = grokTokenRefreshRemedy(provider);
  if (grokRemedy) {
    return {
      ...provider,
      state: {
        ...provider.state,
        reason: CREDENTIALS_EXPIRED_REASON,
        remedyCommand: grokRemedy,
      },
    };
  }
  return provider;
}

function needsKeychainAccessAdvice(provider: ProviderQuota): boolean {
  const attempts = provider.attempts ?? [];
  return (
    provider.state.status !== "fresh" &&
    !attempts.some((attempt) => attempt.status === "success") &&
    attempts.some(isBlockedCredentialAttempt) &&
    attempts.some(isPromptBlockedKeychainAttempt)
  );
}

// The remedy depends on which local credential lapsed. The default quota path
// renews refreshable grants; these messages remain useful for --no-refresh.
function grokTokenRefreshRemedy(provider: ProviderQuota): string | undefined {
  if (provider.provider !== "grok" || provider.state.status === "fresh") {
    return undefined;
  }
  // Do not gate this source-specific advice on aggregate authStatus: Pi model
  // auth can remain usable while the independent Grok CLI session is expired.
  return provider.state.error
    ? GROK_TOKEN_REMEDIES[provider.state.error]
    : undefined;
}

function isBlockedCredentialAttempt(attempt: SourceAttempt): boolean {
  return (
    attempt.source !== "keychain" &&
    attempt.status === "skipped" &&
    Boolean(attempt.error && BLOCKED_CREDENTIAL_ERRORS.has(attempt.error))
  );
}

function isPromptBlockedKeychainAttempt(attempt: SourceAttempt): boolean {
  return (
    attempt.source === "keychain" &&
    attempt.status === "skipped" &&
    attempt.error === "keychain_prompt_required" &&
    attempt.credentialPresent === true
  );
}

function providerHelpLines(provider: ProviderQuota): string[] {
  if (hasKeychainAccessAdvice(provider))
    return [keychainAccessHelpLine(provider)];
  if (hasGrokTokenRefreshAdvice(provider, GROK_TOKEN_REFRESH_REMEDY_COMMAND)) {
    return [grokTokenRefreshHelpLine()];
  }
  if (hasGrokTokenRefreshAdvice(provider, PI_TOKEN_REFRESH_REMEDY_COMMAND)) {
    return [piTokenRefreshHelpLine()];
  }
  return [];
}

function hasKeychainAccessAdvice(provider: ProviderQuota): boolean {
  return (
    provider.state.reason === KEYCHAIN_ACCESS_REASON &&
    provider.state.remedyCommand === KEYCHAIN_ACCESS_REMEDY_COMMAND
  );
}

function hasGrokTokenRefreshAdvice(
  provider: ProviderQuota,
  remedyCommand: string,
): boolean {
  return (
    provider.state.reason === CREDENTIALS_EXPIRED_REASON &&
    provider.state.remedyCommand === remedyCommand
  );
}

function keychainAccessHelpLine(provider: ProviderQuota): string {
  return `Tell your user: run \`${KEYCHAIN_ACCESS_REMEDY_COMMAND}\` once and approve Keychain access ("Always Allow") so quota-axi can read ${provider.provider}'s live quota.`;
}

function grokTokenRefreshHelpLine(): string {
  return `Tell your user: rerun quota-axi without \`--no-refresh\` so it can renew Grok's local session token, or open the Grok CLI (\`${GROK_TOKEN_REFRESH_REMEDY_COMMAND}\`).`;
}

function piTokenRefreshHelpLine(): string {
  return `Tell your user: rerun quota-axi without \`--no-refresh\` so it can renew Pi's Grok OAuth grant, or run Pi (\`${PI_TOKEN_REFRESH_REMEDY_COMMAND}\`).`;
}
