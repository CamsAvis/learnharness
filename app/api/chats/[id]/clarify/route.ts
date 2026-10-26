/**
 * The side chat (clarifier), about an open question (toolCallId) or one of
 * the tutor's replies (replyId, a text part id `<message id>-t<n>`).
 *
 *   GET  ?toolCallId=… | ?replyId=…          → { thread }  saved exchanges ([] when none)
 *   POST { toolCallId | replyId, text }      → { exchange, thread }  one helper reply
 *
 * POST refuses honestly: 404 unknown chat, 409 the question is not open (or
 * a reply for it is already being written), 400 an empty/oversized message
 * or a full thread, 503 no usable Cheap-slot model, 502 the model failed.
 * The request's abort signal cancels the model call.
 */
import { clarifyQuestion, clarifyThread, parseClarifyTarget } from "@/src/server";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const params = new URL(req.url).searchParams;
	const target = parseClarifyTarget({ toolCallId: params.get("toolCallId") ?? undefined, replyId: params.get("replyId") ?? undefined });
	if ("error" in target) return Response.json({ error: target.error }, { status: 400 });
	const thread = clarifyThread(id, target);
	if (!thread) return Response.json({ error: "unknown chat" }, { status: 404 });
	return Response.json({ thread });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	const result = await clarifyQuestion(id, body, req.signal);
	if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
	return Response.json({ exchange: result.exchange, thread: result.thread });
}
