import { describe, expect, it } from "vitest";
import {
  filterContainers,
  isContainerSort,
  sortContainers,
} from "../../src/frontend/containers/ContainerList";
import type { ContainerInfo } from "../../src/frontend/types";

const make = (
  name: string,
  state = "running",
  image = "img",
): ContainerInfo => ({
  id: name,
  name,
  image,
  status: "",
  state,
  ports: "",
  created: "",
});

const names = (list: ContainerInfo[]) => list.map((c) => c.name);

describe("sortContainers", () => {
  const list = [
    make("/web10", "exited", "nginx"),
    make("/Api", "running", "node"),
    make("/web2", "running", "alpine"),
  ];

  it("sorts by name, numbers by value and ignoring case", () => {
    expect(names(sortContainers(list, "name"))).toEqual([
      "/Api",
      "/web2",
      "/web10",
    ]);
    expect(names(sortContainers(list, "nameDesc"))).toEqual([
      "/web10",
      "/web2",
      "/Api",
    ]);
  });

  it("sorts by state then name, and by image", () => {
    expect(names(sortContainers(list, "state"))).toEqual([
      "/web10",
      "/Api",
      "/web2",
    ]);
    expect(names(sortContainers(list, "image"))).toEqual([
      "/web2",
      "/web10",
      "/Api",
    ]);
  });

  it("leaves the input alone", () => {
    const before = names(list);
    sortContainers(list, "name");
    expect(names(list)).toEqual(before);
  });

  it("filters by a part of the name", () => {
    expect(names(filterContainers(list, "WEB", "all"))).toEqual([
      "/web10",
      "/web2",
    ]);
  });

  it("knows the sort keys", () => {
    expect(isContainerSort("name")).toBe(true);
    expect(isContainerSort("size")).toBe(false);
  });
});
