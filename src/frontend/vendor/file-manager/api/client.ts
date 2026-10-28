// Shim: the vendored File Manager code reaches the plugin API through here.
// Not part of the upstream sync; see vendor/README.md.
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { getApp } from "../../../app";

export function fileManagerApp(): TermixApp {
  return getApp();
}

export function fileManagerApi(): TermixApp["api"] {
  return getApp().api;
}
