import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  DEFAULT_LOCAL_EDGE,
  clearLocalApiBridge,
  getLocalApiBridge,
  initLocalApiBridgeFromUrl,
  localBridgeLabel,
  setLocalApiBridge,
} from "./localApiBridge.js";

describe("localApiBridge", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal("location", {
      search: "",
      pathname: "/projects/ebookavplayer/",
      hash: "",
    });
    vi.stubGlobal("history", { replaceState: vi.fn() });
  });

  it("defaults localApi=1 to 127.0.0.1 edge URL", () => {
    vi.stubGlobal("location", {
      search: "?localApi=1",
      pathname: "/projects/ebookavplayer/",
      hash: "",
    });
    const base = initLocalApiBridgeFromUrl();
    expect(base).toBe(DEFAULT_LOCAL_EDGE);
    expect(getLocalApiBridge()).toBe(DEFAULT_LOCAL_EDGE);
  });

  it("clears bridge on localApi=off", () => {
    setLocalApiBridge(DEFAULT_LOCAL_EDGE);
    vi.stubGlobal("location", {
      search: "?localApi=off",
      pathname: "/",
      hash: "",
    });
    initLocalApiBridgeFromUrl();
    expect(getLocalApiBridge()).toBeNull();
  });

  it("formats banner label", () => {
    setLocalApiBridge(DEFAULT_LOCAL_EDGE);
    expect(localBridgeLabel()).toBe("127.0.0.1:8600");
    clearLocalApiBridge();
    expect(localBridgeLabel()).toBe("");
  });
});
