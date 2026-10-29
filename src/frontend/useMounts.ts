import React from "react";
import { fetchMounts } from "./containerFsApi";
import { indexMounts, type MountInfo } from "./mountLookup";

/**
 * Mounts of one container, fetched once per connection and again whenever
 * `refreshKey` changes (container state change or reconnect). A failure
 * leaves the list empty: no badges, no error.
 */
export function useMounts(containerKey: string, refreshKey: unknown) {
  const [mounts, setMounts] = React.useState<MountInfo[]>([]);
  React.useEffect(() => {
    const controller = new AbortController();
    fetchMounts(containerKey, controller.signal)
      .then((list) => {
        if (!controller.signal.aborted) setMounts(list);
      })
      .catch(() => {
        if (!controller.signal.aborted) setMounts([]);
      });
    return () => controller.abort();
  }, [containerKey, refreshKey]);
  const index = React.useMemo(() => indexMounts(mounts), [mounts]);
  return { mounts, index };
}
