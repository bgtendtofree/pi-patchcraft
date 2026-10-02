import { Type } from "typebox";

export type PatchOperation = AddOperation | DeleteOperation | UpdateOperation;

export interface AddOperation {
	type: "add";
	path: string;
	content: string;
}

export interface DeleteOperation {
	type: "delete";
	path: string;
}

export interface UpdateOperation {
	type: "update";
	path: string;
	moveTo?: string;
	chunks: PatchChunk[];
}

export interface PatchChunk {
	contexts: string[];
	oldLines: string[];
	newLines: string[];
	endOfFile: boolean;
}

export interface PlannedFileChange {
	operation: "add" | "delete" | "update" | "move";
	path: string;
	targetPath: string;
	absolutePath: string;
	absoluteTargetPath: string;
	before: Buffer | undefined;
	after: Buffer | undefined;
	mode: number | undefined;
	displayDiff: string;
	added: number;
	removed: number;
	fuzz: number;
}

export interface PatchPlan {
	changes: PlannedFileChange[];
	added: number;
	removed: number;
	fuzz: number;
}

export type PatchResultChange = Pick<
	PlannedFileChange,
	"operation" | "path" | "targetPath" | "displayDiff" | "added" | "removed" | "fuzz"
>;

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
