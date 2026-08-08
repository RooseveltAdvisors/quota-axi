import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

type Environment = Record<string, string | undefined>;

export function loadUserEnv(environment: Environment = process.env): void {
  const configuredPath = environment.QUOTA_AXI_ENV_FILE;
  const configHome =
    environment.XDG_CONFIG_HOME ||
    join(environment.HOME || homedir(), ".config");
  const filePath = configuredPath || join(configHome, "quota-axi", "env");

  loadEnvFile(filePath, environment);
}

export function loadEnvFile(
  filePath: string,
  environment: Environment = process.env,
): void {
  let contents: string;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export "))
      line = line.slice("export ".length).trimStart();

    const separator = line.indexOf("=");
    if (separator <= 0) continue;

    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in environment) {
      continue;
    }

    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    environment[key] = value;
  }
}
