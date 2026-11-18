import { type Static, Type } from "typebox";

export const patchResultSchema = Type.Object({
	changes: Type.Array(
		Type.Object({
			operation: Type.Union([
				Type.Literal("add"),
				Type.Literal("delete"),
				Type.Literal("update"),
				Type.Literal("move"),
			]),
			path: Type.String(),
			targetPath: Type.String(),
			displayDiff: Type.String(),
			added: Type.Number(),
			removed: Type.Number(),
			fuzz: Type.Number(),
		}),
	),
	added: Type.Number(),
	removed: Type.Number(),
	fuzz: Type.Number(),
});

export type PatchResultDetails = Static<typeof patchResultSchema>;
export type PatchResultChange = PatchResultDetails["changes"][number];
