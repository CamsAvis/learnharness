/**
 * One uploaded theme.
 *
 *   GET     → { theme }  the full theme (colors + syntax rules)
 *   DELETE  → { ok: true }
 *
 * Deleting the theme that appearance points at needs no settings write:
 * a custom mode whose theme is gone renders as Dark (appearanceModeClass).
 */
import { deleteTheme, getTheme } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const theme = getTheme(id);
	if (!theme) return Response.json({ error: "unknown theme" }, { status: 404 });
	return Response.json({ theme });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	if (!deleteTheme(id)) return Response.json({ error: "unknown theme" }, { status: 404 });
	return Response.json({ ok: true });
}
