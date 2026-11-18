import { Type } from "typebox";

export type PatchResultChange = {
	operation: "add" | "delete" | "update" | "move";
	path: string;
	targetPath: string;
	displayDiff: string;
	added: number;
	removed: number;
	fuzz: number;
};

/**
 * Structurally identical to {@link patchResultSchema}, which Pi hands to codemode scripts as the
 * tool's `structuredContent`. A type alias, not an interface, so Pi's `JsonValue` accepts it.
 */
export type PatchResultDetails = {
	changes: PatchResultChange[];
	added: number;
	removed: number;
	fuzz: number;
};

/** Mirrors {@link PatchResultDetails}; keep both in sync when the result shape changes. */
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
