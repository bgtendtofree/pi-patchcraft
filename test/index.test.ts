import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piExtensionTemplate from "../src/index.ts";

interface RegisteredTool {
	name: string;
	execute(
		toolCallId: string,
		params: { name: string },
	): Promise<{
		content: Array<{ type: string; text: string }>;
		details: { name: string };
	}>;
}

describe("Pi extension template", () => {
	it("registers and executes the hello_pi tool", async () => {
		let registeredTool: RegisteredTool | undefined;
		const pi = {
			registerTool(tool: RegisteredTool) {
				registeredTool = tool;
			},
		} as unknown as ExtensionAPI;

		piExtensionTemplate(pi);
		assert.equal(registeredTool?.name, "hello_pi");

		const result = await registeredTool?.execute("call-1", { name: "  Ada  " });
		assert.deepEqual(result, {
			content: [{ type: "text", text: "Hello, Ada!" }],
			details: { name: "Ada" },
		});

		const fallback = await registeredTool?.execute("call-2", { name: " " });
		assert.deepEqual(fallback, {
			content: [{ type: "text", text: "Hello, Pi!" }],
			details: { name: "Pi" },
		});
	});
});
