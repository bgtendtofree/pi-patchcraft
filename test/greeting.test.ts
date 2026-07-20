import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { greeting } from "../src/greeting.ts";

describe("greeting", () => {
	it("greets a normalized name", () => {
		assert.equal(greeting("  Ada  "), "Hello, Ada!");
	});

	it("falls back to Pi for blank input", () => {
		assert.equal(greeting("   "), "Hello, Pi!");
	});
});
