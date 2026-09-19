import { afterEach, describe, expect, it } from "vitest";
import { channelKinds, facebookVisible } from "../facebook-preview.js";

describe("facebook preview switch", () => {
  const saved = process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
  afterEach(() => {
    if (saved === undefined) delete process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
    else process.env.HOOKMYAPP_FACEBOOK_PREVIEW = saved;
  });

  it("keeps Facebook out of help until the release that goes with the production flag", () => {
    delete process.env.HOOKMYAPP_FACEBOOK_PREVIEW;
    expect(facebookVisible()).toBe(false);
    expect(channelKinds()).toBe("WhatsApp & Instagram");
    expect(channelKinds("or")).toBe("WhatsApp or Instagram");
  });

  it("shows everything for testers with HOOKMYAPP_FACEBOOK_PREVIEW=1", () => {
    process.env.HOOKMYAPP_FACEBOOK_PREVIEW = "1";
    expect(facebookVisible()).toBe(true);
    expect(channelKinds()).toBe("WhatsApp, Instagram & Facebook");
  });
});
