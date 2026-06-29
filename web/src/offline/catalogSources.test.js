import { describe, expect, it } from "vitest";
import { catalogSources, SOURCE_BROWSER, SOURCE_CLOUD, SOURCE_FOLDER } from "./catalogSources.js";

describe("catalogSources", () => {
  it("cloud only when server and no local pack", () => {
    const s = catalogSources({ book_id: "a", server_available: true, offline_pack: false });
    expect(s.map((x) => x.id)).toEqual([SOURCE_CLOUD]);
  });

  it("cloud + browser when both", () => {
    const s = catalogSources({ server_available: true, offline_pack: true });
    expect(s.map((x) => x.id)).toEqual([SOURCE_CLOUD, SOURCE_BROWSER]);
  });

  it("browser only when offline-only", () => {
    const s = catalogSources({ server_available: false, offline_pack: true });
    expect(s.map((x) => x.id)).toEqual([SOURCE_BROWSER]);
  });

  it("folder when pack came from linked directory", () => {
    const s = catalogSources({
      server_available: false,
      offline_pack: true,
      pack_origin: "folder",
    });
    expect(s.map((x) => x.id)).toEqual([SOURCE_BROWSER, SOURCE_FOLDER]);
  });
});
