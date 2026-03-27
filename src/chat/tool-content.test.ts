import { describe, expect, it } from "vitest";
import { isToolCallBlock, isToolCallContentType } from "./tool-content.js";

describe("isToolCallContentType", () => {
  it("treats functionCall variants as tool-call content", () => {
    expect(isToolCallContentType("functionCall")).toBe(true);
    expect(isToolCallContentType("function_call")).toBe(true);
    expect(isToolCallBlock({ type: "functionCall" })).toBe(true);
  });
});
