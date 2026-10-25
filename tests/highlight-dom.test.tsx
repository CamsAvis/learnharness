/**
 * Lesson highlights (fork feature) — the DOM text map, selection → quote,
 * and quote → paintable pieces. Real renderer output (MessageResponse,
 * AnsweredCard) is server-rendered and loaded into linkedom; the walker is
 * tag/attribute based, so linkedom's missing CSS OM doesn't matter.
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageResponse } from "../components/ai-elements/message.tsx";
import { AnsweredCard } from "../components/answered-card.tsx";
import {
	buildTextMap,
	positionOf,
	rangeSpecs,
	selectionQuote,
	type RangeLike,
} from "../components/highlight-dom.ts";
import type { QuestionAnswerData } from "../src/core/question-core.ts";
import { locateQuote } from "../src/core/highlights.ts";

const md = [
	"When both vectors have **length 1**, the dot product equals $\\cos\\theta$ — see [the docs](https://example.com).",
	"",
	"- first item",
	"- second *item*",
	"",
	"```python",
	"x = 1",
	"y = 2",
	"```",
	"",
	"| a | b |",
	"|---|---|",
	"| 1 | 2 |",
	"",
	"line one",
	"line two",
].join("\n");

function load(html: string) {
	const { document } = parseHTML(`<html><body>${html}</body></html>`);
	return document;
}

function teacherDoc(markdown = md) {
	const html = renderToStaticMarkup(
		<div data-hl-anchor="t:a1-t0">
			<MessageResponse mode="static">{markdown}</MessageResponse>
		</div>,
	);
	return load(html);
}

/** The text node whose data contains `needle`, plus the offset of it. */
function textAt(root: Node, needle: string): { node: Text; offset: number } {
	const walk = (n: Node): { node: Text; offset: number } | null => {
		if (n.nodeType === 3 && (n as Text).data.includes(needle)) return { node: n as Text, offset: (n as Text).data.indexOf(needle) };
		for (const c of Array.from(n.childNodes)) {
			const hit = walk(c);
			if (hit) return hit;
		}
		return null;
	};
	const hit = walk(root);
	assert.ok(hit, `text "${needle}" not found`);
	return hit;
}

describe("buildTextMap", () => {
	it("one string per anchor: blocks become breaks, math one token, chrome skipped", () => {
		const doc = teacherDoc();
		const map = buildTextMap(doc.querySelector("[data-hl-anchor]")!);
		assert.equal(
			map.text,
			"When both vectors have length 1, the dot product equals $\\cos\\theta$ — see the docs.\n" +
				"first item\nsecond item\nx = 1\ny = 2\na\nb\n1\n2\nline one\nline two",
		);
		assert.ok(!map.text.includes("python"), "the code block's language header is chrome");
		assert.ok(map.text.includes("the docs"), "Streamdown's link buttons are text, not chrome");
	});

	it("preserves the learner's own line breaks (pre-wrap)", () => {
		const doc = load(`<div class="whitespace-pre-wrap" data-hl-anchor="u:u1">first  line\n  second line</div>`);
		assert.equal(buildTextMap(doc.querySelector("[data-hl-anchor]")!).text, "first  line\n  second line");
	});

	it("literal dollars are written \\$ so they never read as math", () => {
		const doc = load(`<div data-hl-anchor="t:x"><p>It costs $5, then <code>echo $HOME</code>.</p></div>`);
		const map = buildTextMap(doc.querySelector("[data-hl-anchor]")!);
		assert.equal(map.text, "It costs \\$5, then echo \\$HOME.");
		const start = map.text.indexOf("\\$5");
		const specs = rangeSpecs(map, start, start + 3);
		assert.equal(specs.length, 1);
		assert.equal(specs[0]!.startOffset, "It costs ".length, "the escape maps onto the real $");
		assert.equal(specs[0]!.endOffset, "It costs $5".length);
	});

	it("display math is its own block token", () => {
		const doc = load(
			`<div data-hl-anchor="t:x"><p>Before</p><span data-testid="md-math" class="block"><span class="katex-display"><span class="katex"><span class="katex-mathml"><annotation encoding="application/x-tex">a+b</annotation></span><span class="katex-html">a+b</span></span></span></span><p>After</p></div>`,
		);
		assert.equal(buildTextMap(doc.querySelector("[data-hl-anchor]")!).text, "Before\n$$a+b$$\nAfter");
	});

	it("an answered card maps only its always-visible text", () => {
		const answer: QuestionAnswerData = {
			kind: "quiz",
			tool: "quiz",
			questionText: "What is $u \\cdot v$ for unit vectors?",
			options: [
				{ index: 1, label: "The cosine of the angle" },
				{ index: 2, label: "Always one" },
			],
			dontKnow: false,
			answers: [{ index: 1, label: "The cosine of the angle" }],
			correct: true,
			correctIndices: [1],
			confidence: 70,
			thinking: "my private reasoning",
			explanation: "Because |u||v| = 1.",
			answeredAt: "2026-10-25T00:00:00.000Z",
		} as QuestionAnswerData;
		const doc = load(renderToStaticMarkup(<AnsweredCard answer={answer} anchor="q:a1:c1" />));
		const text = buildTextMap(doc.querySelector("[data-hl-anchor]")!).text;
		assert.equal(text, "What is $u \\cdot v$ for unit vectors?\nThe cosine of the angle\nAlways one");
		for (const chrome of ["Check", "correct", "70%", "my private reasoning", "Why", "Because"]) {
			assert.ok(!text.includes(chrome), `"${chrome}" is excluded`);
		}
	});
});

