/**
 * Uploaded VS Code themes.
 *
 *   GET                       → { themes: [{ id, name, type }] }
 *   POST { text, fileName? }  → { theme, warnings }  map + store one theme file
 *
 * The browser sends the file's text; the server maps it (vscodeThemeToCustom)
 * and stores only validated colors. 400 = not a usable theme file, 409 = the
 * theme list is full, 413 = too large.
 */
import { CUSTOM_THEME_LIMITS, ThemeFileError, customThemeSummary, vscodeThemeToCustom } from "@/src/core";
import { addTheme, listThemes, ThemeStoreFullError } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
	return Response.json({ themes: listThemes().map(customThemeSummary) });
}

export async function POST(req: Request): Promise<Response> {
	// JSON escaping can double a file's size on the wire; anything past that
	// is refused before it's read.
	if (Number(req.headers.get("content-length") ?? 0) > CUSTOM_THEME_LIMITS.fileChars * 2) {
		return Response.json({ error: "This file is too large to be a color theme." }, { status: 413 });
	}
	const body = (await req.json().catch(() => null)) as { text?: unknown; fileName?: unknown } | null;
	if (!body || typeof body.text !== "string") return Response.json({ error: "Send the theme file's text." }, { status: 400 });
	if (body.text.length > CUSTOM_THEME_LIMITS.fileChars) {
		return Response.json({ error: "This file is too large to be a color theme." }, { status: 413 });
	}
	const fileName = typeof body.fileName === "string" ? body.fileName.slice(0, 200) : undefined;
	try {
		const { theme, warnings } = vscodeThemeToCustom(body.text, fileName);
		return Response.json({ theme: addTheme(theme), warnings });
	} catch (err) {
		if (err instanceof ThemeFileError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof ThemeStoreFullError) return Response.json({ error: err.message }, { status: 409 });
		throw err;
	}
}
