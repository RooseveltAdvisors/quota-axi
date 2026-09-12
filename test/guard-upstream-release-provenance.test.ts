import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
 * probing, so a failure is attributable to that one field. Facts are keyed to
 * one upstream-known commit SHA; every other SHA the script probes gets the
 * API's Not Found, exactly as upstream would answer for a commit it does not
 * contain.
 */
interface UpstreamFacts {
  defaultBranch: string;
  reach: string;
  verified: string;
  signer: string;
  tree: string;
  blob: string;
  /** The single commit SHA the fake upstream knows about. */
  knownSha?: string;
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
let lastStderr: string;
let lastQueryLog: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

/**
 * A stand-in for the `gh` CLI that answers the four endpoints the script
 * calls. It reads its answers from the environment so each case can tamper
 * with one, and answers Not Found for every commit SHA except the one the
 * case nominates as upstream-known.
 */
function writeFakeGh(): void {
  const fake = [
    "#!/usr/bin/env bash",
    'if [ "${FAKE_FAIL:-}" = "1" ]; then echo "api error" >&2; exit 1; fi',
    'endpoint="$2"',
    'sha=""',
    'case "$endpoint" in',
    '  */compare/*) sha="${endpoint##*...}" ;;',
    '  */contents/*) sha="${endpoint##*ref=}" ;;',
    '  */commits/*) sha="${endpoint##*/commits/}" ;;',
    '  *) printf "%s\\n" "$FAKE_DEFAULT_BRANCH"; exit 0 ;;',
    "esac",
    'printf "%s\\n" "$sha" >>"$FAKE_LOG"',
    'if [ "$sha" != "$FAKE_KNOWN_SHA" ]; then echo "Not Found" >&2; exit 1; fi',
    'case "$endpoint" in',
    '  */compare/*) printf "%s\\n" "$FAKE_REACH" ;;',
    '  */contents/*) printf "%s\\n" "$FAKE_BLOB" ;;',
    '  *) printf "%s\\t%s\\t%s\\n" "$FAKE_VERIFIED" "$FAKE_SIGNER" "$FAKE_TREE" ;;',
    "esac",
  ].join("\n");
  const path = join(bin, "gh");
  writeFileSync(path, `${fake}\n`);
  chmodSync(path, 0o755);
}

/**
 * Runs the real script the way the workflow does - as a directly executed
 * executable, not via `bash <script>` - so a script committed without its
 * executable bit fails here just as it would in CI. Returns its exit code.
 */
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
  const log = join(dir, "gh-queries.log");
  rmSync(log, { force: true });
  const result = spawnSync(script, [base, head, GUARDED], {
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
      FAKE_KNOWN_SHA: facts.knownSha ?? head,
      FAKE_LOG: log,
      FAKE_FAIL: merged.fail ? "1" : "",
    },
  });
  lastStderr = result.stderr ?? "";
  lastQueryLog = existsSync(log) ? readFileSync(log, "utf8") : "";
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
    expect(lastQueryLog).toContain(head);
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
   * upstream provenance, so upstream answers Not Found for its SHA and the
   * guard still reports the violation. Author name and email are never
   * consulted, so a hand edit cannot buy the exemption by impersonating the
   * bot.
   */
  it("rejects a hand-edited commit that impersonates the release bot", () => {
    const releaseCommit = head;

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

    expect(run({ knownSha: releaseCommit })).toBe(1);
    expect(lastStderr).toContain("Not Found");
    expect(lastQueryLog).toContain(head);
  });

  /**
   * A mixed range must satisfy the all-commits requirement: the genuine
   * upstream release commit passes its own checks and the loop moves on to
   * the hand-edited commit, which upstream has never seen. A guard that only
   * inspected the newest commit would exempt this range and fail this test.
   */
  it("rejects when only some commits touching the path are upstream releases", () => {
    git(["checkout", "--quiet", "--detach", base]);

    writeFileSync(join(repo, GUARDED), "# Changelog\n\nhand edited\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "docs: tweak"]);
    const handEdited = git(["rev-parse", "HEAD"]);

    writeFileSync(join(repo, GUARDED), "# Changelog\n\n## 0.1.41\n");
    git(["add", "."]);
    git(["commit", "--quiet", "-m", "chore(main): release 0.1.41"]);
    head = git(["rev-parse", "HEAD"]);

    expect(run()).toBe(1);
    expect(lastStderr).toContain("Not Found");
    expect(lastQueryLog).toContain(handEdited);
  });
});
