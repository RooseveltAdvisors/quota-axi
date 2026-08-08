const CLAUDE_SEAT_ACCOUNT_SCOPES = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "extra_usage",
  "all_models",
]);

export function splitClaudeSeatScope(
  scope: string,
): { seat: string; scope: string } | undefined {
  const separator = scope.indexOf(":");
  if (separator <= 0) return undefined;
  const seat = scope.slice(0, separator);
  const nestedScope = scope.slice(separator + 1);
  if (
    CLAUDE_SEAT_ACCOUNT_SCOPES.has(nestedScope) ||
    nestedScope.startsWith("model:")
  ) {
    return { seat, scope: nestedScope };
  }
  return undefined;
}
