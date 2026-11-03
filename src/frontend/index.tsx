import { FolderArchive } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { setApp } from "./app";
import { ContainerFilesTab } from "./ContainerFilesTab";
import { trackActivePane } from "./paneFocus";
import { trackPointer } from "./popup/pointerTracker";
import { stopPageHideCleanup } from "./osClipboard";

export function activate(app: TermixApp): () => void {
  setApp(app);
  const stopPaneTracking = trackActivePane();
  const stopPointerTracking = trackPointer();
  // Host actions filter synchronously, so the permission is read once here.
  let canUse = true;
  void app.hasPermission("use").then((allowed) => {
    canUse = allowed;
  });
  const dispose = app.registerTab("container-files", ContainerFilesTab, {
    icon: FolderArchive,
    titleKey: "nav.containerFiles",
    requiresHost: true,
    noHostMessageKey: "containerFiles.noHostSelected",
    persistent: true,
    preload: () => import("./ContainerFileManager"),
  });
  const disposeAction = app.registerHostAction({
    id: "container-files",
    titleKey: "nav.containerFiles",
    icon: FolderArchive,
    kind: "open",
    order: 31,
    tabType: "container-files",
    copyUrlView: "container-files",
    when: (host) =>
      canUse &&
      !!host.enableSsh &&
      host.pluginSettings?.["container-files"]?.enableContainerFiles === true,
  });
  return () => {
    dispose();
    disposeAction?.();
    stopPaneTracking();
    stopPointerTracking();
    stopPageHideCleanup();
    setApp(null);
  };
}
