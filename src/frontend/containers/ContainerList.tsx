import React from "react";
import { Box } from "lucide-react";
import { useTranslation } from "@termix-ssh/plugin-sdk/frontend";
import { Card, DataView, type GridSize } from "@termix-ssh/plugin-sdk/ui";
import { containerName, type ContainerInfo } from "../types";
import type { ContainerLiveState } from "../containerFsApi";
import { ContainerActions } from "./ContainerActions";

// Layout, wording and the hover actions follow the Docker plugin's container
// list (Apache-2.0); removing containers is left out.

export function StateBadge({ state }: { state: string }) {
  let colorClass = "border-border text-muted-foreground";
  if (state === "running")
    colorClass = "border-accent-brand/40 text-accent-brand bg-accent-brand/10";
  if (state === "paused")
    colorClass = "border-warning/40 text-warning bg-warning/10";
  if (state === "exited")
    colorClass = "border-destructive/40 text-destructive bg-destructive/5";
  if (state === "restarting")
    colorClass = "border-blue-400/40 text-blue-400 bg-blue-400/10";
  return (
    <span
      className={`text-[10px] font-bold px-1.5 py-0.5 border uppercase tracking-wider ${colorClass}`}
    >
      {state}
    </span>
  );
}

export function filterContainers(
  containers: ContainerInfo[],
  search: string,
  statusFilter: string,
): ContainerInfo[] {
  const needle = search.toLowerCase();
  return containers.filter(
    (c) =>
      (containerName(c).toLowerCase().includes(needle) ||
        c.image.toLowerCase().includes(needle) ||
        c.id.toLowerCase().includes(needle)) &&
      (statusFilter === "all" || c.state === statusFilter),
  );
}

function splitPorts(ports: string): string[] {
  return (ports ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

function Empty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full opacity-20 py-20">
      <Box className="size-16 mb-4" />
      <span className="text-xl font-bold uppercase tracking-widest">
        {title}
      </span>
      <span className="text-xs font-semibold">{hint}</span>
    </div>
  );
}

interface ListProps {
  containers: ContainerInfo[];
  columns?: GridSize;
  onSelectContainer: (containerId: string) => void;
  search?: string;
  statusFilter?: string;
  sessionId: string;
  /** An action finished (state given) or failed (null): refresh that row. */
  onChanged: (id: string, state: ContainerLiveState | null) => void;
}

function useFiltered(props: ListProps) {
  const { containers, search = "", statusFilter = "all" } = props;
  return React.useMemo(
    () => filterContainers(containers, search, statusFilter),
    [containers, search, statusFilter],
  );
}

function useEmpty(props: ListProps, filteredCount: number) {
  const { t } = useTranslation();
  if (props.containers.length === 0)
    return (
      <Empty
        title={t("containers.noneFound")}
        hint={t("containers.noneFoundHint")}
      />
    );
  if (filteredCount === 0)
    return (
      <Empty
        title={t("containers.noneMatch")}
        hint={t("containers.noneMatchHint")}
      />
    );
  return null;
}

export function ContainerList(props: ListProps): React.ReactElement {
  const { t } = useTranslation();
  const filtered = useFiltered(props);
  const empty = useEmpty(props, filtered.length);
  if (empty) return empty;

  return (
    <DataView
      items={filtered}
      view="grid"
      getKey={(container) => container.id}
      renderCard={(container) => {
        const ports = splitPorts(container.ports);
        return (
          <Card
            className="group flex flex-col overflow-hidden p-0 gap-0 hover:border-accent-brand/40 transition-colors cursor-pointer"
            onClick={() => props.onSelectContainer(container.id)}
          >
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/10">
              <div className="flex items-center gap-2 min-w-0">
                <Box
                  className={`size-3.5 ${container.state === "running" ? "text-accent-brand" : "text-muted-foreground"}`}
                />
                <span className="text-sm font-bold truncate">
                  {containerName(container)}
                </span>
              </div>
              <StateBadge state={container.state} />
            </div>
            <div className="px-4 py-3 flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                  {t("containers.image")}
                </span>
                <span className="text-xs font-mono truncate text-foreground/80">
                  {container.image}
                </span>
              </div>
              <div className="flex flex-col gap-0.5 mt-1">
                <span className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
                  {t("containers.ports")}
                </span>
                <div className="flex flex-wrap gap-1 mt-0.5">
                  {ports.length > 0 ? (
                    ports.slice(0, 3).map((p) => (
                      <span
                        key={p}
                        className="text-[10px] font-mono px-1 border border-border bg-muted/30"
                      >
                        {p}
                      </span>
                    ))
                  ) : (
                    <span className="text-[10px] text-muted-foreground italic">
                      {t("containers.noPorts")}
                    </span>
                  )}
                </div>
              </div>
            </div>
            <div className="mt-auto px-4 py-2 border-t border-border bg-muted/5 flex items-center justify-between opacity-0 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100 transition-opacity">
              <span className="text-[10px] text-muted-foreground italic">
                {container.id.substring(0, 12)}
              </span>
              <ContainerActions
                sessionId={props.sessionId}
                container={container}
                onChanged={props.onChanged}
              />
            </div>
          </Card>
        );
      }}
      columns={{ base: 1, md: 2, lg: 3, xl: 4 }}
      size={props.columns ?? "auto"}
      minCardWidth={300}
      listColumns={[]}
      empty={null}
    />
  );
}

export function ContainerTable(props: ListProps): React.ReactElement {
  const { t } = useTranslation();
  const filtered = useFiltered(props);
  const empty = useEmpty(props, filtered.length);
  if (empty) return empty;

  const heads = ["name", "image", "state", "ports", "status"] as const;
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden border border-border bg-card">
      <div className="min-h-0 flex-1 overflow-y-auto thin-scrollbar">
        <table className="w-full border-collapse text-xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-[10px] uppercase tracking-wider text-muted-foreground">
              {heads.map((h) => (
                <th key={h} className="px-3 py-2 text-left font-semibold">
                  {t(`containers.${h}`)}
                </th>
              ))}
              <th className="w-px px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {filtered.map((container) => {
              const ports = splitPorts(container.ports);
              return (
                <tr
                  key={container.id}
                  onClick={() => props.onSelectContainer(container.id)}
                  className="cursor-pointer transition-colors hover:bg-muted/40"
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Box
                        className={`size-3.5 shrink-0 ${container.state === "running" ? "text-accent-brand" : "text-muted-foreground"}`}
                      />
                      <span className="min-w-0 truncate font-semibold">
                        {containerName(container)}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 max-w-[220px]">
                    <span className="block truncate font-mono text-muted-foreground">
                      {container.image}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    <StateBadge state={container.state} />
                  </td>
                  <td className="px-3 py-2 max-w-[200px]">
                    {ports.length > 0 ? (
                      <div className="flex flex-wrap gap-1">
                        {ports.slice(0, 2).map((p) => (
                          <span
                            key={p}
                            className="text-[10px] font-mono px-1 border border-border bg-muted/30"
                          >
                            {p}
                          </span>
                        ))}
                        {ports.length > 2 && (
                          <span className="text-[10px] text-muted-foreground">
                            +{ports.length - 2}
                          </span>
                        )}
                      </div>
                    ) : (
                      <span className="text-[10px] text-muted-foreground italic">
                        {t("containers.noPorts")}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {container.status}
                  </td>
                  <td className="px-3 py-1 whitespace-nowrap">
                    <ContainerActions
                      sessionId={props.sessionId}
                      container={container}
                      onChanged={props.onChanged}
                      className="justify-end"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
