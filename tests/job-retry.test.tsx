/**
 * Retrying a failed or aborted figure/demo job from its card: the server's
 * rules (a NEW job for the same tool call, handed to the runner) and the
 * card (follows the newest job; Retry only on a failed figure or demo).
 * Runs against a throwaway data dir.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { JobRecord } from "../src/core/contracts.ts";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-job-retry-"));
process.env.LH_DATA_DIR = dataDir;

type Server = typeof import("../src/server/jobs.ts");
let server: Server;
let chatStore: typeof import("../src/store/chats.ts").chatStore;
let jobStore: typeof import("../src/store/jobs.ts").jobStore;
let modelsRefusal: string;

before(async () => {
	server = await import("../src/server/jobs.ts");
	({ chatStore } = await import("../src/store/chats.ts"));
	({ jobStore } = await import("../src/store/jobs.ts"));
	modelsRefusal = (await import("../src/core/settings.ts")).modelsNotConfigured([]).error;
});
after(() => fs.rmSync(dataDir, { recursive: true, force: true }));

/** A chat whose tutor dispatched a figure (call_v1), and that job's record
 *  settled as `patch` says. */
function chatWithFailedJob(patch: Partial<JobRecord>, kind: JobRecord["kind"] = "visual") {
	const chat = chatStore.createChat("retry test");
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "show me", timestamp: 1 } as never,
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "toolCall", id: "call_v1", name: kind, arguments: { brief: "a unit circle" } }],
			timestamp: 2,
		} as never,
	]);
	const job = jobStore.createJob({ kind, chatId: chat.id, toolCallId: "call_v1" });
	jobStore.updateJob(job.id, { status: "error", error: "Aborted by learner", activity: "aborted", ...patch });
	return { chatId: chat.id, jobId: job.id };
}

describe("retryJob", () => {
	it("waits for the job runner to be wired", () => {
		const { jobId } = chatWithFailedJob({});
		assert.deepEqual(server.retryJob(jobId), { ok: false, reason: "not_ready" });
	});

	it("starts a new job for the same tool call and hands it to the runner", () => {
		const spawned: string[] = [];
		server.setJobRespawn((id) => void spawned.push(id));
		const { chatId, jobId } = chatWithFailedJob({});
		const outcome = server.retryJob(jobId);
		assert.ok(outcome.ok);
		const fresh = outcome.job;
		assert.notEqual(fresh.id, jobId, "a new job: the old one's steer id is already spent on its abort note");
		assert.equal(fresh.toolCallId, "call_v1");
		assert.equal(fresh.chatId, chatId);
		assert.equal(fresh.status, "running");
		assert.equal(fresh.activity, "retrying");
		assert.deepEqual(spawned, [fresh.id]);
		assert.equal(jobStore.getJob(jobId)!.status, "error", "the old job stays as it was");

		assert.deepEqual(server.retryJob(jobId), { ok: false, reason: "already_running" }, "one retry at a time");
	});

	it("retries demos too, and plain failures as well as aborts", () => {
		server.setJobRespawn(() => {});
		assert.ok(server.retryJob(chatWithFailedJob({ error: "the builder crashed" }, "demo").jobId).ok);
	});

	it("refuses running jobs, other kinds, refusals and unknown jobs", () => {
		server.setJobRespawn(() => {});
		assert.deepEqual(server.retryJob(chatWithFailedJob({ status: "running" }).jobId), { ok: false, reason: "not_retryable" });
		assert.deepEqual(server.retryJob(chatWithFailedJob({}, "research").jobId), { ok: false, reason: "not_retryable" });
		assert.deepEqual(server.retryJob(chatWithFailedJob({ error: modelsRefusal }).jobId), { ok: false, reason: "not_retryable" });
		assert.deepEqual(server.retryJob("job_nope"), { ok: false, reason: "not_found" });
	});
});

describe("the job card", () => {
	const job = (over: Partial<JobRecord>): JobRecord => ({
		id: "job_1",
		kind: "visual",
		chatId: "chat_1",
		toolCallId: "call_v1",
		status: "error",
		activity: "aborted",
		error: "Aborted by learner",
		createdAt: "2026-10-26T03:00:00.000Z",
		updatedAt: "2026-10-26T03:00:00.000Z",
		...over,
	});

	async function render(jobs: JobRecord[], kind: JobRecord["kind"] = "visual"): Promise<string> {
		const { DispatchCard } = await import("../components/artifacts/dispatch-card.tsx");
		const { JobsContext } = await import("../components/jobs-context.ts");
		return renderToStaticMarkup(
			<JobsContext.Provider value={jobs}>
				<DispatchCard toolCallId="call_v1" kind={kind} />
			</JobsContext.Provider>,
		);
	}

	it("offers Retry on a failed figure or demo", async () => {
		assert.match(await render([job({})]), /data-testid="dispatch-retry"[^>]*>Retry</);
		assert.match(await render([job({ kind: "demo" })], "demo"), /data-testid="dispatch-retry"/);
	});

	it("doesn't offer it for research, a delivered figure, or a refusal", async () => {
		assert.doesNotMatch(await render([job({ kind: "research" })], "research"), /dispatch-retry/);
		assert.doesNotMatch(await render([job({ status: "done", error: undefined })]), /dispatch-retry/);
		const refused = await render([job({ error: modelsRefusal })]);
		assert.match(refused, /data-testid="dispatch-refused"/);
		assert.doesNotMatch(refused, /dispatch-retry/);
	});

	it("follows the newest job for its call, so a running retry replaces the failed line", async () => {
		const html = await render([
			job({ id: "job_2", status: "running", activity: "retrying", error: undefined, createdAt: "2026-10-26T03:05:00.000Z", updatedAt: "2026-10-26T03:05:00.000Z" }),
			job({ updatedAt: "2026-10-26T03:06:00.000Z" }), // the old one, touched later
		]);
		assert.match(html, /data-testid="dispatch-card"/);
		assert.match(html, /retrying/);
		assert.doesNotMatch(html, /dispatch-retry/);
	});
});
