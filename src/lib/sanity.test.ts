import { describe, expect, it } from "vitest";

describe("CI sanity check", () => {
    it("verifies test runner works", () => {
        expect(1 + 1).toBe(2);
    });
});