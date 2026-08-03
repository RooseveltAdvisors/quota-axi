import { DESCRIPTION, TOP_HELP } from "./cli.js";

// Trigger string Claude Code (and other agents) match against to auto-load the skill.
// Kept terse and outcome-focused so it fires on "check quota/rate limits" intents.
export const SKILL_DESCRIPTION =
  "Report local Claude, Codex, Cursor, GitHub Copilot, Grok, and Kimi quota windows plus Alibaba Coding Plan entitlement data via the quota-axi CLI - remaining " +
  "percentages, reset times, cycle-average pace vs the reset clock, provider status, and Alibaba plan identity, expiry, models, and credential validity read from local auth sources. Alibaba usage is console-only, so quota-axi reports no numeric Alibaba quota or fabricated token metrics. " +
  "Short-lived local OAuth tokens may renew on read by default; use --no-refresh for a pure read. Use before deciding whether it is safe " +
  "to keep spending a provider's quota, when the user asks about usage, rate limits, pace, or " +
  "remaining quota, or when comparing local provider headroom.";

export const SKILL_AUTHOR = "Kun Chen (kunchenguid)";

// Extended frontmatter read by Nous Research's Hermes Agent harness
// (https://hermes-agent.nousresearch.com/docs/user-guide/features/skills).
// Harnesses that don't know these fields (e.g. Claude Code) ignore them.
export const HERMES_TAGS = [
  "quota",
  "rate-limits",
  "pace",
  "claude",
  "codex",
  "cursor",
  "copilot",
  "grok",
  "kimi",
  "alibaba",
  "cli",
];
export const HERMES_CATEGORY = "observability";

function yamlDoubleQuote(value: string): string {
  return JSON.stringify(value);
}

/**
 * Render the installable SKILL.md for the quota-axi skill. The body uses the
 * same shared CLI description and help text, then adds agent-facing workflow
 * guidance that prefers non-interactive `npx -y quota-axi ...` invocation so
 * the CLI comes along on demand.
 *
 * @returns full SKILL.md contents including YAML frontmatter
 */
