import { describe, expect, it } from "vitest";
import {
  catalogSources, SOURCE_BROWSER, SOURCE_CLOUD, SOURCE_FOLDER, SOURCE_REMOTE,
} from "./catalogSources.js";

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

  it("remote when entry carries a connection_id resolving to a remote connection", () => {
    const connections = [
      { id: "tunnel-1", kind: "remote", label: "M4 Pro" },
      { id: "server", kind: "server", label: "Cloud" },
    ];
    const s = catalogSources(
      { server_available: true, connection_id: "tunnel-1" },
      connections,
    );
    expect(s.map((x) => x.id)).toEqual([SOURCE_REMOTE]);
    expect(s[0].label).toBe("M4 Pro");
  });

  it("ignores connection_id when it resolves to a non-remote connection", () => {
    const connections = [{ id: "server", kind: "server", label: "Cloud" }];
    const s = catalogSources(
      { server_available: true, connection_id: "server" },
      connections,
    );
    expect(s.map((x) => x.id)).toEqual([SOURCE_CLOUD]);
  });
});
