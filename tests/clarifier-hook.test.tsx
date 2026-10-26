/**
 * useClarifier's races: the saved thread's load vs the learner's own
 * actions, refused messages, and a question change mid-reply. Interactive
 * (linkedom + act, the acp-picker pattern) with a scripted fetch.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { useClarifier, type ClarifierState } from "../components/question-clarifier.tsx";
import type { ClarifyExchange } from "../src/core/index.ts";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const ex = (asked: string): ClarifyExchange => ({ asked, reply: `about ${asked}`, at: `2026-10-25T00:00:0${asked.length % 10}.000Z` });

/** A response the test releases by hand. */
function deferred() {
	let resolve!: (body: unknown, status?: number) => void;
	const promise = new Promise<Response>((r) => {
		resolve = (body, status = 200) => r(new Response(JSON.stringify(body), { status }));
	});
	return { promise, resolve };
}

type Handler = (url: string, init: RequestInit | undefined) => Promise<Response>;
const originalFetch = globalThis.fetch;
function scriptFetch(handler: Handler) {
	globalThis.fetch = ((url: string | URL, init?: RequestInit) => handler(String(url), init)) as typeof fetch;
}
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));

let latest!: ClarifierState;
function Harness({ id, kind = "question" }: { id: string | null; kind?: "question" | "reply" }) {
	latest = useClarifier("chat_1", id ? { kind, id } : null, undefined, { focusOnTarget: kind === "reply" });
	return null;
}

let root: Root | undefined;
async function mount(id: string | null) {
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () => root!.render(<Harness id={id} />));
}
async function rerender(id: string | null) {
	await act(async () => root!.render(<Harness id={id} />));
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	globalThis.fetch = originalFetch;
});

describe("useClarifier", () => {
	it("loads the saved thread and reopens the panel with it", async () => {
		scriptFetch(() => json({ thread: [ex("one")] }));
		await mount("q1");
		assert.deepEqual(latest.thread.map((e) => e.asked), ["one"]);
		assert.equal(latest.open, true);
		// An auto-open never grabs focus.
		assert.equal(latest.takeFocus(), false);
	});

	it("a learner's toggle wins over a late load", async () => {
		const load = deferred();
		scriptFetch(() => load.promise);
		await mount("q1");
		await act(async () => latest.setOpen(true));
		await act(async () => latest.setOpen(false));
		await act(async () => load.resolve({ thread: [ex("one")] }));
		assert.equal(latest.thread.length, 1);
		assert.equal(latest.open, false);
	});

	it("a late load never overwrites the newer thread from a reply", async () => {
		const load = deferred();
		scriptFetch((_url, init) => (init?.method === "POST" ? json({ thread: [ex("one"), ex("two")] }) : load.promise));
		await mount("q1");
		await act(async () => latest.ask("two"));
		await act(async () => load.resolve({ thread: [ex("one")] }));
		assert.deepEqual(latest.thread.map((e) => e.asked), ["one", "two"]);
	});

	it("takeFocus is true once per learner open", async () => {
		scriptFetch(() => json({ thread: [] }));
		await mount("q1");
		await act(async () => latest.setOpen(true));
		assert.equal(latest.takeFocus(), true);
		assert.equal(latest.takeFocus(), false);
	});

	it("a refused message comes back to the draft with the error", async () => {
		scriptFetch((_url, init) => (init?.method === "POST" ? json({ error: "No model configured" }, 503) : json({ thread: [] })));
		await mount("q1");
		await act(async () => latest.ask("what is X?"));
		assert.equal(latest.draft, "what is X?");
		assert.equal(latest.error, "No model configured");
		assert.equal(latest.pendingAsk, null);
	});

	it("a question change aborts the reply and leaves the next question's side chat clean", async () => {
		let aborted = false;
		scriptFetch((url, init) => {
			if (init?.method !== "POST") return json({ thread: [] });
			return new Promise((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new DOMException("aborted", "AbortError"));
				});
			});
		});
		await mount("q1");
		let pendingReply!: Promise<void>;
		await act(async () => {
			pendingReply = latest.ask("about q1");
		});
		assert.equal(latest.pendingAsk, "about q1");
		await rerender("q2");
		await act(async () => pendingReply);
		assert.equal(aborted, true);
		assert.equal(latest.draft, "", "q1's message must not land in q2's draft");
		assert.equal(latest.pendingAsk, null);
		assert.equal(latest.error, null);
		assert.deepEqual(latest.thread, []);
	});

	it("switching reply chats lets the earlier request finish, and the next reply can ask at once", async () => {
		let aborted = false;
		const first = deferred();
		const posts: unknown[] = [];
		scriptFetch((_url, init) => {
			if (init?.method !== "POST") return json({ thread: [] });
			const body = JSON.parse(String(init.body)) as { replyId: string };
			posts.push(body);
			if (body.replyId === "a2-t0") {
				init.signal?.addEventListener("abort", () => {
					aborted = true;
				});
				return first.promise;
			}
			return json({ thread: [ex("next?")] });
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<Harness id="a2-t0" kind="reply" />));
		let pendingReply!: Promise<void>;
		await act(async () => {
			pendingReply = latest.ask("draw it");
		});
		await act(async () => root!.render(<Harness id="a3-t0" kind="reply" />));
		assert.equal(aborted, false, "a reply chat's request still saves, so it isn't cancelled");
		assert.equal(latest.pendingAsk, null);
		await act(async () => latest.ask("next?"));
		assert.deepEqual(latest.thread.map((e) => e.asked), ["next?"]);
		await act(async () => {
			first.resolve({ thread: [ex("draw it")] });
			await pendingReply;
		});
		assert.deepEqual(latest.thread.map((e) => e.asked), ["next?"], "the earlier reply's thread never paints onto this one");
		assert.equal(posts.length, 2);
	});

	it("talks to the endpoint by replyId for a tutor reply, and takes focus when opened", async () => {
		const urls: string[] = [];
		const bodies: unknown[] = [];
		scriptFetch((url, init) => {
			urls.push(url);
			if (init?.method === "POST") {
				bodies.push(JSON.parse(String(init.body)));
				return json({ thread: [ex("why?")] });
			}
			return json({ thread: [] });
		});
		const host = document.createElement("div");
		document.body.appendChild(host);
		root = createRoot(host);
		await act(async () => root!.render(<Harness id="a2-t0" kind="reply" />));
		assert.equal(urls[0], "/api/chats/chat_1/clarify?replyId=a2-t0");
		assert.equal(latest.kind, "reply");
		assert.equal(latest.tutorSees, true, "absent option: the tutor sees it");
		assert.equal(latest.takeFocus(), true);
		await act(async () => latest.ask("why?"));
		assert.deepEqual(bodies[0], { replyId: "a2-t0", text: "why?" });
	});
});
