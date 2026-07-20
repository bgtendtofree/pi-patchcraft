export function greeting(name: string): string {
	const normalized = name.trim();
	return `Hello, ${normalized || "Pi"}!`;
}
