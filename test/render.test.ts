import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { type PatchRowState, renderPatchCall, renderPatchResult } from "../src/render.ts";
import { getPatchDetails, patchDetailSections, patchMetrics, patchSummary, patchTitle } from "../src/row.ts";
import type { PatchResultDetails } from "../src/types.ts";

const CWD = "/tmp/project";

const renderTheme = {
	fg: (color: string, text: string) => (color === "error" ? `\x1b[31m${text}\x1b[39m` : text),
	bg: (_color: string, text: string) => `\x1b[41m${text}\x1b[49m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

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

function details(changes: ChangeInput[], totals: { added: number; removed: number; fuzz: number }): PatchResultDetails {
	return {
		changes: changes.map((entry) => ({ ...entry, displayDiff: `-${entry.path}\n+${entry.targetPath}`, ...totals })),
		...totals,
	};
}

function summarize(
	changes: ChangeInput[] | undefined,
	totals: { added: number; removed: number; fuzz: number },
	extra: { args?: unknown; cwd?: string; isError?: boolean } = {},
) {
	return patchSummary({
		details: changes === undefined ? undefined : details(changes, totals),
		isError: extra.isError ?? false,
		...(extra.cwd === undefined ? {} : { cwd: extra.cwd }),
		...(extra.args === undefined ? {} : { args: extra.args }),
	});
}

/** Render a completed (collapsed) row and return its header component for width probes. */
function renderOne(view: { patch: string; details: PatchResultDetails }) {
	const state: PatchRowState = {};
	const args = { patch: view.patch };
	const header = renderPatchCall(args, renderTheme, { state });
	renderPatchResult(
		{ content: [{ type: "text", text: "Patch applied." }], details: view.details },
		{ expanded: false, isPartial: false },
		renderTheme,
		{ state, args, cwd: CWD, isError: false },
	);
	return header;
}

describe("Patchcraft row semantics", () => {
	it("derives the call title from the first patch header", () => {
		assert.deepEqual(patchTitle({ patch: "*** Begin Patch\n*** Update File: a.ts\n@@\n-a\n+b\n*** End Patch" }), {
			verb: "Update",
			subject: "a.ts",
			subjectKind: "path",
		});
		assert.deepEqual(patchTitle({ patch: "*** Begin Patch\n*** Add File: new.ts\n+x\n*** End Patch" }), {
			verb: "Add",
			subject: "new.ts",
			subjectKind: "path",
		});
		assert.deepEqual(patchTitle({ patch: "*** Begin Patch\n*** Delete File: old.ts\n*** End Patch" }), {
			verb: "Delete",
			subject: "old.ts",
			subjectKind: "path",
		});
		assert.deepEqual(
			patchTitle({
				patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n@@\n-old\n+new\n*** End Patch",
			}),
			{ verb: "Move", subject: "old.ts", subjectKind: "path", subjectSuffix: "→ new.ts" },
		);
		assert.deepEqual(
			patchTitle({ patch: "*** Begin Patch\n*** Add File: a.ts\n+a\n*** Delete File: b.ts\n*** End Patch" }),
			{ verb: "Patch", subject: "2 files", context: "a.ts, b.ts" },
		);
		assert.deepEqual(patchTitle("*** not a patch ***"), { verb: "Patch", subject: "…" });
	});

	it("summarizes a multi-file plan with the first target and the file count", () => {
		const summary = summarize(
			[
				absolute("add", "test/run-model.test.ts"),
				absolute("add", "test/a.test.ts"),
				absolute("add", "test/b.test.ts"),
				absolute("add", "test/c.test.ts"),
			],
			{ added: 149, removed: 7, fuzz: 0 },
			{ cwd: CWD },
		);

		assert.deepEqual(summary, {
			title: { verb: "Patch", subject: "test/run-model.test.ts", subjectKind: "path", subjectSuffix: "+3 files" },
			metrics: ["+149", "-7"],
		});
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
			const summary = summarize(
				[absolute(testCase.operation, testCase.subject)],
				{ added: 1, removed: 1, fuzz: 0 },
				{ args: { patch: testCase.patch }, cwd: CWD },
			);
			assert.deepEqual(summary.title, { verb: testCase.verb, subject: testCase.subject, subjectKind: "path" });
			assert.doesNotMatch(summary.title.subjectSuffix ?? "", /\d+ files?/);
			assert.deepEqual(summary.metrics, ["+1", "-1"]);
		}
	});

	it("reports the fuzz metric and never counts files numerically", () => {
		assert.deepEqual(patchMetrics({ changes: [], added: 0, removed: 0, fuzz: 0 }), []);
		assert.deepEqual(
			summarize(
				[absolute("update", "src/a.ts"), absolute("update", "src/b.ts")],
				{ added: 4, removed: 3, fuzz: 2 },
				{ cwd: CWD },
			).metrics,
			["+4", "-3", "fuzz 2"],
		);
	});

	it("keeps recorded paths when cwd is absent or the target is outside it", () => {
		assert.deepEqual(summarize([change("add", "/srv/app/src/a.ts")], { added: 1, removed: 0, fuzz: 0 }).title, {
			verb: "Patch",
			subject: "/srv/app/src/a.ts",
			subjectKind: "path",
		});
		assert.deepEqual(
			summarize([change("add", "/srv/app/src/a.ts")], { added: 1, removed: 0, fuzz: 0 }, { cwd: CWD }).title,
			{ verb: "Patch", subject: "/srv/app/src/a.ts", subjectKind: "path" },
		);
		assert.deepEqual(summarize([change("add", "src/a.ts")], { added: 1, removed: 0, fuzz: 0 }, { cwd: CWD }).title, {
			verb: "Patch",
			subject: "src/a.ts",
			subjectKind: "path",
		});
	});

	it("marks failed results and rejects malformed plans", () => {
		assert.deepEqual(patchSummary({ isError: false }), { title: { verb: "Patch", subject: "…" }, metrics: [] });
		assert.deepEqual(patchSummary({ isError: true }), {
			title: { verb: "Patch", subject: "…" },
			metrics: [],
			status: "failed",
		});
		assert.deepEqual(summarize([], { added: 0, removed: 0, fuzz: 0 }), {
			title: { verb: "Patch", subject: "…" },
			metrics: [],
		});
		const badTarget: ChangeInput[] = [{ operation: "add", path: "a.ts", targetPath: "" }];
		assert.deepEqual(summarize(badTarget, { added: 1, removed: 0, fuzz: 0 }), {
			title: { verb: "Patch", subject: "…" },
			metrics: [],
		});
		assert.equal(
			patchSummary({
				isError: true,
				details: { changes: [{ operation: "add" }], added: 1, removed: 0, fuzz: 0 },
			}).status,
			"failed",
		);
		assert.equal(getPatchDetails({ changes: [], added: 0, removed: 0, fuzz: 0 }), undefined);
		assert.deepEqual(
			patchDetailSections(details([change("update", "src/a.ts")], { added: 1, removed: 1, fuzz: 0 }))[0]?.title,
			"Update src/a.ts (+1 -1)",
		);
	});
});

describe("Patchcraft row rendering", () => {
	it("renders the call title standalone", () => {
		const component = renderPatchCall(
			{ patch: "*** Begin Patch\n*** Update File: old.ts\n*** Move to: new.ts\n*** End Patch" },
			renderTheme,
		);
		assert.equal(stripVTControlCharacters(component.render(80).join("\n")).trim(), "Move old.ts → new.ts");
	});

	it("updates one row with the result title, status, and metrics", () => {
		initTheme("dark", false);
		const state: PatchRowState = {};
		const args = { patch: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch" };
		const header = renderPatchCall(args, renderTheme, { state });
		assert.equal(stripVTControlCharacters(header.render(80).join("\n")).trim(), "Update src/a.ts");

		renderPatchResult(
			{
				content: [{ type: "text", text: "Patch applied." }],
				details: details([absolute("update", "src/a.ts")], { added: 2, removed: 1, fuzz: 0 }),
			},
			{ expanded: false, isPartial: false },
			renderTheme,
			{ state, args, cwd: CWD, isError: false },
		);
		const line = stripVTControlCharacters(header.render(80).join("\n"));
		assert.match(line, /Update src\/a\.ts/);
		assert.match(line, /\+2/);
		assert.match(line, /-1/);

		const failed = renderPatchResult(
			{ content: [{ type: "text", text: "Cannot apply patch" }], details: undefined },
			{ expanded: false, isPartial: false },
			renderTheme,
			{ state, args, cwd: CWD, isError: true },
		);
		assert.match(stripVTControlCharacters(header.render(80).join("\n")), /failed/);
		assert.match(stripVTControlCharacters(failed.render(80).join("\n")), /Cannot apply patch/);
	});

	it("renders nothing collapsed and the diff sections expanded", () => {
		initTheme("dark", false);
		const result = {
			content: [{ type: "text", text: "Patch applied." }],
			details: details([change("update", "old.ts", "old.ts")], { added: 1, removed: 1, fuzz: 0 }),
		};
		assert.deepEqual(renderPatchResult(result, { expanded: false, isPartial: false }, renderTheme).render(80), []);
		const expanded = stripVTControlCharacters(
			renderPatchResult(result, { expanded: true, isPartial: false }, renderTheme).render(80).join("\n"),
		);
		assert.match(expanded, /Update old\.ts \(\+1 -1\)/);
		assert.match(expanded, /-old\.ts/);
		assert.match(expanded, /\+old\.ts/);
	});

	it("renders errors and streaming progress without touching details", () => {
		const error = renderPatchResult(
			{
				content: [
					{ type: "text", text: "Cannot apply patch" },
					{ type: "image" },
					{ type: "text", text: "Rollback failed: denied" },
				],
				details: details([change("move", "new.ts", "old.ts")], { added: 1, removed: 1, fuzz: 0 }),
			},
			{ expanded: true, isPartial: false },
			renderTheme,
			{ isError: true },
		);
		const output = stripVTControlCharacters(error.render(80).join("\n"));
		assert.match(output, /Cannot apply patch/);
		assert.match(output, /Rollback failed: denied/);
		assert.doesNotMatch(output, /old\.ts → new\.ts/);
		assert.equal(
			stripVTControlCharacters(
				renderPatchResult({ content: [] }, { expanded: true, isPartial: false }, renderTheme, { isError: true })
					.render(80)
					.join("\n"),
			).trim(),
			"Patch failed.",
		);
		const partial = stripVTControlCharacters(
			renderPatchResult(
				{ content: [{ type: "text", text: "Validating patch…" }] },
				{ expanded: true, isPartial: true },
				renderTheme,
			)
				.render(80)
				.join("\n"),
		);
		assert.equal(partial.trim(), "Validating patch…");
	});

	it("keeps the file name when a deep path subject does not fit", () => {
		initTheme("dark", false);
		const deep = "src/very/deep/nested/component/file.ts";
		const single = renderOne({
			patch: `*** Begin Patch\n*** Update File: ${deep}\n@@\n-a\n+b\n*** End Patch`,
			details: details([change("update", deep)], { added: 1, removed: 1, fuzz: 0 }),
		});
		for (const width of [40, 60, 80, 120]) {
			const line = stripVTControlCharacters(single.render(width).join("\n"));
			assert.match(line, /^Update /, `width ${width}: ${line}`);
			assert.ok(line.includes("file.ts"), `width ${width} lost the file name: ${line}`);
		}
		assert.match(
			stripVTControlCharacters(single.render(40).join("\n")).trim(),
			/^Update .*…\/component\/file\.ts\s+\+1 · -1$/,
		);

		const multi = renderOne({
			patch:
				"*** Begin Patch\n*** Add File: test/run-model.test.ts\n+a\n*** Add File: test/a.test.ts\n+b\n*** End Patch",
			details: details([change("add", "test/run-model.test.ts"), change("add", "test/a.test.ts")], {
				added: 149,
				removed: 0,
				fuzz: 0,
			}),
		});
		const multiLine = stripVTControlCharacters(multi.render(40).join("\n"));
		assert.match(multiLine, /^Patch /);
		assert.ok(multiLine.includes("run-model.test.ts"), `multi lost the file name: ${multiLine}`);
		assert.ok(multiLine.includes("+1 file"), `multi lost the count: ${multiLine}`);
	});

	it("reports omitted diff lines only when the expanded body is capped", () => {
		initTheme("dark", false);
		const diff = (count: number) => Array.from({ length: count }, (_, index) => `+line ${index + 1}`).join("\n");
		const body = (changes: Array<{ path: string; text: string }>) =>
			stripVTControlCharacters(
				renderPatchResult(
					{
						content: [{ type: "text", text: "Patch applied." }],
						details: {
							changes: changes.map((entry) => ({
								operation: "update",
								path: entry.path,
								targetPath: entry.path,
								displayDiff: entry.text,
								added: 40,
								removed: 0,
								fuzz: 0,
							})),
							added: 40,
							removed: 0,
							fuzz: 0,
						},
					},
					{ expanded: true, isPartial: false },
					renderTheme,
				)
					.render(200)
					.join("\n"),
			);

		const capped = body([{ path: "src/a.ts", text: diff(40) }])
			.split("\n")
			.map((line) => line.trimEnd());
		assert.equal(capped.at(-1), "… 20 more lines");
		assert.equal(capped.filter((line) => line === "… 20 more lines").length, 1);

		const accumulated = body([
			{ path: "src/a.ts", text: diff(40) },
			{ path: "src/b.ts", text: diff(30) },
		])
			.split("\n")
			.map((line) => line.trimEnd());
		assert.equal(accumulated.at(-1), "… 30 more lines");

		const complete = body([{ path: "src/a.ts", text: diff(5) }]);
		assert.doesNotMatch(complete, /more line/);
	});
});
