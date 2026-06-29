import { beforeEach, describe, expect, it, vi } from "vitest";

const settings = new Map();

vi.mock("./packStore.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getSetting: vi.fn(async (key) => settings.get(key) ?? null),
    putSetting: vi.fn(async (key, value) => {
      settings.set(key, value);
      return value;
    }),
    deleteSetting: vi.fn(async (key) => {
      settings.delete(key);
    }),
  };
});

import {
  supportsFolderLibrary, fileFingerprint, linkPackFolder, unlinkPackFolder,
  collectFolderPackFiles, markFolderFilesImported, scanLinkedFolderSummary,
} from "./packFolder.js";
import { clearAllPacksForTests } from "./packStore.js";

describe("packFolder", () => {
  beforeEach(async () => {
    settings.clear();
    await clearAllPacksForTests();
    delete window.showDirectoryPicker;
  });

  it("supportsFolderLibrary when API present", () => {
    window.showDirectoryPicker = vi.fn();
    expect(supportsFolderLibrary()).toBe(true);
    delete window.showDirectoryPicker;
    expect(supportsFolderLibrary()).toBe(false);
  });

  it("fileFingerprint uses size and lastModified", () => {
    expect(fileFingerprint({ size: 100, lastModified: 50 })).toBe("100:50");
  });

  it("collectFolderPackFiles returns only new/changed packs", async () => {
    const packFile = {
      name: "demo.vaepack",
      size: 42,
      lastModified: 1000,
    };
    const handle = {
      name: "OfflinePacks",
      queryPermission: async () => "granted",
      values: async function* () {
        yield {
          kind: "file",
          name: "demo.vaepack",
          getFile: async () => packFile,
        };
      },
    };
    settings.set("linked-pack-folder", { handle, name: handle.name, linked_at: Date.now() });
    settings.set("linked-pack-folder-scan", { files: {}, last_scan: null });

    const first = await collectFolderPackFiles();
    expect(first.files).toHaveLength(1);
    expect(first.files[0].name).toBe("demo.vaepack");

    await markFolderFilesImported(first.files);
    const second = await collectFolderPackFiles();
    expect(second.files).toHaveLength(0);

    const forced = await collectFolderPackFiles({ force: true });
    expect(forced.files).toHaveLength(1);
  });

  it("linkPackFolder stores handle metadata", async () => {
    const handle = {
      name: "MyPacks",
      queryPermission: async () => "granted",
      values: async function* () {},
    };
    window.showDirectoryPicker = vi.fn(async () => handle);
    const linked = await linkPackFolder();
    expect(linked.name).toBe("MyPacks");
    const summary = await scanLinkedFolderSummary();
    expect(summary.name).toBe("MyPacks");
    await unlinkPackFolder();
    expect(settings.has("linked-pack-folder")).toBe(false);
  });
});
