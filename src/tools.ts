/** Tools Patchcraft replaces while enabled. Everything else is taken from the session baseline untouched. */
const MANAGED_TOOLS = new Set(["apply_patch", "edit", "write"]);

/** Patchcraft owns `apply_patch` for GPT/Codex-family models unless the mode overrides it. */
export function isPatchcraftModel(modelId: string | undefined, api?: string): boolean {
	if (api === "openai-codex-responses") return true;
	return modelId?.toLowerCase().split("/").pop()?.startsWith("gpt-") ?? false;
}

/**
 * Reconcile the baseline loadout with the tools active right now.
 *
 * User- and extension-provided tools are preserved. Managed tools follow the baseline and the
 * effective mode, so a baseline without `edit`/`write` never restores them.
 */
export function reconcileActiveTools(options: {
	baseline: readonly string[];
	current: readonly string[];
	usePatchcraft: boolean;
}): string[] {
	const { baseline, current, usePatchcraft } = options;
	const desiredManaged = new Set<string>();
	if (usePatchcraft) {
		desiredManaged.add("apply_patch");
	} else {
		if (baseline.includes("edit")) desiredManaged.add("edit");
		if (baseline.includes("write")) desiredManaged.add("write");
	}

	const currentUnmanaged = current.filter((name) => !MANAGED_TOOLS.has(name));
	const currentUnmanagedSet = new Set(currentUnmanaged);
	const next = baseline.filter(
		(name) =>
			(MANAGED_TOOLS.has(name) && desiredManaged.has(name)) ||
			(!MANAGED_TOOLS.has(name) && currentUnmanagedSet.has(name)),
	);
	for (const name of currentUnmanaged) {
		if (!next.includes(name)) next.push(name);
	}
	if (usePatchcraft && !next.includes("apply_patch")) next.push("apply_patch");
	return next;
}
