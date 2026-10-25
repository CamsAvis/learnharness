/**
 * Lesson highlights (fork feature) — the pure core: anchor vocabulary,
 * PUT validation, quote location, ordering and the export section.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	answeredCardAnchor,
	buildHighlight,
	highlightAnchorsOf,
	HighlightInputError,
	highlightsMarkdown,
	isHighlightId,
	locateQuote,
	orderHighlights,
	parseHighlightPut,
	quoteFor,
	teacherTextAnchor,
	userMessageAnchor,
} from "../src/core/highlights.ts";
import { projectView } from "../src/core/view.ts";
import type { LessonHighlight } from "../src/core/contracts/chat.ts";
import type { LhMessage } from "../src/core/native-messages.ts";

const assistant = (id: string, content: unknown[]): LhMessage =>
	({ id, role: "assistant", content, timestamp: 1 }) as unknown as LhMessage;
const user = (id: string, content: unknown): LhMessage => ({ id, role: "user", content, timestamp: 1 }) as unknown as LhMessage;
const result = (id: string, toolCallId: string, toolName = "quiz"): LhMessage =>
	({
		id,
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: "{}" }],
		details: { kind: "quiz", questionText: "q1", dontKnow: false, answers: [], answeredAt: "x" },
		isError: false,
		timestamp: 1,
	}) as unknown as LhMessage;

const record: LhMessage[] = [
	user("u1", "Teach me dot products"),
	assistant("a1", [
		{ type: "thinking", thinking: "plan" },
		{ type: "text", text: "When both vectors have length 1, the dot product equals the cosine." },
		{ type: "text", text: "   " },
		{ type: "toolCall", id: "call_0", name: "quiz", arguments: { question: "q1" } },
	]),
	result("r1", "call_0"),
	user("u2", [{ type: "text", text: "ok" }]),
	// Legacy duplicate call id (DeepSeek's per-response call_0), still pending.
	assistant("a2", [
		{ type: "text", text: "Next one." },
		{ type: "toolCall", id: "call_0", name: "quiz", arguments: { question: "q2" } },
	]),
	user("", "legacy message without id"),
];

const h = (over: Partial<LessonHighlight> = {}): LessonHighlight => ({
	id: "h1",
	anchor: teacherTextAnchor("a1-t0"),
	quote: { exact: "dot product", prefix: "", suffix: "", start: 0 },
	color: "yellow",
	comment: "",
	createdAt: "2026-10-25T00:00:00.000Z",
	updatedAt: "2026-10-25T00:00:00.000Z",
	...over,
});

describe("highlightAnchorsOf", () => {
	it("lists teacher text parts, learner messages and ANSWERED cards in transcript order", () => {
		const anchors = highlightAnchorsOf(record);
		assert.deepEqual([...anchors.keys()], [
			userMessageAnchor("u1"),
			teacherTextAnchor("a1-t0"),
			answeredCardAnchor("a1", "call_0"),
			userMessageAnchor("u2"),
			teacherTextAnchor("a2-t0"),
		]);
	});

	it("a placeholder result (no answer data) is not an answered card", () => {
		const posed = [
			assistant("a9", [{ type: "toolCall", id: "c9", name: "quiz", arguments: {} }]),
			{ id: "r9", role: "toolResult", toolCallId: "c9", toolName: "quiz", content: [], details: null, isError: false, timestamp: 1 } as unknown as LhMessage,
		];
		assert.equal(highlightAnchorsOf(posed).size, 0);
	});

	it("blank text parts are numbered but not anchorable; a pending duplicate-id call is not answered", () => {
		const anchors = highlightAnchorsOf(record);
		assert.equal(anchors.has(teacherTextAnchor("a1-t1")), false, "whitespace-only part");
		assert.equal(anchors.has(answeredCardAnchor("a2", "call_0")), false, "a2's call_0 has no result after it");
		assert.equal([...anchors.keys()].some((k) => k === "u:"), false, "id-less messages never anchor");
	});

	it("uses the same part ids as the client view", () => {
		const view = projectView(record);
		const textIds = view.flatMap((m) => m.parts).filter((p) => p.type === "text" && p.id).map((p) => p.id);
		assert.ok(textIds.includes("a1-t0") && textIds.includes("a2-t0"));
		const card = view.flatMap((m) => m.parts).find((p) => p.type === "tool-quiz" && p.state === "output-available");
		assert.equal(card?.sourceMessageId, "a1", "tool parts carry their owning message id");
	});
});

describe("parseHighlightPut", () => {
	it("accepts a well-formed body and defaults color and comment", () => {
		const body = parseHighlightPut({ anchor: "t:a1-t0", quote: { exact: "dot", prefix: "the ", suffix: " product", start: 4 } });
		assert.deepEqual(body, { anchor: "t:a1-t0", quote: { exact: "dot", prefix: "the ", suffix: " product", start: 4 }, color: "yellow", comment: "" });
	});

	it("refuses malformed bodies with HighlightInputError", () => {
		const bad = [
			null,
			{},
			{ anchor: "x:1", quote: { exact: "a" } },
			{ anchor: "t:1", quote: { exact: "   " } },
			{ anchor: "t:1", quote: { exact: "a" }, color: "purple" },
			{ anchor: "t:1", quote: { exact: "a", prefix: "x".repeat(33) } },
			{ anchor: "t:1", quote: { exact: "a" }, comment: 5 },
			{ anchor: "t:1", quote: { exact: "a".repeat(5001) } },
		];
		for (const b of bad) assert.throws(() => parseHighlightPut(b), HighlightInputError, JSON.stringify(b)?.slice(0, 60));
	});

	it("a bad start offset degrades to 0 (it is only a hint)", () => {
		assert.equal(parseHighlightPut({ anchor: "t:1", quote: { exact: "a", start: -3 } }).quote.start, 0);
	});

	it("ids are short and URL-safe", () => {
		assert.equal(isHighlightId("hl_abc-123"), true);
		assert.equal(isHighlightId("../etc"), false);
		assert.equal(isHighlightId(""), false);
	});

	it("buildHighlight keeps the creation time across updates", () => {
		const body = parseHighlightPut({ anchor: "t:1", quote: { exact: "a" } });
		const first = buildHighlight("h1", body, undefined, "T1");
		const second = buildHighlight("h1", { ...body, comment: "note" }, first, "T2");
		assert.equal(second.createdAt, "T1");
		assert.equal(second.updatedAt, "T2");
		assert.equal(second.comment, "note");
	});
});

describe("locateQuote", () => {
	const text = "the cat sat. the cat ran. the cat slept.";

	it("picks the occurrence whose context matches", () => {
		const quote = quoteFor(text, text.indexOf("cat ran") , text.indexOf("cat ran") + 3);
		assert.deepEqual(locateQuote(text, quote), { start: 17, end: 20 });
	});

	it("context wins over the stored offset; offset breaks ties", () => {
		const second = { exact: "cat", prefix: "the ", suffix: " ran", start: 0 };
		assert.equal(locateQuote(text, second)?.start, 17);
		const noContext = { exact: "cat", prefix: "", suffix: "", start: 30 };
		assert.equal(locateQuote(text, noContext)?.start, 30);
	});

	it("survives a whitespace reflow", () => {
		const quote = { exact: "the  dot\nproduct", prefix: "", suffix: "", start: 0 };
		const at = locateQuote("so the dot product equals", quote);
		assert.deepEqual(at, { start: 3, end: 18 });
	});

	it("returns null when the text is gone (an orphan)", () => {
		assert.equal(locateQuote(text, { exact: "dog", prefix: "", suffix: "", start: 0 }), null);
		assert.equal(locateQuote(text, { exact: "", prefix: "", suffix: "", start: 0 }), null);
	});

	it("quoteFor keeps up to 32 characters of context", () => {
		const long = `${"a".repeat(50)}X${"b".repeat(50)}`;
		const q = quoteFor(long, 50, 51);
		assert.equal(q.prefix.length, 32);
		assert.equal(q.suffix.length, 32);
		assert.equal(q.exact, "X");
	});
});

describe("ordering + export", () => {
	it("orders by transcript position then offset; unknown anchors last", () => {
		const list = [
			h({ id: "late", anchor: teacherTextAnchor("a2-t0") }),
			h({ id: "gone", anchor: teacherTextAnchor("zz-t0") }),
			h({ id: "b", quote: { exact: "x", prefix: "", suffix: "", start: 9 } }),
			h({ id: "a", quote: { exact: "x", prefix: "", suffix: "", start: 2 } }),
			h({ id: "first", anchor: userMessageAnchor("u1") }),
		];
		assert.deepEqual(orderHighlights(record, list).map((x) => x.id), ["first", "a", "b", "late", "gone"]);
	});

	it("exports quotes as blockquotes with the color and note, and no ids", () => {
		const md = highlightsMarkdown(record, [
			h({ id: "h2", anchor: teacherTextAnchor("a2-t0"), quote: { exact: "Next one.", prefix: "", suffix: "", start: 0 }, color: "pink" }),
			h({ quote: { exact: "line one\nline two $\\cos\\theta$", prefix: "", suffix: "", start: 0 }, comment: " remember this " }),
		]);
		assert.equal(
			md,
			"## Highlights\n\n> line one\n> line two $\\cos\\theta$\n\n**Yellow:** remember this\n\n> Next one.\n\n*Pink*",
		);
		assert.ok(!md.includes("a1-t0") && !md.includes("h1"), "no anchors or ids");
	});

	it("no highlights → no section", () => {
		assert.equal(highlightsMarkdown(record, []), "");
	});
});
