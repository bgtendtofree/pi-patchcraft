import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patchcraftAdapter } from "../src/progressive.ts";

const CWD = "/tmp/project";

type Operation = "add" | "delete" | "update" | "move";

interface ChangeInput {
	operation: Operation;
	path: string;
	targetPath: string;
}

function change(operation: Operation, targetPath: string, path = targetPath): ChangeInput {
	return { operation, path, targetPath };
}

function absolute(operation: Operation, relativePath: string): ChangeInput {
	return { operation, path: `${CWD}/${relativePath}`, targetPath: `${CWD}/${relativePath}` };
}

function summarize(
	changes: ChangeInput[],
	totals: { added: number; removed: number; fuzz: number },
	extra: { args?: unknown; cwd?: string; isError?: boolean } = {},
) {
	return patchcraftAdapter.summarize?.({
		isError: extra.isError ?? false,
		...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
		...(extra.args === undefined ? {} : { args: extra.args }),
		details: { changes, ...totals },
	});
}

describe("Patchcraft Progressive Tools adapter", () => {
	it("builds semantic titles and metrics", () => {
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch",
			}),
			{ verb: "Update", subject: "a.ts", elide: "middle", accentSubject: true },
		);
	});

	it("distinguishes add, delete, move, and multi-file patches", () => {
		assert.deepEqual(patchcraftAdapter.title({ patch: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch" }), {
			verb: "Add",
			subject: "new.ts",
			elide: "middle",
			accentSubject: true,
		});
		assert.deepEqual(patchcraftAdapter.title({ patch: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch" }), {
			verb: "Delete",
			subject: "old.ts",
			elide: "middle",
			accentSubject: true,
		});
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** End Patch",
			}),
			{ verb: "Move", subject: "old.ts → new.ts", elide: "middle", accentSubject: true },
		);
		assert.deepEqual(
			patchcraftAdapter.title({
				patch: "*** Begin Patch\n*** Add File: a.ts\n+a\n*** Delete File: b.ts\n*** End Patch",
			}),
			{ verb: "Patch", subject: "2 files", context: "a.ts, b.ts" },
		);
	});

	it("summarizes a multi-file plan exactly like the removed host compatibility branch", () => {
		const result = summarize(
			[
				absolute("add", "test/run-model.test.ts"),
				absolute("add", "test/a.test.ts"),
				absolute("add", "test/b.test.ts"),
				absolute("add", "test/c.test.ts"),
			],
			{ added: 149, removed: 7, fuzz: 0 },
			{ cwd: CWD },
		);

		assert.deepEqual(result, {
			title: {
				verb: "Patch",
				subject: "test/run-model.test.ts +3 files",
				elide: "path",
				accentSubject: true,
			},
			metrics: ["+149", "-7"],
		});
		assert.equal(result?.title?.elide, "path");
	});

	it("keeps the operation verb and drops the file suffix for a single change", () => {
		const cases = [
			{
				operation: "update" as const,
				patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch",
				verb: "Update",
				subject: "src/a.ts",
			},
			{
				operation: "add" as const,
				patch: "*** Begin Patch\n*** Add File: src/a.ts\n+x\n*** End Patch",
				verb: "Add",
				subject: "src/a.ts",
			},
			{
				operation: "move" as const,
				patch: "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: src/b.ts\n@@\n-a\n+b\n*** End Patch",
				verb: "Move",
				subject: "src/b.ts",
			},
		];

		for (const testCase of cases) {
			const result = summarize(
				[absolute(testCase.operation, testCase.subject)],
				{ added: 1, removed: 1, fuzz: 0 },
				{ args: { patch: testCase.patch }, cwd: CWD },
			);
			assert.deepEqual(result?.title, {
				verb: testCase.verb,
				subject: testCase.subject,
				elide: "path",
				accentSubject: true,
			});
			assert.doesNotMatch(result?.title?.subject ?? "", / \+\d+ files?/);
			assert.deepEqual(result?.metrics, ["+1", "-1"]);
		}
	});

	it("never repeats the file count as a numeric metric", () => {
		assert.deepEqual(
			summarize([absolute("add", "src/a.ts")], { added: 2, removed: 0, fuzz: 0 }, { cwd: CWD })?.metrics,
			["+2"],
		);
		assert.deepEqual(
			summarize(
				[absolute("update", "src/a.ts"), absolute("update", "src/b.ts")],
				{ added: 4, removed: 3, fuzz: 5 },
				{ cwd: CWD },
			)?.metrics,
			["+4", "-3", "fuzz 5"],
		);
	});

	it("keeps recorded paths when cwd is absent or the target is outside it", () => {
		assert.deepEqual(summarize([change("add", "/srv/app/src/a.ts")], { added: 1, removed: 0, fuzz: 0 })?.title, {
			verb: "Patch",
			subject: "/srv/app/src/a.ts",
			elide: "path",
			accentSubject: true,
		});
		assert.deepEqual(
			summarize([change("add", "/srv/app/src/a.ts")], { added: 1, removed: 0, fuzz: 0 }, { cwd: CWD })?.title,
			{ verb: "Patch", subject: "/srv/app/src/a.ts", elide: "path", accentSubject: true },
		);
		assert.deepEqual(summarize([change("add", "src/a.ts")], { added: 1, removed: 0, fuzz: 0 }, { cwd: CWD })?.title, {
			verb: "Patch",
			subject: "src/a.ts",
			elide: "path",
			accentSubject: true,
		});
	});

	it("falls back to the plain plan-less summary", () => {
		assert.deepEqual(patchcraftAdapter.summarize?.({ isError: false }), {});
		assert.deepEqual(patchcraftAdapter.summarize?.({ isError: true }), { status: "failed" });
		assert.deepEqual(summarize([], { added: 0, removed: 0, fuzz: 0 }), {});
		assert.deepEqual(
			summarize([{ operation: "add", path: "a.ts", targetPath: "" }], { added: 1, removed: 0, fuzz: 0 }),
			{},
		);
		assert.deepEqual(
			patchcraftAdapter.summarize?.({
				isError: true,
				details: { changes: [{ operation: "add" }], added: 1, removed: 0, fuzz: 0 },
			}),
			{ status: "failed" },
		);
	});

	it("provides native diff sections without changing copy behavior", () => {
		const detail = patchcraftAdapter.detail?.({
			isError: false,
			details: {
				added: 1,
				removed: 1,
				fuzz: 0,
				changes: [
					{
						operation: "update",
						path: "src/a.ts",
						targetPath: "src/a.ts",
						added: 1,
						removed: 1,
						fuzz: 0,
						displayDiff: "-1 old\n+1 new",
					},
				],
			},
		});

		assert.deepEqual(detail, {
			sections: [
				{
					title: "Update src/a.ts (+1 -1)",
					text: "-1 old\n+1 new",
					format: "diff",
				},
			],
			hideMetadata: true,
		});
	});
});
