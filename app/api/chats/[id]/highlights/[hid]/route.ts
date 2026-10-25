/**
 * LESSON HIGHLIGHTS (fork feature) — one highlight by its client-minted id.
 *
 * PUT    /api/chats/:id/highlights/:hid  body {anchor, quote, color, comment}
 *        → idempotent create-or-update (creation time survives updates).
 * DELETE /api/chats/:id/highlights/:hid  → remove it.
 *
 * 404 unknown chat (or, for DELETE, unknown highlight); 400 malformed body,
 * bad id, or an anchor that names nothing highlightable in the SAVED record
 * (streaming or unsaved text can't be highlighted). Writes are not
 * conversation activity — no updatedAt bump — and announce
 * highlights-changed so other open tabs re-sync; the writing tab passes
 * its id in x-lh-tab to skip its own echo.
 */
import {
	buildHighlight,
	emit,
	highlightAnchorsOf,
	HighlightInputError,
	isHighlightId,
	parseHighlightPut,
} from "@/src/core";
import { getChat, stores } from "@/src/server";

type Ctx = { params: Promise<{ id: string; hid: string }> };

function tabOf(req: Request): string | undefined {
	const tab = req.headers.get("x-lh-tab");
	return tab && /^[A-Za-z0-9_-]{1,64}$/.test(tab) ? tab : undefined;
}

export async function PUT(req: Request, ctx: Ctx): Promise<Response> {
	const { id, hid } = await ctx.params;
	const chat = getChat(id);
	if (!chat) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (!isHighlightId(hid)) return Response.json({ error: "Invalid highlight id" }, { status: 400 });
	let body;
	try {
		body = parseHighlightPut(await req.json().catch(() => null));
	} catch (err) {
		if (err instanceof HighlightInputError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
	const existing = chat.highlights?.find((h) => h.id === hid);
	// A new highlight must name saved text. An existing one keeps its anchor
	// even if that text later disappears (an orphan stays editable).
	if (body.anchor !== existing?.anchor && !highlightAnchorsOf(chat.messages).has(body.anchor)) {
		return Response.json({ error: "That text can't be highlighted (not saved yet, or not highlightable)" }, { status: 400 });
	}
	const highlight = buildHighlight(hid, body, existing, new Date().toISOString());
	stores.chatStore.saveHighlight(id, highlight);
	emit("highlights-changed", { chatId: id, source: tabOf(req) });
	return Response.json({ highlight });
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
	const { id, hid } = await ctx.params;
	if (!getChat(id)) return Response.json({ error: "Unknown chat" }, { status: 404 });
	if (!stores.chatStore.deleteHighlight(id, hid)) {
		return Response.json({ error: "Unknown highlight" }, { status: 404 });
	}
	emit("highlights-changed", { chatId: id, source: tabOf(req) });
	return Response.json({ ok: true });
}
