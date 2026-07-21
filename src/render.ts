import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { patchcraftAdapter } from "./progressive.ts";
import type { ApplyPatchDetails } from "./types.ts";

interface PatchArgs {
	patch: string;
}

export function renderPatchCall(args: PatchArgs, theme: Theme): Text {
	const { verb, subject } = patchcraftAdapter.title(args);
	return new Text(theme.fg("toolTitle", theme.bold(subject ? `${verb} ${subject}` : verb)), 0, 0);
}

export function renderPatchResult(
	result: { content: Array<{ type: string; text?: string }>; details: ApplyPatchDetails | undefined },
	options: { expanded: boolean; isPartial: boolean },
	theme: Theme,
): Container | Text {
	if (options.isPartial) {
		const text = result.content.find((part) => part.type === "text")?.text ?? "Applying patch…";
		return new Text(theme.fg("warning", text), 0, 0);
	}

	const plan = result.details?.plan;
	if (!plan || !options.expanded) return new Container();
	const lines = plan.changes.flatMap((change) => {
		const title = change.operation === "move" ? `${change.path} → ${change.targetPath}` : change.targetPath;
		return [
			theme.fg("accent", `${change.operation} ${title} (+${change.added} -${change.removed})`),
			...change.diff
				.split("\n")
				.filter((line) => line.length > 0)
				.slice(0, 20)
				.map((line) => {
					if (line.startsWith("+") && !line.startsWith("+++")) return theme.fg("toolDiffAdded", line);
					if (line.startsWith("-") && !line.startsWith("---")) return theme.fg("toolDiffRemoved", line);
					return theme.fg("toolDiffContext", line);
				}),
		];
	});
	return new Text(lines.join("\n"), 0, 0);
}
