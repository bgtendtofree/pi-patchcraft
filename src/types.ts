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
	diff: string;
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

export interface PatchResultChange {
	operation: PlannedFileChange["operation"];
	path: string;
	targetPath: string;
	displayDiff: string;
	added: number;
	removed: number;
	fuzz: number;
}

export interface PatchResultDetails {
	changes: PatchResultChange[];
	added: number;
	removed: number;
	fuzz: number;
}

export type ApplyPatchDetails =
	| PatchResultDetails
	| {
			/** Legacy session compatibility. */
			plan?: PatchPlan;
	  };
