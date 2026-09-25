---
name: cache-architecture
description: "Cache storage locations, permissions, context scoping, isolation rules, and lifecycle management in quota-axi."
user-invocable: false
---

# Quota Cache Architecture & Context Scoping

This document details the disk caching architecture, file permissions, context-scoping mechanism, and data retention policies implemented in `src/cache.ts`.

---

## Cache Storage & Security

- **Path**: `~/.cache/quota-axi/quotas.json`, or `$XDG_CACHE_HOME/quota-axi/quotas.json` if `XDG_CACHE_HOME` is set.
- **File Permissions**: Cache files and parent directories must be created with strict `0600` (read/write by owner only) and `0700` permissions.
- **Normalized Data Only**: Cache records contain only normalized, non-secret quota snapshot structures.
- **Strict Prohibition**: Never persist raw HTTP responses, headers, authorization bearers, refresh tokens, API keys, or browser cookies.

---

## Context-Scoped Providers (`CONTEXT_SCOPED_PROVIDERS`)

To prevent cross-account or cross-environment cache poisoning, providers whose identity is configuration-dependent or slot-shared are enrolled in `CONTEXT_SCOPED_PROVIDERS` in `src/cache.ts`:

- **Enrolled Providers**: Claude, Kimi, Command Code, MiniMax, ElevenLabs, Devin, Codex.
- **Context Identifiers**: Snapshots carry an opaque SHA-256 context identifier derived from the answering configuration:
  - **Claude**: Hashed profile and credential-storage selection. `claudeCredentialContextId` appends an env marker so environment-token readings cannot be served as stale cache for stored-token accounts.
  - **Kimi**: Home path plus the slot and base URL resolved from `config.toml` (never the file contents, which contain keys). Prevents mainland China snapshots from serving as global fallbacks.
  - **Command Code**: Winning source plus the account identity validated by `whoami`.
  - **MiniMax**: Answering credential source plus deployment host.
  - **ElevenLabs**: Credential source plus a one-way SHA-256 digest of the answering API key.
  - **Devin**: Answering source and first-party host plus a one-way digest of the token that produced the reading (`devinReadingContextId` in `src/providers/devin-cache-context.ts`).
  - **Codex**: Hashed ChatGPT account ID stored by the specific credential that produced the reading (resolving collisions between lone discovered lanes and Pi entries).
- **Fallback Verification**: Stale cache fallback rejects legacy unstamped snapshots or snapshots whose context ID does not match the active configuration.
- **Codex exception**: Codex stamps are optional - `readCachedCodexProvider` withholds a snapshot only on a proven mismatch against the account ids the failed reading actually tried; a sibling never probed does not vouch for it, and a transient failure is vouched for only by its own credential. An unstamped snapshot, or a reading whose tried credentials name no account, proves nothing and is still served. Contract: [README Cache](../../README.md#cache).
- **Skip on Unconfirmed**: If a reading cannot confirm context identity (e.g. unreadable configuration), quota-axi skips both writing to cache and clearing the cache slot.

---

## Cache Lifecycle & Exclusions

The following fields and statuses are **never cached**:

- **Failed reads**: Any provider report with `state.status: "failed"` is never written to cache.
- **Stale reads**: Stale data is never re-persisted as fresh.
- **Account identities**: Explicit `account` objects are scrubbed before writing.
- **Source attempts**: `state.sourceAttempts` and attempt diagnostic logs are excluded.
- **Derived pace & runway**: `pace`, `runwaySeconds`, and selection signals are dynamic derivations computed from `generatedAt` vs current time. They must never be frozen into cache.

---

## Keychain Access Markers

- Stored alongside the cache directory in `~/.cache/quota-axi/`.
- Must have `0600` permissions.
- Filename is keyed by a hash of the selected service and account name. Contains no secret material.
- Permits non-prompting subsequent Keychain value reads once an initial grant is confirmed.
