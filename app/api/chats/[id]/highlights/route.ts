/**
 * LESSON HIGHLIGHTS (fork feature) — GET /api/chats/:id/highlights → the
 * chat's highlights, for the client's re-sync after a highlights-changed
 * event or a cached page. Writes go through ./[hid]/route.ts.
 */
import { getChat } from "@/src/server";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
	return Response.json({ highlights: chat.highlights ?? [] });
}
