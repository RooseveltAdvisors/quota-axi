import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { load as loadYaml } from "js-yaml";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowsDir = join(root, ".github", "workflows");

/**
 * Derive the exact release-please output set from config + workflow inputs.
 * Keep this aligned with the fleet audit rule: node -> package.json
 * (+ package-lock.json if present), changelog, extra-files, and the manifest.
 */
function loadWorkflow(filePath: string): Record<string, unknown> {
  const document = loadYaml(readFileSync(filePath, "utf8")) as
    | Record<string | boolean, unknown>
    | null
    | undefined;
  expect(document).not.toBeNull();
  expect(document).toBeDefined();
  return document as Record<string, unknown>;
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function configuredManifestFile(): string | undefined {
  const workflow = loadWorkflow(join(workflowsDir, "release-please.yml"));
  const jobs = objectValue(workflow.jobs);
  const releaseJob = objectValue(jobs?.["release-please"]);
  const steps = Array.isArray(releaseJob?.steps) ? releaseJob.steps : [];
  const releaseStep = steps.find(
    (step) => objectValue(step)?.uses === "googleapis/release-please-action@v4",
  );
  const inputs = objectValue(objectValue(releaseStep)?.with);
  const manifest = inputs?.["manifest-file"];
  return typeof manifest === "string" ? manifest : undefined;
}

function expectedReleaseOutputs(): string[] {
  const config = JSON.parse(
    readFileSync(join(root, "release-please-config.json"), "utf8"),
  ) as {
    "release-type"?: string;
    "changelog-path"?: string;
    "version-file"?: string;
    "extra-files"?: Array<string | { path?: string }>;
    packages?: Record<
      string,
      {
        "release-type"?: string;
        "changelog-path"?: string;
        "version-file"?: string;
        "extra-files"?: Array<string | { path?: string }>;
      }
    >;
  };

  const pkg = config.packages?.["."] ?? {};
  const releaseType = pkg["release-type"] ?? config["release-type"] ?? "node";
  const changelog =
    pkg["changelog-path"] ?? config["changelog-path"] ?? "CHANGELOG.md";

  const expected = [changelog];
  switch (releaseType) {
    case "simple":
      expected.push(
        pkg["version-file"] ?? config["version-file"] ?? "version.txt",
      );
      break;
    case "node":
      expected.push("package.json");
      if (existsSync(join(root, "package-lock.json"))) {
        expected.push("package-lock.json");
      }
      break;
    case "go":
      break;
    default:
      throw new Error(
        `unsupported release-please release-type for ignore derivation: ${releaseType}`,
      );
  }

  const extra = pkg["extra-files"] ?? config["extra-files"] ?? [];
  for (const entry of extra) {
    const path = typeof entry === "string" ? entry : entry?.path;
    if (path) expected.push(path);
  }

  expected.push(configuredManifestFile() ?? ".release-please-manifest.json");

  return [...new Set(expected)];
}

function loadWorkflowOn(filePath: string): Record<string, unknown> | null {
  const doc = loadWorkflow(filePath);
  // js-yaml may parse a bare `on:` key as boolean true.
  const on = doc.on ?? doc.true ?? null;
  if (on == null || typeof on !== "object" || Array.isArray(on)) return null;
  return on as Record<string, unknown>;
}

type PathFilter =
  | { kind: "unfiltered" }
  | { kind: "paths-ignore"; paths: string[] }
  | { kind: "paths"; paths: string[] };

function pullRequestFilterCoverage(pr: unknown): PathFilter {
  if (pr == null) {
    return { kind: "unfiltered" };
  }
  if (typeof pr !== "object" || Array.isArray(pr)) {
    // `pull_request:` bare form means no path filter.
    return { kind: "unfiltered" };
  }

  const record = pr as Record<string, unknown>;
  if (Array.isArray(record["paths-ignore"])) {
    return {
      kind: "paths-ignore",
      paths: record["paths-ignore"].map(String),
    };
  }

  if (Array.isArray(record.paths)) {
    return { kind: "paths", paths: record.paths.map(String) };
  }

  return { kind: "unfiltered" };
}

function globMatch(pattern: string, path: string): boolean {
  // Minimal support for the `**` / `*` patterns used in workflow path filters.
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "::DOUBLE::")
    .replace(/\*/g, "[^/]*")
    .replace(/::DOUBLE::/g, ".*");
  return new RegExp(`^${escaped}$`).test(path);
}

function isCovered(filter: PathFilter, releasePath: string): boolean {
  if (filter.kind === "unfiltered") return false;

  if (filter.kind === "paths-ignore") {
    return filter.paths.includes(releasePath);
  }

  // paths allow-list: a release path is "covered" (will not create a run on its
  // own) when no positive pattern matches it, or a later negation excludes it.
  let matched = false;
  for (const pattern of filter.paths) {
    if (pattern.startsWith("!")) {
      const negated = pattern.slice(1);
      if (
        matched &&
        (negated === releasePath || globMatch(negated, releasePath))
      ) {
        matched = false;
      }
      continue;
    }
    if (pattern === releasePath || globMatch(pattern, releasePath)) {
      matched = true;
    }
  }
  // Covered means the path does NOT cause the workflow to run.
  return !matched;
}

describe("release-please CI exclusions", () => {
  const expected = expectedReleaseOutputs();

  it("derives the node release-output set for this repository", () => {
    expect(expected).toEqual([
      "CHANGELOG.md",
      "package.json",
      ".release-please-manifest.json",
    ]);
  });

  it("filters release outputs from build workflows", () => {
    const files = readdirSync(workflowsDir).filter((name) =>
      name.endsWith(".yml"),
    );
    const prWorkflows: Array<{ name: string; filter: PathFilter }> = [];

    for (const name of files) {
      const filePath = join(workflowsDir, name);
      const on = loadWorkflowOn(filePath);
      if (!on || (!("pull_request" in on) && !("pull_request_target" in on)))
        continue;
      const trigger = on.pull_request ?? on.pull_request_target;
      prWorkflows.push({
        name,
        filter: pullRequestFilterCoverage(trigger),
      });
    }

    expect(prWorkflows.map((w) => w.name).sort()).toEqual([
      "ci.yml",
      "guard-generated-files.yml",
      "no-mistakes-required.yml",
    ]);
    expect(
      prWorkflows.find(
        (workflow) => workflow.name === "guard-generated-files.yml",
      )?.filter,
    ).toMatchObject({
      kind: "paths-ignore",
      paths: expect.arrayContaining(expected),
    });

    expect(
      prWorkflows.find(
        (workflow) => workflow.name === "no-mistakes-required.yml",
      )?.filter,
    ).toEqual({ kind: "unfiltered" });

    const failures: string[] = [];
    for (const { name, filter } of prWorkflows) {
      if (name === "no-mistakes-required.yml") continue;
      const missing = expected.filter((path) => !isCovered(filter, path));
      if (missing.length > 0) {
        failures.push(`${name} missing coverage for: ${missing.join(", ")}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("does not attach path filters to non-pull_request triggers on ci.yml", () => {
    const on = loadWorkflowOn(join(workflowsDir, "ci.yml"));
    expect(on).not.toBeNull();
    expect(on!.push).toEqual({ branches: ["main"] });
    const pr = on!.pull_request as Record<string, unknown>;
    expect(pr.branches).toEqual(["main"]);
    expect(pr["paths-ignore"]).toEqual([
      ".release-please-manifest.json",
      "CHANGELOG.md",
      "package.json",
    ]);
    expect(on!.release).toBeUndefined();
    expect(on!.workflow_dispatch).toBeUndefined();
  });
});
