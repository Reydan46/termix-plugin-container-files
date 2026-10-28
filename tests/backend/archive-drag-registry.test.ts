import { describe, expect, it } from "vitest";
import {
  clearArchiveDrag,
  getArchiveDrag,
  setArchiveDrag,
} from "../../src/frontend/workspace/archiveDragRegistry";

describe("archive drag registry", () => {
  it("remembers and clears the active archive drag", () => {
    expect(getArchiveDrag()).toBeNull();
    setArchiveDrag({ containerId: "c1", archive: "/a.tgz", entries: ["/x"] });
    expect(getArchiveDrag()?.entries).toEqual(["/x"]);
    clearArchiveDrag();
    expect(getArchiveDrag()).toBeNull();
  });
});
