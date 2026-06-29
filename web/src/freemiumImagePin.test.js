import { describe, expect, it } from "vitest";
import { applyImagingPinState } from "../../worker/_shared/freemium-image.js";

describe("applyImagingPinState", () => {
  const envWithToken = { POLLINATIONS_TOKEN: "sk-test" };

  it("sets pollinationsAltFirst after flux-free anon success (no anon pin)", () => {
    const next = applyImagingPinState(
      { imagePin: null, pollinationsAltFirst: false },
      { provider: "pollinations-anon", model: "flux-free" },
      envWithToken,
    );
    expect(next.pollinationsAltFirst).toBe(true);
    expect(next.imagePin).toBeNull();
  });

  it("pins pollinations-seed after paid seed success", () => {
    const next = applyImagingPinState(
      { imagePin: null, pollinationsAltFirst: false },
      { provider: "pollinations-seed", model: "flux" },
      envWithToken,
    );
    expect(next.imagePin).toBe("pollinations-seed");
  });

  it("pins cloudflare after non-pollinations success", () => {
    const next = applyImagingPinState(
      { imagePin: null, pollinationsAltFirst: false },
      { provider: "cloudflare", model: "@cf/black-forest-labs/flux-1-schnell" },
      envWithToken,
    );
    expect(next.imagePin).toBe("cloudflare");
  });

  it("preserves pollinationsAltFirst across characters", () => {
    const afterA = applyImagingPinState(
      { imagePin: null, pollinationsAltFirst: false },
      { provider: "pollinations-anon", model: "flux-free" },
      envWithToken,
    );
    const afterB = applyImagingPinState(
      afterA,
      { provider: "pollinations-anon", model: "flux-free" },
      envWithToken,
    );
    expect(afterB.pollinationsAltFirst).toBe(true);
  });
});
