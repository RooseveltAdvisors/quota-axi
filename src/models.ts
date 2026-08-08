import { MODEL_CATALOG } from "./model-kb.js";
import type {
  EffectiveAvailability,
  IntelligenceBucket,
  ModelCatalog,
  ModelCatalogEntry,
  ModelQuotaRecord,
  ModelReference,
  ModelSortKey,
  ModelsResponse,
  ProviderId,
  ProviderQuota,
  ProviderStateSummary,
  QuotaAxiResponse,
} from "./types.js";

const INTELLIGENCE_BUCKETS = new Set<IntelligenceBucket>([
  "high",
  "medium",
  "low",
]);
export const MODEL_CATALOG_PROVIDER_IDS: readonly ProviderId[] = [
  ...new Set(MODEL_CATALOG.entries.map((entry) => entry.provider)),
];
const MODEL_KB_PROVIDERS = new Set<ProviderId>(MODEL_CATALOG_PROVIDER_IDS);

export const MODEL_SORT_KEYS = [
  "runway",
] as const satisfies readonly ModelSortKey[];

export type ModelComparator = {
  compare: (left: ModelQuotaRecord, right: ModelQuotaRecord) => number;
  tieKey: (model: ModelQuotaRecord) => string;
};

/**
 * Registry for explicit, evidence-only ordering. New comparators (such as a
 * future cost comparator) belong here with their data dependency and docs.
 */
export const MODEL_COMPARATORS: Readonly<
  Record<ModelSortKey, ModelComparator>
> = {
  runway: {
    compare: compareModelsByRunway,
    tieKey: runwayTieKey,
  },
};

validateModelCatalog(MODEL_CATALOG);

export function createModelsResponse(
  quota: QuotaAxiResponse,
  options: {
    intelligence?: IntelligenceBucket;
    sort?: ModelSortKey;
    catalog?: ModelCatalog;
  } = {},
): ModelsResponse {
  const catalog = options.catalog ?? MODEL_CATALOG;
  validateModelCatalog(catalog);
  const providers = new Map(
    quota.providers.map((provider) => [provider.provider, provider]),
  );
  const models = catalog.entries
    .filter(
      (entry) =>
        providers.has(entry.provider) &&
        (options.intelligence === undefined ||
          entry.intelligence === options.intelligence),
    )
    .flatMap((entry) => modelRecords(entry, providers.get(entry.provider)!))
    .sort(compareModelIdentity);
  const unmatchedWindowIds = quota.providers.flatMap((provider) =>
    unmatchedModelWindowIds(provider, catalog.entries),
  );

  if (!options.sort) {
    return {
      generatedAt: quota.generatedAt,
      schemaVersion: 1,
      catalog: catalogSummary(catalog),
      models,
      ...(unmatchedWindowIds.length > 0 ? { unmatchedWindowIds } : {}),
    };
  }

  const comparator = MODEL_COMPARATORS[options.sort];
  const sorted = [...models].sort(
    (left, right) =>
      comparator.compare(left, right) || compareModelIdentity(left, right),
  );
  return {
    generatedAt: quota.generatedAt,
    schemaVersion: 1,
    catalog: catalogSummary(catalog),
    models: sorted,
    ...(unmatchedWindowIds.length > 0 ? { unmatchedWindowIds } : {}),
    sort: {
      key: options.sort,
      tieGroups: tieGroups(sorted, comparator),
    },
  };
}

/**
 * Sort by observable usable runway only. It does not assess model capability,
 * task fit, credentials, prices, or a route. Unknown evidence remains last.
 */
export function compareModelsByRunway(
  left: ModelQuotaRecord,
  right: ModelQuotaRecord,
): number {
  const leftRank = runwayRank(left);
  const rightRank = runwayRank(right);
  if (leftRank !== rightRank) return leftRank - rightRank;
  if (leftRank !== 0) return 0;
  return (
    (right.effective?.runway?.usableRunwaySeconds ?? 0) -
    (left.effective?.runway?.usableRunwaySeconds ?? 0)
  );
}

