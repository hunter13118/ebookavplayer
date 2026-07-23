import { describe, expect, it } from "vitest";

import { sampleBook } from "./sampleBook.js";

import { collectIllustrations, harvestInsertMap } from "./illustrationGallery.js";



describe("collectIllustrations", () => {

  it("gathers unlocked line illustrations only", () => {

    const book = {

      ...sampleBook,

      inserts: { "1": "/media/x/insert1.png" },

      scenes: [{

        id: "s1",

        chapter: 1,

        title: "Gate",

        lines: [

          {

            idx: 0,

            illustration_url: "/media/x/a.png",

            illustration_caption: "A gate",

            text: "Hello",

            speaker_name: "Elara",

          },

          {

            idx: 1,

            illustration_url: "/media/x/spoiler.png",

            text: "Later",

            speaker_name: "Elara",

          },

        ],

      }],

      illustrations: ["/media/x/b.png"],

    };

    const items = collectIllustrations(book, 0);

    expect(items.length).toBe(1);

    expect(items[0].url).toBe("/media/x/a.png");

    expect(items[0].isMoment).toBe(false);

  });



  it("marks moment inserts", () => {
    const book = {
      scenes: [{
        id: "s1",
        chapter: 1,
        lines: [{
          idx: 2,
          illustration_url: "/media/x/insert2.png",
          text: "Wow",
          speaker_name: "Mei",
        }],
      }],
      inserts: { "2": "/media/x/insert2.png" },
    };
    const items = collectIllustrations(book, 2);
    expect(items[0].isMoment).toBe(true);
  });

  it("harvests inserts from line illustration_url", () => {
    const inserts = harvestInsertMap({
      scenes: [{ id: "s1", lines: [{ idx: 2, illustration_url: "/media/x/insert2.png" }] }],
    });
    expect(inserts["2"]).toBe("/media/x/insert2.png");
  });

  // Embedded EPUB art (cover + illustration_urls) must surface even when NO
  // scene line carries an illustration_url — the BookNLP-extracted case that
  // left the gallery empty despite front-matter plates rendering inline.
  it("surfaces embedded cover + illustration_urls with no line attachments", () => {
    const book = {
      cover: "/media/x/anime/cover.png?v=123",
      illustration_urls: {
        0: "/media/x/illustrations/img_000.jpg",
        1: "/media/x/illustrations/img_001.jpg",
      },
      scenes: [{ id: "s1", chapter: 1, lines: [{ idx: 0, text: "No art here" }] }],
    };
    const items = collectIllustrations(book, 0);
    expect(items.map((i) => i.id)).toEqual(["cover", "img-0", "img-1"]);
    expect(items[0].caption).toBe("Cover");
    expect(items[1].caption).toBe("Book illustration 1");
    expect(items.every((i) => i.isEmbedded)).toBe(true);
    // Embedded plates have no story position, so they aren't spoiler-gated.
    expect(items[2].lineIdx).toBe(null);
  });

  it("lists embedded art before story-positioned moments and dedupes shared urls", () => {
    const book = {
      cover: "/media/x/anime/cover.png",
      illustration_urls: { 5: "/media/x/illustrations/img_005.jpg" },
      inserts: { "3": "/media/x/illustrations/img_005.jpg" },
      scenes: [{
        id: "s1",
        chapter: 1,
        lines: [{ idx: 3, illustration_url: "/media/x/illustrations/img_005.jpg?v=9", text: "beat" }],
      }],
    };
    const items = collectIllustrations(book, 3);
    // A plate that's BOTH embedded and attached to an unlocked story line is
    // listed once: the line item wins (it carries the beat's position/caption),
    // the embedded duplicate is dropped. Cover still leads.
    expect(items.map((i) => i.id)).toEqual(["cover", "line-3"]);
  });
});


