import { describe, expect, it } from "vitest";
import { buildOutboundMediaLoadOptions, resolveOutboundMediaLocalRoots } from "./load-options.js";

describe("media load options", () => {
  it("returns undefined localRoots when mediaLocalRoots is omitted", () => {
    expect(resolveOutboundMediaLocalRoots(undefined)).toBeUndefined();
  });

  it("keeps trusted mediaLocalRoots entries", () => {
    expect(resolveOutboundMediaLocalRoots(["/tmp/workspace"])).toEqual(["/tmp/workspace"]);
  });

  it("preserves explicit empty mediaLocalRoots as deny-all", () => {
    expect(resolveOutboundMediaLocalRoots([])).toEqual([]);
    expect(
      buildOutboundMediaLoadOptions({
        mediaLocalRoots: [],
      }),
    ).toEqual({
      localRoots: [],
    });
  });

  it("builds loadWebMedia options from maxBytes and mediaLocalRoots", () => {
    expect(
      buildOutboundMediaLoadOptions({
        maxBytes: 1024,
        mediaLocalRoots: ["/tmp/workspace"],
      }),
    ).toEqual({
      maxBytes: 1024,
      localRoots: ["/tmp/workspace"],
    });
  });
});
