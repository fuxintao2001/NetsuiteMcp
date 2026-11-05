import open from "open";

/**
 * Open URL in default browser (cross-platform).
 * Uses the mature, industry-standard 'open' library to safely handle URL arguments,
 * escape special characters (such as '&' query parameters in OAuth flows),
 * and prevent command injection across Windows, macOS, and Linux.
 */
export async function openBrowser(
	url: string,
	launcher: (target: string) => Promise<unknown> = open,
): Promise<void> {
	try {
		await launcher(url);
		console.error("🌐 Browser opened automatically");
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		console.error("⚠️  Could not auto-open browser:", message);
		console.error("   Please open the URL manually");
	}
}
