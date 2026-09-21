# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- [VISION.md](VISION.md) is the project's acceptance policy, co-authored with the repo owner against 17 recorded hypothetical verdicts; check a proposed surface against its closing aligns/resisted tests before building it.
  It deliberately sits ahead of today's implementation in places: accuracy of the reported number is the first obligation, and boundaries such as read-only and never-launch hold as "least action that yields a true reading" rather than as absolutes.
  README Security Posture remains the description of what actually ships today; do not restate VISION.md wording as a current guarantee.
- **Data-Only Axiom**: quota-axi reports local Claude, Codex, Cursor, GitHub Copilot, Grok, Kimi, Z.AI, Alibaba, OpenCode Go, Antigravity (`agy`), Command Code, MiniMax, MiMo, DeepSeek, OpenRouter, ElevenLabs, and Higgsfield quota windows. It must never route, recommend, rank a winner, order providers preferentially, proxy, intercept, log in, import browser cookies, or mint/rotate a credential.
- **Delegated Credential Refresh**: The single carve-out to the read-only boundary is shared in `src/providers/delegated-refresh.ts`. A delegate is eligible only when the same stored access token is expired, carries a refresh token, and was definitively rejected. quota-axi runs the vendor CLI's smallest non-interactive rotation command and re-reads the updated store. Quota-axi never performs token exchanges directly and never reads a refresh token's value - presence only. Child runs are never signaled; timed-out runs resolve as unconfirmed/stale without retiring the cache. Supported delegates: Claude (`claude doctor`), Grok (`grok models`), Codex (`app-server` probe). All other providers remain strictly read-only.
- **Data-Only Reconciliation**: quota-axi publishes a derived per-scope selection signal (`effectiveAvailability[].selection`) computed purely from figures it already reports. That is data, not routing - the consumer does any routing or ranking.
- **Minimal Shipped Skill**: The shipped skill (`skills/quota-axi/SKILL.md`) is a minimal stub generated from `src/skill.ts` via `pnpm run build:skill` that defers all actual guidance to the live CLI. quota-axi CLI output is the single source of truth.

## Repository Architecture & Modular Skills Index

The repository codebase is modularized across `src/` and accompanied by specialized repo skills in `skills/`:

- **CLI & Fast-Path**: `bin/quota-axi.ts` handles version checks via `axi-sdk-js/fast-path` and the leaf `src/version.ts` without loading the provider graph. Command parsing and dispatch live in `src/cli.ts` and `src/commands.ts`.
- **Interpretation & Pace**: Quota availability, bound conflict detection, cycle-average pace, runway estimation, and selection signal derivations are implemented in `src/interpretation.ts` and `src/pace.ts`.
- **Output Rendering**: Compact TOON, JSON/Full tier splitting, and human terminal interface (TUI) card layouts live in `src/render.ts`, `src/tui.ts`, `src/tui-live.ts`, and `src/tui-viewport.ts`.
- **Cache Storage**: Disk cache persistence (`0600`), cache exclusions, and context-scoping isolation live in `src/cache.ts`.
- **Providers & Credentials**: Adapters, credential selection machinery, and delegated refresh live under `src/providers/`.
- **Shared Libraries**: HTTP/proxy utilities, platform-safe process table listing, secret guards, and source attempt tracking live under `src/lib/`.

For detailed architecture, contracts, and implementation rules, consult the modular skills:

- [Provider Onboarding & Credential Architecture](skills/provider-onboarding/SKILL.md): The 4-step provider onboarding checklist, credential selection machinery (`src/providers/credential-selection.ts`), multi-source handover and degraded source tracking (`src/lib/source-attempts.ts`), delegated refresh rules, proxy handling, and mock boundaries.
- [Provider Adapters & Quirks](skills/provider-adapters/SKILL.md): Detailed specifications for all 17 supported providers, including credential resolution precedence, endpoint shapes, quota window models, bound conflicts, error recovery, and vendor-specific quirks.
- [Quota Cache Architecture & Context Scoping](skills/cache-architecture/SKILL.md): Cache file paths, permissions (`0600`), context-scoped providers (`CONTEXT_SCOPED_PROVIDERS` with SHA-256 context hashing), cache lifecycle exclusions, and Keychain access markers.
- [Quota Interpretation, Pace & Output Models](skills/quota-interpretation/SKILL.md): Bound conflict resolution (`effectiveAvailability[].boundConflict`), cycle-average pace calculations, runway derivation, selection signals, TOON 3-block layout invariants, JSON tier demotion, and interactive TUI viewport management.
- [Release Automation, CI & Contribution Gate](skills/release-ci/SKILL.md): Conventional commits, release-please lifecycle, npm OIDC publishing, workflow paths-ignore policies, contribution gate configuration (`.no-mistakes.yaml`, `no-mistakes-required.yml`), and Prettier lockfile formatting.

## Development & Validation

All tests and validation workflows run offline using synthetic credential stores and mocked boundaries. Never validate against live credentials or execute real Keychain (`security`), credential refresh, or provider network APIs.

```sh
pnpm install
pnpm run build
pnpm run lint
pnpm run format:check
pnpm test
pnpm run build:skill -- --check
```

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