export function validateModelCatalog(catalog: ModelCatalog): void {
  const versionTimestamp = Date.parse(`${catalog.version}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(catalog.version) ||
    Number.isNaN(versionTimestamp) ||
    new Date(versionTimestamp).toISOString().slice(0, 10) !== catalog.version
  ) {
    throw new Error("model catalog version must be an ISO calendar date");
  }
  if (!catalog.provenance.trim())
    throw new Error("model catalog provenance is required");

  const seen = new Set<string>();
  for (const entry of catalog.entries) {
    if (!MODEL_KB_PROVIDERS.has(entry.provider)) {
      throw new Error(
        `model catalog provider is unsupported: ${entry.provider}`,
      );
    }
    if (!entry.id.trim() || !entry.label.trim()) {
      throw new Error("model catalog entries require id and label");
    }
    if (!INTELLIGENCE_BUCKETS.has(entry.intelligence)) {
      throw new Error(
        `model catalog intelligence is invalid: ${entry.intelligence}`,
      );
    }
    const key = `${entry.provider}/${entry.id}`;
    if (seen.has(key)) throw new Error(`duplicate model catalog entry: ${key}`);
    seen.add(key);
    for (const windowId of entry.windowIds ?? []) {
      if (!/^model:[a-z0-9][a-z0-9_.:-]*$/i.test(windowId)) {
        throw new Error(`model catalog window id is invalid: ${windowId}`);
      }
    }
  }
}

type ModelEvidence = {
  effective: EffectiveAvailability;
  seat?: string;
};

function modelRecords(
  entry: ModelCatalogEntry,
  provider: ProviderQuota,
): ModelQuotaRecord[] {
  const evidence = availabilityFor(entry, provider);
  if (evidence.length === 0) {
    return [
      {
        provider: entry.provider,
        id: entry.id,
        label: entry.label,
        intelligence: entry.intelligence,
        quotaScopes: [],
        state: stateSummary(provider),
      },
    ];
  }
  return evidence.map(({ effective, seat }) => ({
    provider: entry.provider,
    id: entry.id,
    label: entry.label,
    intelligence: entry.intelligence,
    ...(seat === undefined ? {} : { seat }),
    quotaScopes: [effective.scope],
    effective,
    state: stateSummary(provider),
  }));
}

function availabilityFor(
  entry: ModelCatalogEntry,
  provider: ProviderQuota,
): ModelEvidence[] {
  const availability = provider.quotaSemantics?.effectiveAvailability ?? [];
  const seatNames =
    provider.provider === "claude"
      ? claudeSeatNames(provider, availability)
      : [];

  if (seatNames.length > 0) {
    return seatNames.flatMap((seat) => {
      const specific = (entry.windowIds ?? [])
        .map((windowId) => normalizedModelScope(windowId))
        .map((scope) =>
          availability.find(
            (candidate) => candidate.scope === `${seat}:${scope}`,
          ),
        )
        .find((candidate): candidate is EffectiveAvailability =>
          Boolean(candidate),
        );
      const effective =
        specific ??
        availability.find(
          (candidate) => candidate.scope === `${seat}:all_models`,
        );
      return effective ? [{ effective, seat }] : [];
    });
  }

  for (const windowId of entry.windowIds ?? []) {
    const found = availability.find(
      (candidate) => candidate.scope === normalizedModelScope(windowId),
    );
    if (found) return [{ effective: found }];
  }
  const fallback = availability.find(
    (candidate) =>
      candidate.scope === "all_models" || candidate.scope === "all_products",
  );
  return fallback ? [{ effective: fallback }] : [];
}

function claudeSeatNames(
  provider: ProviderQuota,
  availability: EffectiveAvailability[],
): string[] {
  const names = new Set<string>();
  for (const scope of [
    ...provider.windows.map(({ id }) => normalizedModelScope(id)),
    ...availability.map(({ scope }) => normalizedModelScope(scope)),
  ]) {
    const split = splitClaudeSeatScope(scope);
    if (split) names.add(split.seat);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function splitClaudeSeatScope(
  scope: string,
): { seat: string; scope: string } | undefined {
  const separator = scope.indexOf(":");
  if (separator <= 0) return undefined;
  const seat = scope.slice(0, separator);
  const nestedScope = scope.slice(separator + 1);
  if (
    ["five_hour", "seven_day", "extra_usage", "all_models"].includes(
      nestedScope,
    ) ||
    nestedScope.startsWith("model:")
  ) {
    return { seat, scope: nestedScope };
  }
  return undefined;
}

function unmatchedModelWindowIds(
  provider: ProviderQuota,
  entries: ModelCatalogEntry[],
): string[] {
  const seatNames =
    provider.provider === "claude" ? claudeSeatNames(provider, []) : [];
  const knownScopes = new Set(
    entries
      .filter((entry) => entry.provider === provider.provider)
      .flatMap((entry) =>
        (entry.windowIds ?? [])
          .map(normalizedModelScope)
          .flatMap((scope) => [
            scope,
            ...seatNames.map((seat) => `${seat}:${scope}`),
          ]),
      ),
  );
  const unmatchedScopes = new Set<string>();
  return provider.windows
    .filter((window) => window.kind === "model")
    .map((window) => normalizedModelScope(window.id))
    .filter((scope) => !knownScopes.has(scope))
    .filter((scope) => {
      if (unmatchedScopes.has(scope)) return false;
      unmatchedScopes.add(scope);
      return true;
    })
    .map((scope) => `${provider.provider}/${scope}`);
}

function normalizedModelScope(windowId: string): string {
  return windowId.replace(/_\d+$/, "").replace(/:(?:5h|7d|window:[^:]+)$/, "");
}

function stateSummary(provider: ProviderQuota): ProviderStateSummary {
  const { status, stale, authStatus, reason, remedyCommand } = provider.state;
  return {
    status,
    stale,
    ...(authStatus ? { authStatus } : {}),
    ...(reason ? { reason } : {}),
    ...(remedyCommand ? { remedyCommand } : {}),
  };
}

function catalogSummary(catalog: ModelCatalog) {
  return { version: catalog.version, provenance: catalog.provenance };
}

function compareModelIdentity(
  left: ModelReference,
  right: ModelReference,
): number {
  return (
    left.provider.localeCompare(right.provider) ||
    left.id.localeCompare(right.id) ||
    (left.seat ?? "").localeCompare(right.seat ?? "")
  );
}

function runwayRank(model: ModelQuotaRecord): number {
  const runway = model.effective?.runway;
  if (
    runway?.status === "projected_exhaustion" &&
    runway.usableRunwaySeconds !== undefined
  )
    return 0;
  if (runway?.status === "through_reset") return 1;
  if (runway?.status === "exhausted_now") return 2;
  return 3;
}

function runwayTieKey(model: ModelQuotaRecord): string {
  const rank = runwayRank(model);
  return rank === 0
    ? `finite:${model.effective?.runway?.usableRunwaySeconds}`
    : ["through_reset", "exhausted_now", "unknown"][rank - 1]!;
}

function tieGroups(
  models: ModelQuotaRecord[],
  comparator: ModelComparator,
): ModelReference[][] {
  const groups: ModelReference[][] = [];
  for (let index = 0; index < models.length; ) {
    const key = comparator.tieKey(models[index]!);
    const group: ModelReference[] = [];
    while (index < models.length && comparator.tieKey(models[index]!) === key) {
      const model = models[index++]!;
      group.push({
        provider: model.provider,
        id: model.id,
        ...(model.seat === undefined ? {} : { seat: model.seat }),
      });
    }
    if (group.length > 1) groups.push(group);
  }
  return groups;
}
