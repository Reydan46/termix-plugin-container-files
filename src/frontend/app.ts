import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";

let current: TermixApp | null = null;

/** Set in activate, cleared on deactivate. */
export function setApp(app: TermixApp | null): void {
  current = app;
}

export function getApp(): TermixApp {
  if (!current) throw new Error("The container files plugin is not active");
  return current;
}
