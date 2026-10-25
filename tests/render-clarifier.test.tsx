/**
 * Render checks for the question side chat: the toggle in the question
 * header, the panel's states, and the answered card's tucked record.
 * (tsx uses the classic JSX transform, hence the React global shim.)
 */
import React from "react";
(globalThis as Record<string, unknown>).React = React;

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AnsweredCard } from "../components/answered-card.tsx";
import { ClarifierPanel, type ClarifierState } from "../components/question-clarifier.tsx";
import { QuestionDock } from "../components/question-dock.tsx";
import { clarifierPlacement } from "../components/chat.tsx";
import type { ClarifyExchange, QuestionAnswerData } from "../src/core/index.ts";

const ex = (asked: string, reply: string): ClarifyExchange => ({ asked, reply, at: `2026-10-25T00:00:00.00${asked.length % 10}Z` });

const state = (over: Partial<ClarifierState> = {}): ClarifierState => ({
	thread: [],
	pendingAsk: null,
	error: null,
	open: true,
	setOpen: () => {},
	takeFocus: () => false,
	draft: "",
	setDraft: () => {},
	ask: async () => {},
	...over,
});

const quizInput = {
	question: "Which collider shape wraps the forearm best?",
	options: [
		{ label: "A capsule", value: "capsule" },
		{ label: "A box", value: "box" },
	],
	explanation: "Capsules hug long round limbs.",
	correctAnswer: "capsule",
};

describe("question side chat rendering", () => {
	it("the question header offers the side chat, with the thread count", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="call_1"
				input={quizInput as never}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				clarify={{ count: 2, open: false, onToggle: () => {} }}
			/>,
		);
		assert.match(html, /data-testid="clarify-toggle"/);
		assert.match(html, /Ask about this/);
		assert.match(html, /\(2\)/);
		const without = renderToStaticMarkup(
			<QuestionDock toolName="quiz" toolCallId="call_1" input={quizInput as never} expanded onExpand={() => {}} onSubmit={() => {}} />,
		);
		assert.doesNotMatch(without, /clarify-toggle/);
	});

	it("renders the inline panel inside the question card", () => {
		const html = renderToStaticMarkup(
			<QuestionDock
				toolName="quiz"
				toolCallId="call_1"
				input={quizInput as never}
				expanded
				onExpand={() => {}}
				onSubmit={() => {}}
				clarify={{ count: 0, open: true, onToggle: () => {} }}
				clarifyInline={<ClarifierPanel state={state()} variant="inline" />}
			/>,
		);
		assert.match(html, /data-testid="clarifier-panel"[^>]*data-variant="inline"/);
	});

	it("an empty panel explains itself; a thread shows both sides; a pending ask shows progress", () => {
		const empty = renderToStaticMarkup(<ClarifierPanel state={state()} variant="side" />);
		assert.match(empty, /won&#x27;t give you the answer/);
		assert.match(empty, /data-clarifier-panel=""/);

		const thread = renderToStaticMarkup(
			<ClarifierPanel state={state({ thread: [ex("what is a capsule?", "A pill shape.")], pendingAsk: "and a box?" })} variant="side" />,
		);
		assert.match(thread, /what is a capsule\?/);
		assert.match(thread, /A pill shape\./);
		assert.match(thread, /and a box\?/);
		assert.match(thread, /Thinking…/);
		assert.doesNotMatch(thread, /won&#x27;t give you the answer/);

		const failed = renderToStaticMarkup(<ClarifierPanel state={state({ error: "The side-chat model failed" })} variant="side" />);
		assert.match(failed, /data-testid="clarifier-error"/);
	});

	it("the answered card tucks the side chat behind a count", () => {
		const answer: QuestionAnswerData = {
			kind: "quiz",
			questionText: quizInput.question,
			dontKnow: false,
			answers: [{ index: 1, label: "A capsule", value: "capsule" }],
			options: [
				{ index: 1, label: "A capsule" },
				{ index: 2, label: "A box" },
			],
			correct: true,
			correctIndices: [1],
			clarifications: [ex("what is a capsule?", "A pill shape."), ex("and a box?", "A cube.")],
			answeredAt: "2026-10-25T00:00:00.000Z",
		};
		const html = renderToStaticMarkup(<AnsweredCard answer={answer} />);
		assert.match(html, /data-testid="answered-clarifications"/);
		assert.match(html, /Asked 2 questions first/);
		// Collapsed by default: the exchanges themselves stay tucked.
		assert.doesNotMatch(html, /A pill shape/);

		const skipped = renderToStaticMarkup(
			<AnsweredCard answer={{ ...answer, dismissed: true, clarifications: [ex("what?", "This.")] }} />,
		);
		assert.match(skipped, /skipped/);
		assert.match(skipped, /Asked 1 question first/);

		const plain = renderToStaticMarkup(<AnsweredCard answer={{ ...answer, clarifications: undefined }} />);
		assert.doesNotMatch(plain, /answered-clarifications/);
	});
});

describe("side chat placement", () => {
	it("splits beside the question on wide bands, opens inline on narrow ones", () => {
		assert.equal(clarifierPlacement(true, false, 1600), "split");
		assert.equal(clarifierPlacement(true, false, 1100), "split");
		assert.equal(clarifierPlacement(true, false, 1099), "inline");
		assert.equal(clarifierPlacement(false, false, 1600), null);
	});

	it("waits for a teach check's reveal before splitting", () => {
		assert.equal(clarifierPlacement(true, true, 1600), null);
		// Inline lives inside the (still folded) card, so it needs no gate.
		assert.equal(clarifierPlacement(true, true, 800), "inline");
	});
});