export function createSkillMarkdown(): string {
  return `---
name: quota-axi
description: ${yamlDoubleQuote(SKILL_DESCRIPTION)}
user-invocable: false
author: ${SKILL_AUTHOR}
metadata:
  hermes:
    tags: [${HERMES_TAGS.join(", ")}]
    category: ${HERMES_CATEGORY}
---

# quota-axi

${DESCRIPTION}

You do not need quota-axi installed globally - invoke it with \`npx -y quota-axi\`.

quota-axi is data only: it never routes, recommends, proxies, intercepts, logs in, imports
browser cookies, or changes provider-side state. It reads local provider auth sources and calls
first-party provider quota, usage, billing, or entitlement endpoints. By default, near-expiry
Grok and Kimi OAuth grants may be renewed and atomically written back to their existing local
auth files; use \`--no-refresh\` or \`QUOTA_AXI_NO_REFRESH=1\` for a pure read. It never launches
the Claude, Grok, Pi, or Kimi CLIs, so it cannot spend the quota it measures.

## When to use

Use quota-axi whenever you need local quota headroom before deciding whether it is safe to
keep working on a provider, when the user asks about usage, rate limits, or remaining quota,
or when comparing supported local provider headroom side by side.

## Workflow

1. Run \`npx -y quota-axi\` for compact TOON output covering supported providers' quota windows and entitlement state.
2. Scope to one provider with \`--provider claude\` or to a subset with \`--provider cursor,copilot,grok,kimi,alibaba\`.
3. Pass \`--json\` for the normalized machine-readable model instead of TOON. Read
   \`quotaSemantics.effectiveAvailability\` rather than treating a model window in isolation:
   account windows can bound every model, and \`boundedBy\` names every window included in the
   effective percentage. Read each window's \`pace\` (and the effective scope's pace summary) to
   distinguish raw remaining capacity from whether usage is ahead of or behind the reset clock:
   negative \`reservePercentPoints\` means ahead/conserve. Default TOON already shows \`pace\` and
   signed \`reserve\` on window rows. If relationship status is \`partial\` or \`unknown\`, do not
   infer one. Stale reports keep raw windows for diagnostics, but effective availability and pace
   are always unknown; never route from a stale raw percentage as though it were current headroom.
   quota-axi never recommends a provider, model, or route.
4. Pass \`--full\` to include account identity and per-source attempt details.
5. Run \`npx -y quota-axi auth\` to check local auth-source availability without printing
   secret values.
6. Short-lived OAuth credentials renew on read by default only when a local refresh token is
   already available. Renewal uses a lock and atomic write, never exposes the refresh token, and
   fails closed if the grant is rejected. Pass \`--no-refresh\` or set
   \`QUOTA_AXI_NO_REFRESH=1\` to prevent refresh HTTP calls and credential-file writes. A timer
   remains optional backup for multi-process races.
7. On macOS, Claude Keychain value reads are pinned to the same validated current-user account
   Claude Code selects and are skipped by default until the user grants access once.
   If quota output reports \`reason: keychain_access_required\`, tell your user to run
   \`quota-axi --allow-keychain-prompt\` once and approve Keychain access ("Always Allow").
   After that successful grant, plain \`quota-axi\` calls reuse the existing Keychain access
   marker, scoped to both profile and account, to refresh live Claude quota without requiring
   the flag. Legacy markers are not reused, so an upgrade may require this one-time grant again.
8. If Grok reports \`reason: credentials_expired\` (or \`error: Grok access token expired\`) after
   a \`--no-refresh\` read, rerun without that flag so quota-axi can renew the local session, or
   open the Grok CLI (\`grok\`). A rejected renewal is an authentication failure, not fresh quota.
   If instead the error is \`Grok access token expired in Pi\` (\`remedyCommand: pi\`), the lapsed
   grant is Pi's; rerun without \`--no-refresh\` or run Pi.
9. For a managed Codex installation, set \`QUOTA_AXI_CODEX_BINARY\` to its absolute executable
   path. quota-axi uses that exact executable for auth inspection and the read-only app-server
   fallback, and fails closed if the override is invalid.
10. For Kimi, quota-axi prefers a Pi-managed \`kimi-coding\` credential from
   \`$PI_CODING_AGENT_DIR/auth.json\` (default \`~/.pi/agent/auth.json\`) - either a literal
   API key or an unexpired OAuth access token. If it is unavailable, quota-axi may reuse a
   fresh official Kimi Code CLI access token from
   \`$KIMI_CODE_HOME/credentials/kimi-code.json\` (default
   \`$HOME/.kimi-code/credentials/kimi-code.json\`), renewing near-expiry OAuth grants on read
   unless refresh is disabled.
11. If Kimi reports \`error: pi_credential_expired\` after \`--no-refresh\`, rerun without the
   flag so quota-axi can renew the grant, or run Pi. A rejected renewal is \`auth_required\`.
12. If Grok reports the \`pi:xai\` source, Grok is authenticated through Pi rather than through a
   \`~/.grok/auth.json\`. That fallback is used only when no Grok auth location is configured;
   setting \`$GROK_AUTH_JSON\`, \`$GROK_AUTH\`, \`$GROK_AUTH_PATH\`, or \`$GROK_HOME\` pins Grok
   to that location instead.
13. Alibaba Coding Plan is reported as an entitlement-only provider. Its Pi source is
   \`pi:alibaba-plan\` in \`$PI_CODING_AGENT_DIR/auth.json\` (default \`~/.pi/agent/auth.json\`).
   The report includes plan identity, period, region, expiry, models, and credential validity,
   but no fabricated numeric quota windows: Alibaba exposes Coding Plan usage only in its
   console. Alibaba's Pi \`refresh\` value stores endpoint configuration, not a refresh grant;
   expired credentials therefore fail closed, and \`--no-refresh\` remains a read-only escape hatch.

## Usage

\`\`\`
${TOP_HELP.trimEnd()}
\`\`\`

## Tips

- Output is TOON-encoded and token-efficient by default; pass \`--json\` only when you need
  the normalized schema.
- Pass \`--no-refresh\` when an operator requires zero local credential writes; the environment
  equivalent is \`QUOTA_AXI_NO_REFRESH=1\`.
- Exit code 0 means at least one provider returned data (fresh or stale); exit code 1 means
  every provider failed; exit code 2 means a usage error.
- Percentages are not comparable across providers - quota-axi never claims one provider's
  percentage equals another's.
- Claude \`--full\` output exposes the authoritative OAuth profile \`account.uuid\` as
  \`account.accountId\` when Anthropic returns one; otherwise the account identity is explicitly
  marked unverified rather than inferred.
- The quota cache at \`~/.cache/quota-axi/quotas.json\` only ever holds normalized
  non-secret snapshots.
  Fresh provider reports with no windows clear stale provider snapshots instead of caching
  empty quota.
  Claude local expiry metadata is advisory when an access token exists: the existing read-only
  usage request decides validity. Missing or invalid credentials without a usable token and HTTP
  401/403 retire Claude cache; only transient failures may use bounded, reset-pruned stale data.
  The Claude Keychain access marker lives alongside it, is scoped by hashed profile and
  account hashes, and contains no credential values or raw account name.
`;
}
