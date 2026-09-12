import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const script = join(
  root,
  ".github",
  "scripts",
  "verify-upstream-release-provenance.sh",
);

const UPSTREAM = "kunchenguid/quota-axi";
const SIGNER = "github-actions[bot]";
const GUARDED = "CHANGELOG.md";

/**
 * Facts the fake upstream API reports. Each case overrides only what it is
 * probing, so a failure is attributable to that one field.
 */
interface UpstreamFacts {
  defaultBranch: string;
  reach: string;
  verified: string;
  signer: string;
  tree: string;
  blob: string;
  /** When set, every `gh api` call exits non-zero, simulating an API error. */
  fail?: boolean;
}

let dir: string;
let repo: string;
let bin: string;
let base: string;
let head: string;
let realTree: string;
let realBlob: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/**
 * A stand-in for the `gh` CLI that answers the four endpoints the script calls.
 * It reads its answers from the environment so each case can tamper with one.
 */
function writeFakeGh(): void {
  const fake = [
    "#!/usr/bin/env bash",
    'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "api error" >&2; exit 1; fi',
    'endpoint="$2"',
    'case "$endpoint" in',
    '  */compare/*) printf "%s\\n" "$FAKE_REACH" ;;',
    '  */contents/*) printf "%s\\n" "$FAKE_BLOB" ;;',
    '  */commits/*) printf "%s\\t%s\\t%s\\n" "$FAKE_VERIFIED" "$FAKE_SIGNER" "$FAKE_TREE" ;;',
    '  *) printf "%s\\n" "$FAKE_DEFAULT_BRANCH" ;;',
    "esac",
  ].join("\n");
  const path = join(bin, "gh");
  writeFileSync(path, `${fake}\n`);
  chmodSync(path, 0o755);
}

/** Runs the real script against the temp repo. Returns its exit code. */
function run(facts: Partial<UpstreamFacts> = {}): number {
  const merged: UpstreamFacts = {
    defaultBranch: "main",
    reach: "behind/0",
    verified: "true",
    signer: SIGNER,
    tree: realTree,
    blob: realBlob,
    ...facts,
  };
  const result = spawnSync("bash", [script, base, head, GUARDED], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      UPSTREAM_REPO: UPSTREAM,
      EXPECTED_SIGNER: SIGNER,
      FAKE_DEFAULT_BRANCH: merged.defaultBranch,
      FAKE_REACH: merged.reach,
      FAKE_VERIFIED: merged.verified,
      FAKE_SIGNER: merged.signer,
      FAKE_TREE: merged.tree,
      FAKE_BLOB: merged.blob,
      FAKE_FAIL: merged.fail ? "1" : "",
    },
  });
  return result.status ?? 1;
}

describe("verify-upstream-release-provenance.sh", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "guard-provenance-"));
    repo = join(dir, "repo");
    bin = join(dir, "bin");
    mkdirSync(repo);
    mkdirSync(bin);
    writeFakeGh();

    git(["init", "--quiet", "--initial-branch=main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "test"]);

    writeFileSync(join(repo, GUARDED), "# Changelog\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "base"]);
    base = git(["rev-parse", "HEAD"]);

    writeFileSync(join(repo, GUARDED), "# Changelog\n\n## 0.1.41\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "chore(main): release 0.1.41"]);
    head = git(["rev-parse", "HEAD"]);

    realTree = git(["rev-parse", "HEAD^{tree}"]);
    realBlob = git(["rev-parse", `HEAD:${GUARDED}`]);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("exempts a guarded file whose only commit is a verified upstream release", () => {
    expect(run()).toBe(0);
  });

  it("rejects a commit that upstream does not contain in its default branch", () => {
    expect(run({ reach: "diverged/3" })).toBe(1);
  });

  it("rejects a commit ahead of the upstream default branch", () => {
    expect(run({ reach: "ahead/1" })).toBe(1);
  });

  it("rejects a commit whose signature GitHub did not verify", () => {
    expect(run({ verified: "false" })).toBe(1);
  });

  it("rejects a commit GitHub resolves to a signer other than the release bot", () => {
    expect(run({ signer: "attacker" })).toBe(1);
  });

  it("rejects a commit with no resolved signer at all", () => {
    expect(run({ signer: "" })).toBe(1);
  });

  it("rejects a tree SHA that disagrees with the PR's own commit object", () => {
    expect(run({ tree: "0".repeat(40) })).toBe(1);
  });

  it("rejects a guarded-file blob SHA that disagrees with the PR's own object", () => {
    expect(run({ blob: "0".repeat(40) })).toBe(1);
  });

  it("fails closed when the upstream API errors", () => {
    expect(run({ fail: true })).toBe(1);
  });

  it("fails closed when a required field is missing", () => {
    expect(run({ tree: "" })).toBe(1);
  });

  /**
   * The case the exemption exists to distinguish: a hand edit carries no
   * upstream provenance, so the upstream lookups fail and the guard still
   * reports the violation. Author name and email are never consulted, so a
   * hand edit cannot buy the exemption by impersonating the bot.
   */
  it("rejects a hand-edited commit that impersonates the release bot", () => {
    writeFileSync(join(repo, GUARDED), "# Changelog\n\nhand edited\n");
    git(["add", "."]);
    git([
      "-c",
      `user.name=${SIGNER}`,
      "-c",
      "user.email=41898282+github-actions[bot]@users.noreply.github.com",
      "commit",
      "--quiet",
      "-m",
      "chore: sneak",
    ]);
    head = git(["rev-parse", "HEAD"]);

    // Upstream has never seen this commit, so its lookups fail.
    expect(run({ fail: true })).toBe(1);
  });

  it("rejects when only some commits touching the path are upstream releases", () => {
    writeFileSync(join(repo, GUARDED), "# Changelog\n\nhand edited\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "docs: tweak"]);
    head = git(["rev-parse", "HEAD"]);

    // The newest commit's blob no longer matches what upstream would report for
    // the release commit, so the all-commits requirement fails.
    expect(run({ blob: realBlob })).toBe(1);
  });
});
