// Context-window size lookup by model id, with an env override.
//
// Model ids embed their generation precisely (e.g. "claude-sonnet-5",
// "claude-sonnet-4-6", "claude-sonnet-4-5-20250929"), so matching on the
// version-tagged substring — not a bare family name — tells a 1M-context
// Sonnet apart from a 200K one without guessing.
export function windowFor(model: string, envOverride?: string): number {
  const override = parseInt(envOverride ?? "", 10);
  if (Number.isFinite(override) && override > 0) return override;
  const m = (model || "").toLowerCase();
  // 1M-context families: Opus (4.5+), Fable 5, Mythos 5, Sonnet 5 (and
  // later 5.x), and Sonnet 4.6. Haiku (200K) and Sonnet 4.5 (200K) fall
  // through to the default.
  if (m.includes("opus") || m.includes("fable") || m.includes("mythos")) return 1_000_000;
  if (m.includes("sonnet-5") || m.includes("sonnet-4-6")) return 1_000_000;
  return 200_000;
}
