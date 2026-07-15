import { describe, expect, it } from "vitest";
import { iconFor } from "../src/lib/icons";

describe("iconFor", () => {
  it("maps content types to emoji icons", () => {
    expect(iconFor("image/jpeg")).toBe("🖼");
    expect(iconFor("video/mp4")).toBe("🎬");
    expect(iconFor("audio/mpeg")).toBe("🎵");
    expect(iconFor("application/pdf")).toBe("📄");
    expect(iconFor("text/plain")).toBe("📝");
    expect(iconFor("application/zip")).toBe("📦");
  });
});
