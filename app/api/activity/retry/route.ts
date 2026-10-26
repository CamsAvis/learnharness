/**
 * POST /api/activity/retry — the job card's Retry button: re-run a failed or
 * aborted figure or demo job as a new job for the same tool call (retryJob,
 * server/jobs.ts). Body {kind: "job", id: jobId}, mirroring the abort route.
 *
 * Outcomes: retried -> 200 {ok, jobId}; unknown job -> 404; not a failed
 * figure/demo, or a retry already running -> 409; the job runner not yet
 * wired in this process -> 503 (try again).
 */
import { retryJob } from "@/src/server";

export async function POST(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const { kind, id } = (body ?? {}) as { kind?: string; id?: string };
	if (kind !== "job" || typeof id !== "string" || !/^[A-Za-z0-9:_-]+$/.test(id)) {
		return Response.json({ error: 'Body must be {kind: "job", id: string}' }, { status: 400 });
	}
	const outcome = retryJob(id);
	if (!outcome.ok) {
		const status = outcome.reason === "not_found" ? 404 : outcome.reason === "not_ready" ? 503 : 409;
		return Response.json({ ok: false, reason: outcome.reason }, { status });
	}
	return Response.json({ ok: true, jobId: outcome.job.id });
}
