/**
 * Lesson highlights (fork feature) — the client store: optimistic edits,
 * debounced note saves, per-id write ordering, rollback, and the re-sync
 * merge rule (server wins except unsaved local changes).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LessonHighlightsStore } from "../components/lesson-highlights-store.ts";
import type { LessonHighlight } from "../src/core/contracts/chat.ts";

interface Call {
	url: string;
	method: string;
	body?: Record<string, unknown>;
	tab?: string | null;
	keepalive?: boolean;
	resolve: (res: Response) => void;
}

function harness(initial: LessonHighlight[] = []) {
	const calls: Call[] = [];
	const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
	const fetch = ((url: string, init?: RequestInit) =>
		new Promise<Response>((resolve) => {
			calls.push({
				url,
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(String(init.body)) : undefined,
				tab: new Headers(init?.headers).get("x-lh-tab"),
				keepalive: init?.keepalive,
				resolve,
			});
		})) as typeof globalThis.fetch;
	const store = new LessonHighlightsStore("chat_1", initial, {
		fetch,
		setTimeout: (fn, ms) => {
			const t = { fn, ms, cancelled: false };
			timers.push(t);
			return t;
		},
		clearTimeout: (h) => {
			(h as { cancelled: boolean }).cancelled = true;
		},
		now: () => "2026-10-25T12:00:00.000Z",
	});
	const fireTimers = () => {
		for (const t of timers.splice(0)) if (!t.cancelled) t.fn();
	};
	return { store, calls, fireTimers };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, error: string) => new Response(JSON.stringify({ error }), { status });
const tick = () => new Promise((r) => setTimeout(r, 0));

const quote = { exact: "the dot product", prefix: "", suffix: "", start: 0 };
const saved = (over: Partial<LessonHighlight> = {}): LessonHighlight => ({
	id: "hl_a",
	anchor: "t:a1-t0",
	quote,
	color: "yellow",
	comment: "",
	createdAt: "2026-10-01T00:00:00.000Z",
	updatedAt: "2026-10-01T00:00:00.000Z",
	...over,
});

describe("LessonHighlightsStore", () => {
	it("create is optimistic: listed, selected, panel open, note focus requested, PUT sent with the tab id", async () => {
		const { store, calls } = harness();
		const h = store.create({ anchor: "t:a1-t0", quote, color: "blue" });
		const s = store.getSnapshot();
		assert.equal(s.list.length, 1);
		assert.equal(s.list[0]!.color, "blue");
		assert.equal(s.open, true);
		assert.equal(s.selectedId, h.id);
		assert.equal(s.focusCommentId, h.id);
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.method, "PUT");
		assert.ok(calls[0]!.url.endsWith(`/api/chats/chat_1/highlights/${h.id}`));
		assert.deepEqual(calls[0]!.body, { anchor: "t:a1-t0", quote, color: "blue", comment: "" });
		assert.equal(calls[0]!.tab, store.tabId);
	});

	it("a refused create (400) is dropped with an error", async () => {
		const { store, calls } = harness();
		store.create({ anchor: "t:c_x-t0", quote });
		await tick();
		calls[0]!.resolve(fail(400, "That text can't be highlighted"));
		await tick();
		await tick();
		const s = store.getSnapshot();
		assert.equal(s.list.length, 0);
		assert.equal(s.selectedId, null);
		assert.match(s.error ?? "", /can't be highlighted/);
	});

	it("note edits save once after the pause, with the latest text; flush saves now", async () => {
		const { store, calls, fireTimers } = harness([saved()]);
		store.setComment("hl_a", "re");
		store.setComment("hl_a", "remember");
		assert.equal(store.get("hl_a")!.comment, "remember", "local at once");
		await tick();
		assert.equal(calls.length, 0, "nothing sent while typing");
		fireTimers();
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.body!.comment, "remember");
		calls[0]!.resolve(ok({ highlight: saved({ comment: "remember" }) }));
		await tick();
		store.setComment("hl_a", "remember this");
		store.flush("hl_a", true);
		await tick();
		await tick();
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.keepalive, true);
		assert.equal(calls[1]!.body!.comment, "remember this");
	});

	it("writes to one highlight go out in order (the second waits for the first)", async () => {
		const { store, calls } = harness([saved()]);
		store.setColor("hl_a", "green");
		store.setColor("hl_a", "pink");
		await tick();
		assert.equal(calls.length, 1, "second PUT is queued");
		calls[0]!.resolve(ok({ highlight: saved({ color: "green" }) }));
		await tick();
		await tick();
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.body!.color, "pink");
	});

	it("delete cancels a pending note save, and a failed delete puts the item back", async () => {
		const { store, calls, fireTimers } = harness([saved()]);
		store.setComment("hl_a", "typing");
		store.remove("hl_a");
		fireTimers();
		await tick();
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.method, "DELETE");
		assert.equal(store.getSnapshot().list.length, 0);
		calls[0]!.resolve(fail(500, "disk full"));
		await tick();
		await tick();
		assert.equal(store.getSnapshot().list.length, 1);
		assert.match(store.getSnapshot().error ?? "", /disk full/);
	});

	it("re-sync: the server wins, except unsaved local changes and pending deletes", async () => {
		const { store, calls } = harness([saved(), saved({ id: "hl_b" }), saved({ id: "hl_c" })]);
		store.setColor("hl_a", "pink"); // unsaved local change (PUT in flight)
		store.remove("hl_b"); // pending delete
		store.adopt([
			saved({ color: "green" }), // stale server copy of a
			saved({ id: "hl_b" }),
			saved({ id: "hl_c", comment: "from another tab" }),
			saved({ id: "hl_d" }), // created in another tab
		]);
		const list = store.getSnapshot().list;
		assert.deepEqual(list.map((h) => h.id), ["hl_a", "hl_c", "hl_d"]);
		assert.equal(list[0]!.color, "pink", "local unsaved edit kept");
		assert.equal(list[1]!.comment, "from another tab", "clean item adopted");
		await tick();
		assert.deepEqual(calls.map((c) => c.method).sort(), ["DELETE", "PUT"]);
	});

	it("selecting a highlight hidden by the color filter clears the filter", () => {
		const { store } = harness([saved({ color: "yellow" })]);
		store.setFilter("pink");
		store.select("hl_a");
		assert.equal(store.getSnapshot().filter, null);
		store.setFilter("yellow");
		store.select("hl_a");
		assert.equal(store.getSnapshot().filter, "yellow", "a filter that shows it stays");
	});

	it("a failed save is retried on flush", async () => {
		const { store, calls } = harness([saved()]);
		store.setColor("hl_a", "green");
		await tick();
		calls[0]!.resolve(new Response("x", { status: 503 }));
		await tick();
		await tick();
		assert.match(store.getSnapshot().error ?? "", /retry/);
		store.flush(undefined, true);
		await tick();
		assert.equal(calls.length, 2);
		assert.equal(calls[1]!.keepalive, true);
		calls[1]!.resolve(ok({ highlight: saved({ color: "green" }) }));
		await tick();
		await tick();
		assert.equal(store.getSnapshot().error, null, "banner clears once nothing is unsaved");
	});

	it("a re-sync whose GET overlapped a write fetches again instead of dropping it", async () => {
		const { store, calls } = harness([]);
		const syncing = store.sync();
		await tick();
		const firstGet = calls[0]!;
		const created = store.create({ anchor: "t:a1-t0", quote });
		await tick();
		calls[1]!.resolve(ok({ highlight: { ...created } }));
		await tick();
		await tick();
		firstGet.resolve(ok({ highlights: [] })); // predates the PUT
		await tick();
		await tick();
		const secondGet = calls[2]!;
		assert.equal(secondGet.method, "GET", "fetched again");
		secondGet.resolve(ok({ highlights: [created] }));
		await syncing;
		assert.deepEqual(store.getSnapshot().list.map((h) => h.id), [created.id]);
	});

	it("a save that fails after its highlight was deleted is not retried and doesn't pin the error", async () => {
		const { store, calls } = harness([saved(), saved({ id: "hl_b" })]);
		store.setColor("hl_a", "green");
		await tick();
		store.remove("hl_a"); // DELETE queued behind the in-flight PUT
		calls[0]!.resolve(new Response("x", { status: 503 }));
		await tick();
		await tick();
		calls[1]!.resolve(ok({ ok: true })); // the DELETE
		await tick();
		await tick();
		store.setColor("hl_b", "blue");
		await tick();
		calls[2]!.resolve(ok({ highlight: saved({ id: "hl_b", color: "blue" }) }));
		await tick();
		await tick();
		assert.equal(store.getSnapshot().error, null, "nothing unsaved remains, so the banner clears");
		store.flush(undefined, true);
		await tick();
		assert.equal(calls.length, 3, "no retry for the deleted highlight");
	});

	it("status updates only notify when something changed", () => {
		const { store } = harness([saved()]);
		let notified = 0;
		store.subscribe(() => notified++);
		store.setStatus(new Map([["hl_a", "found"]]));
		store.setStatus(new Map([["hl_a", "found"]]));
		assert.equal(notified, 1);
	});
});
