/**
 * Lesson highlights (fork feature) — the store methods and the routes:
 * PUT (idempotent upsert, validation, anchor check), DELETE, GET, the
 * highlights-changed event, list privacy, and the Markdown export section.
 *
 * Runs under an isolated LH_DATA_DIR set before any config-loading import.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";

const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "lh-highlights-"));
process.env.LH_DATA_DIR = TMP_DATA;

type Ctx = { params: Promise<{ id: string; hid: string }> };
type ListCtx = { params: Promise<{ id: string }> };
let PUT: (req: Request, ctx: Ctx) => Promise<Response>;
let DELETE: (req: Request, ctx: Ctx) => Promise<Response>;
let GET: (req: Request, ctx: ListCtx) => Promise<Response>;
let EXPORT: (req: Request, ctx: ListCtx) => Promise<Response>;
let chatStore: typeof import("../src/store/chats.ts").chatStore;
let subscribe: typeof import("../src/core/events.ts").subscribe;

before(async () => {
	({ PUT, DELETE } = await import("../app/api/chats/[id]/highlights/[hid]/route.ts"));
	({ GET } = await import("../app/api/chats/[id]/highlights/route.ts"));
	({ GET: EXPORT } = await import("../app/api/chats/[id]/markdown/route.ts"));
	({ chatStore } = await import("../src/store/chats.ts"));
	({ subscribe } = await import("../src/core/events.ts"));
});

after(() => {
	fs.rmSync(TMP_DATA, { recursive: true, force: true });
});

function lesson() {
	const chat = chatStore.createChat("Dot products");
	chatStore.saveMessages(chat.id, [
		{ id: "u1", role: "user", content: "Teach me dot products", timestamp: 1 },
		{
			id: "a1",
			role: "assistant",
			content: [{ type: "text", text: "When both vectors have length 1, the dot product equals the cosine." }],
			timestamp: 2,
		},
	] as never);
	return chat;
}

const ctx = (id: string, hid: string): Ctx => ({ params: Promise.resolve({ id, hid }) });
const put = (id: string, hid: string, body: unknown, tab?: string) =>
	PUT(
		new Request("http://x/api", {
			method: "PUT",
			headers: { "content-type": "application/json", ...(tab ? { "x-lh-tab": tab } : {}) },
			body: JSON.stringify(body),
		}),
		ctx(id, hid),
	);

const body = {
	anchor: "t:a1-t0",
	quote: { exact: "the dot product equals the cosine", prefix: "length 1, ", suffix: ".", start: 34 },
	color: "yellow",
	comment: "",
};

describe("highlight routes + store", () => {
	it("PUT creates, then updates in place; updatedAt of the chat is untouched", async () => {
		const chat = lesson();
		const before = chatStore.getChat(chat.id)!.updatedAt;
		let res = await put(chat.id, "hl_1", body);
		assert.equal(res.status, 200);
		const created = ((await res.json()) as { highlight: { createdAt: string } }).highlight;
		res = await put(chat.id, "hl_1", { ...body, comment: "remember", color: "green" });
		assert.equal(res.status, 200);
		const record = chatStore.getChat(chat.id)!;
		assert.equal(record.highlights?.length, 1);
		assert.equal(record.highlights![0]!.comment, "remember");
		assert.equal(record.highlights![0]!.color, "green");
		assert.equal(record.highlights![0]!.createdAt, created.createdAt, "creation time survives");
		assert.equal(record.updatedAt, before, "a note is not conversation activity");
	});

	it("refuses unknown chats, bad ids, malformed bodies and unknown anchors", async () => {
		const chat = lesson();
		assert.equal((await put("chat_nope", "hl_1", body)).status, 404);
		assert.equal((await put(chat.id, "bad id!", body)).status, 400);
		assert.equal((await put(chat.id, "hl_2", { ...body, color: "purple" })).status, 400);
		const res = await put(chat.id, "hl_3", { ...body, anchor: "t:c_local-t0" });
		assert.equal(res.status, 400, "unsaved/streaming text can't be highlighted");
		assert.equal(chatStore.getChat(chat.id)!.highlights, undefined);
	});

	it("an existing highlight stays editable after its text disappears", async () => {
		const chat = lesson();
		assert.equal((await put(chat.id, "hl_1", body)).status, 200);
		chatStore.saveMessages(chat.id, [] as never);
		assert.equal((await put(chat.id, "hl_1", { ...body, comment: "still here" })).status, 200);
	});

	it("GET lists; DELETE removes (404 when unknown)", async () => {
		const chat = lesson();
		await put(chat.id, "hl_1", body);
		const list = (await (await GET(new Request("http://x"), { params: Promise.resolve({ id: chat.id }) })).json()) as {
			highlights: unknown[];
		};
		assert.equal(list.highlights.length, 1);
		assert.equal((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(chat.id, "hl_1"))).status, 200);
		assert.equal((await DELETE(new Request("http://x", { method: "DELETE" }), ctx(chat.id, "hl_1"))).status, 404);
		assert.equal(chatStore.getChat(chat.id)!.highlights?.length, 0);
	});

	it("routes announce highlights-changed with the writing tab; the store itself stays silent", async () => {
		const chat = lesson();
		const seen: unknown[] = [];
		const off = subscribe((e) => {
			if (e.type === "highlights-changed" || e.type === "chats-changed") seen.push(e);
		});
		try {
			chatStore.saveHighlight(chat.id, { id: "hl_s", ...body, color: "yellow", createdAt: "x", updatedAt: "x" } as never);
			assert.deepEqual(seen, [], "silence law: content writes announce nothing");
			await put(chat.id, "hl_1", body, "tab123");
			assert.deepEqual(seen, [{ type: "highlights-changed", chatId: chat.id, source: "tab123" }]);
		} finally {
			off();
		}
	});

	it("the sidebar list never carries highlights", async () => {
		const chat = lesson();
		await put(chat.id, "hl_1", { ...body, comment: "private" });
		const summary = chatStore.listChats().find((c) => c.id === chat.id)!;
		assert.equal("highlights" in summary, false);
	});

	it("the Markdown export appends a Highlights section; extraction's view stays clean", async () => {
		const chat = lesson();
		await put(chat.id, "hl_1", { ...body, comment: "the key fact" });
		const md = await (await EXPORT(new Request("http://x"), { params: Promise.resolve({ id: chat.id }) })).text();
		assert.ok(md.includes("## Highlights\n\n> the dot product equals the cosine\n\n**Yellow:** the key fact"));
		assert.ok(!md.includes("hl_1") && !md.includes("t:a1-t0"), "no ids in the export");
		const { sessionMarkdown } = await import("../src/core/session-markdown.ts");
		const engine = sessionMarkdown(chatStore.getChat(chat.id)!.messages, { title: "x", anchors: true });
		assert.ok(!engine.includes("the key fact"), "the extraction engine never sees notes");
	});
});
