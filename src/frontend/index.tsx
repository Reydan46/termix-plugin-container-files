import { FolderArchive } from "lucide-react";
import type { TermixApp } from "@termix-ssh/plugin-sdk/frontend";
import { setApp } from "./app";
import { ContainerFilesTab } from "./ContainerFilesTab";
import { trackActivePane } from "./paneFocus";
import { trackPointer } from "./popup/pointerTracker";
import { stopPageHideCleanup } from "./osClipboard";

export function activate(app: TermixApp): void {
  setApp(app);
  const stopPaneTracking = trackActivePane();
  const stopPointerTracking = trackPointer();
  const dispose = app.registerTab("container-files", ContainerFilesTab, {
    icon: FolderArchive,
    titleKey: "nav.containerFiles",
    requiresHost: true,
    noHostMessageKey: "containerFiles.noHostSelected",
    persistent: true,
    preload: () => import("./ContainerFileManager"),
  });
  // A frame answers a synchronous `when` with its default first and may not
  // ask again, so the permission is read before the action is registered.
  let disposeAction: (() => void) | undefined;
  let disposed = false;
  void app.hasPermission("use").then((allowed) => {
    if (!allowed || disposed) return;
    disposeAction = app.registerHostAction({
      id: "container-files",
      titleKey: "nav.containerFiles",
      icon: FolderArchive,
      kind: "open",
      order: 31,
      tabType: "container-files",
      copyUrlView: "container-files",
      when: (host) =>
        !!host.enableSsh &&
        host.pluginSettings?.["container-files"]?.enableContainerFiles === true,
    });
  });
  app.onDispose(() => {
    dispose();
    disposed = true;
    disposeAction?.();
    stopPaneTracking();
    stopPointerTracking();
    stopPageHideCleanup();
    setApp(null);
  });
}
