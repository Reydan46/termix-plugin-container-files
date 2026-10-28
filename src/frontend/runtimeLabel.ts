/** "Docker 29.0.1" / "Podman": the engine name with its version when known. */
export function runtimeLabel(
  runtime: "docker" | "podman" | null | undefined,
  version?: string | null,
): string {
  if (!runtime) return "";
  const name = runtime === "podman" ? "Podman" : "Docker";
  const v = version?.trim();
  return v ? `${name} ${v}` : name;
}