describe("selection → quote → paint", () => {
	const allowAll = { has: () => true };

	it("maps a selection to a quote with context; a boundary inside a formula snaps outward", () => {
		const doc = teacherDoc();
		const root = doc.body;
		const start = textAt(root, "length 1");
		const insideMath = textAt(doc.querySelector(".katex-html")!, "θ");
		const range: RangeLike = {
			startContainer: start.node,
			startOffset: start.offset,
			endContainer: insideMath.node,
			endOffset: 0, // mid-formula
		};
		const r = selectionQuote(range, root, allowAll);
		assert.ok(r.ok, JSON.stringify(r));
		assert.equal(r.anchor, "t:a1-t0");
		assert.equal(r.quote.exact, "length 1, the dot product equals $\\cos\\theta$");
		assert.equal(r.quote.prefix, "When both vectors have ");
		assert.ok(r.quote.suffix.startsWith(" — see the docs."));
	});

	it("the stored quote finds itself again, and paints as per-node pieces", () => {
		const doc = teacherDoc();
		const anchor = doc.querySelector("[data-hl-anchor]")!;
		const map = buildTextMap(anchor);
		const exact = "length 1, the dot product equals $\\cos\\theta$";
		const start = map.text.indexOf(exact);
		const at = locateQuote(map.text, { exact, prefix: "When both vectors have ", suffix: " — see", start: 0 });
		assert.deepEqual(at, { start, end: start + exact.length });
		const specs = rangeSpecs(map, at!.start, at!.end);
		// "length 1" (inside <strong>), ", the dot product equals " (text node), the formula element.
		assert.equal(specs.length, 3);
		const math = specs[2]!;
		assert.equal(math.startContainer, math.endContainer, "formula piece spans its element");
		assert.equal((math.startContainer.childNodes[math.startOffset] as Element).className, "katex");
		assert.equal(math.endOffset, math.startOffset + 1);
	});

	it("pieces never cross a block break", () => {
		const doc = teacherDoc();
		const map = buildTextMap(doc.querySelector("[data-hl-anchor]")!);
		const from = map.text.indexOf("first item");
		const to = map.text.indexOf("second item") + "second item".length;
		const specs = rangeSpecs(map, from, to);
		assert.equal(specs.length, 3, "'first item' | 'second ' | 'item' (in <em>)");
	});

	it("refuses selections spanning two messages, untouched text, and unsaved anchors", () => {
		const html =
			renderToStaticMarkup(<div data-hl-anchor="t:a-t0"><MessageResponse mode="static">{"Alpha text"}</MessageResponse></div>) +
			`<p id="loose">Loose text</p>` +
			renderToStaticMarkup(<div data-hl-anchor="t:b-t0"><MessageResponse mode="static">{"Beta text"}</MessageResponse></div>);
		const doc = load(html);
		const a = textAt(doc.body, "Alpha");
		const b = textAt(doc.body, "Beta");
		const loose = textAt(doc.body, "Loose");
		const span: RangeLike = { startContainer: a.node, startOffset: 0, endContainer: b.node, endOffset: 4 };
		assert.deepEqual(selectionQuote(span, doc.body, allowAll), { ok: false, reason: "Select text within one message" });
		const outside: RangeLike = { startContainer: loose.node, startOffset: 0, endContainer: loose.node, endOffset: 5 };
		assert.deepEqual(selectionQuote(outside, doc.body, allowAll), { ok: false, reason: "This part can't be highlighted" });
		const inA: RangeLike = { startContainer: a.node, startOffset: 0, endContainer: a.node, endOffset: 5 };
		assert.deepEqual(selectionQuote(inA, doc.body, new Set<string>()), { ok: false, reason: "Wait for the reply to finish" });
		const ok = selectionQuote(inA, doc.body, new Set(["t:a-t0"]));
		assert.ok(ok.ok && ok.quote.exact === "Alpha");
	});

	it("a boundary in an ancestor container (a drag from the margin) lands before or after the anchor", () => {
		const doc = load(`<div id="col"><p>x</p><div data-hl-anchor="u:u1">hello world</div><p>y</p></div>`);
		const col = doc.getElementById("col")!;
		const map = buildTextMap(doc.querySelector("[data-hl-anchor]")!);
		assert.equal(positionOf(map, col, 0, "start"), 0, "(col, 0) is before the anchor");
		assert.equal(positionOf(map, col, 1, "start"), 0, "(col, 1) is right before it");
		assert.equal(positionOf(map, col, 2, "end"), 11, "(col, 2) is after it");
		const world = textAt(doc.body, "world");
		const r = selectionQuote({ startContainer: col, startOffset: 0, endContainer: world.node, endOffset: world.offset + 5 }, doc.body, allowAll);
		assert.ok(r.ok && r.quote.exact === "hello world", JSON.stringify(r));
	});

	it("boundaries outside the anchor clamp to its ends", () => {
		const doc = load(`<p id="before">x</p><div data-hl-anchor="u:u1">hello</div><p id="after">y</p>`);
		const map = buildTextMap(doc.querySelector("[data-hl-anchor]")!);
		assert.equal(positionOf(map, doc.getElementById("before")!.firstChild!, 0, "start"), 0);
		assert.equal(positionOf(map, doc.getElementById("after")!.firstChild!, 1, "end"), 5);
	});
});
