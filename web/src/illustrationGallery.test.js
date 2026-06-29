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
});


