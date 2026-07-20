import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { greeting } from "./greeting.ts";

export default function piExtensionTemplate(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "hello_pi",
		label: "Hello Pi",
		description: "Return a small greeting for extension-template smoke tests",
		promptSnippet: "Create a greeting for a supplied name",
		promptGuidelines: ["Use hello_pi only when the user explicitly asks for a greeting."],
		parameters: Type.Object({
			name: Type.String({ description: "Name to greet" }),
		}),
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: greeting(params.name) }],
				details: { name: params.name.trim() || "Pi" },
			};
		},
	});
}
