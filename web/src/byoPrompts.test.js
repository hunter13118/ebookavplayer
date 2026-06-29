import { describe, expect, it } from "vitest";
import {
  buildByoPrompt,
  buildByoPromptJson,
  buildByoPromptPack,
  composeImagePrompt,
} from "./byoPrompts.js";
import { listArtMediaItems } from "./artMediaItems.js";

const fixtureBook = {
  book_id: "test-book",
  title: "Test Tale",
  active_style: "anime",
  cover_illustration_ref: 0,
  illustration_urls: { 0: "/media/test-book/illustrations/img_000.png" },
  characters: {
    hero: {
      name: "Hero",
      description: "A brave knight with silver armor.",
      illustration_ref: 0,
    },
  },
  scenes: [{
    id: "scene-1",
    chapter: 1,
    title: "Forest Clearing",
    location: "A misty forest at dawn",
    present: [{ character_id: "hero" }],
    lines: [{
      idx: 5,
      character_id: "hero",
      text: "I must press onward.",
      expression: "determined",
      illustration_ref: 0,
    }],
  }],
  inserts: { 5: "/media/test-book/anime/insert_5.png" },
};

describe("byoPrompts", () => {
  const items = listArtMediaItems(fixtureBook);
  const cover = items.find((it) => it.kind === "cover");
  const character = items.find((it) => it.kind === "characters");
  const background = items.find((it) => it.kind === "backgrounds");
  const insert = items.find((it) => it.kind === "inserts");

  it("cover prompt includes title and no-text cover description", () => {
    const md = buildByoPrompt(fixtureBook, cover, { apiBase: "https://api.example" });
    expect(md).toContain("Test Tale");
    expect(md).toContain("Cover");
    expect(md).toContain("Evocative book cover key art for 'Test Tale'. No text.");
    expect(md).toContain("Wide establishing background scene");
    expect(md).toContain("anime cel-shaded");
  });

  it("character prompt includes description and transparent sprite framing", () => {
    const md = buildByoPrompt(fixtureBook, character);
    expect(md).toContain("A brave knight with silver armor");
    expect(md).toContain("Portrait bust character sprite");
    expect(md).toContain("transparent background");
  });

  it("background prompt includes scene location", () => {
    const md = buildByoPrompt(fixtureBook, background);
    expect(md).toContain("A misty forest at dawn");
    expect(md).toContain("Wide establishing background scene");
    expect(md).not.toContain("transparent background");
  });

  it("insert prompt includes story beat and moment framing", () => {
    const md = buildByoPrompt(fixtureBook, insert);
    expect(md).toContain("Full-screen story moment");
    expect(md).toContain("I must press onward");
    expect(md).toContain("Hero");
    expect(md).toContain("determined facial expression");
  });

  it("includes reference URLs when illustration refs exist", () => {
    const md = buildByoPrompt(fixtureBook, character, { apiBase: "https://api.example" });
    expect(md).toContain("## Reference URLs");
    expect(md).toContain("https://api.example/media/test-book/illustrations/img_000.png");
  });

  it("buildByoPromptPack joins multiple prompts", () => {
    const pack = buildByoPromptPack(fixtureBook, [cover, character]);
    expect(pack).toContain("---");
    expect(pack).toContain("Cover");
    expect(pack).toContain("Hero");
  });

  it("buildByoPromptJson returns structured array", () => {
    const json = buildByoPromptJson(fixtureBook, [cover, insert], { apiBase: "https://api.example" });
    expect(json).toHaveLength(2);
    expect(json[0].kind).toBe("cover");
    expect(json[0].masterPrompt).toContain("Evocative book cover");
    expect(json[1].kind).toBe("inserts");
    expect(json[1].referenceUrls[0].url).toContain("img_000.png");
  });

  it("composeImagePrompt mirrors worker freemium-image", () => {
    const p = composeImagePrompt("test scene", { subjectType: "background", style: "anime" });
    expect(p).toBe(
      "Wide establishing background scene, environment art, no characters, "
      + "no people, strong sense of depth and atmosphere, test scene "
      + "full scene fills the frame, layered foreground/midground/background, "
      + "usable as a game backdrop layer. Art style: anime cel-shaded, bold outlines, vibrant colors.",
    );
  });
});
