/**
 * Lesson highlights (fork feature) — the panel and chip render: the empty
 * state, items in order with their notes, the orphan state, the color
 * filter, and the quote's markdown escaping (math stays math).
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PanelBody, quoteMarkdown } from "../components/highlights-panel.tsx";
import { HighlightsChip, plainQuote } from "../components/lesson-highlights.tsx";
import { LessonHighlightsStore, type LessonHighlightsState } from "../components/lesson-highlights-store.ts";
import type { LessonHighlight } from "../src/core/contracts/chat.ts";

const h = (over: Partial<LessonHighlight>): LessonHighlight => ({
	id: "hl_a",
	anchor: "t:a1-t0",
	quote: { exact: "the dot product", prefix: "", suffix: "", start: 0 },
	color: "yellow",
	comment: "",
	createdAt: "2026-10-25T00:00:00.000Z",
	updatedAt: "2026-10-25T00:00:00.000Z",
	...over,
});

function render(list: LessonHighlight[], patch: Partial<LessonHighlightsState> = {}) {
	const store = new LessonHighlightsStore("chat_1", list);
	const state = { ...store.getSnapshot(), open: true, ...patch };
	return renderToStaticMarkup(<PanelBody state={state} ordered={list} store={store} nav={null} />);
}

describe("HighlightsPanel", () => {
	it("empty state explains how to highlight", () => {
		const html = render([]);
		assert.ok(html.includes('data-testid="highlights-empty"'));
		assert.ok(html.includes("right-click, and choose Highlight"));
	});

	it("lists items with their notes; an orphan says so and can't jump", () => {
		const html = render(
			[h({ id: "hl_a", comment: "key fact" }), h({ id: "hl_b", quote: { exact: "gone text", prefix: "", suffix: "", start: 0 } })],
			{ status: new Map([["hl_a", "found"], ["hl_b", "orphan"]]) },
		);
		assert.equal(html.match(/data-testid="highlight-item"/g)?.length, 2);
		assert.ok(html.includes("key fact"));
		assert.ok(html.includes("Couldn&#x27;t find this text in the lesson anymore"));
		assert.ok(/data-highlight-id="hl_b" data-status="orphan"/.test(html));
		assert.ok(/role="button" tabindex="-1" aria-disabled="true" data-testid="highlight-quote"/.test(html), "orphan quote is disabled");
		assert.ok(!/<button[^>]*data-testid="highlight-quote"/.test(html), "the quote is not a <button> (links inside render as buttons)");
	});

	it("the color filter narrows the list", () => {
		const html = render([h({ id: "hl_a", color: "yellow" }), h({ id: "hl_b", color: "pink" })], { filter: "pink" });
		assert.equal(html.match(/data-testid="highlight-item"/g)?.length, 1);
		assert.ok(html.includes('data-highlight-id="hl_b"'));
	});

	it("the panel is marked so the question dock ignores its keys", () => {
		assert.ok(render([]).includes("data-hl-panel"));
	});
});

describe("quote display helpers", () => {
	it("escapes markdown punctuation but keeps math tokens", () => {
		assert.equal(quoteMarkdown("a*b_c [x] $\\cos\\theta$ # no"), "a\\*b\\_c \\[x\\] $\\cos\\theta$ \\# no");
		assert.equal(quoteMarkdown("1. not a list\n- nor this"), "1\\. not a list\n\\- nor this");
	});

	it("escaped literal dollars stay literal; only unescaped $...$ is math", () => {
		assert.equal(quoteMarkdown("costs \\$5 and \\$6"), "costs \\$5 and \\$6");
		assert.equal(quoteMarkdown("so $\\frac{a}{b}$ and \\$5"), "so $\\frac{a}{b}$ and \\$5");
		assert.equal(quoteMarkdown("a \\ b"), "a \\\\ b", "a lone backslash is literal");
	});

	it("copy text unescapes literal dollars", () => {
		assert.equal(plainQuote("costs \\$5, so $x^2$"), "costs $5, so $x^2$");
	});
});

describe("HighlightsChip", () => {
	it("shows the count", () => {
		const store = new LessonHighlightsStore("chat_1", [h({}), h({ id: "hl_b" })]);
		const html = renderToStaticMarkup(<HighlightsChip store={store} />);
		assert.ok(html.includes('data-testid="highlights-chip"'));
		assert.ok(html.includes(">2</span>"));
	});
});
