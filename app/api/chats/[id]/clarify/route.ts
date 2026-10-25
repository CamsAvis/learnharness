/**
 * The question side chat (clarifier).
 *
 *   GET  ?toolCallId=…          → { thread }  the saved exchanges ([] when none)
 *   POST { toolCallId, text }   → { exchange, thread }  one reply from the clarifier
 *
 * POST refuses honestly: 404 unknown chat, 409 the question is not open (or
 * a reply for it is already being written), 400 an empty/oversized message
 * or a full thread, 503 no usable Cheap-slot model, 502 the model failed.
 * The request's abort signal cancels the model call.
 */
import { clarifyQuestion, clarifyThread } from "@/src/server";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
	const { id } = await ctx.params;
	const toolCallId = new URL(req.url).searchParams.get("toolCallId");
	if (!toolCallId) return Response.json({ error: "toolCallId is required" }, { status: 400 });
	const thread = clarifyThread(id, toolCallId);
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
