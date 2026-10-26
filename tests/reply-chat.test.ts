/**
 * Side chats about the tutor's replies: finding the passage, the helper's
 * prompt (the open question's answer key never reaches it), the exchanges
 * that ride the next answer to the tutor, and the server path.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Usage } from "@earendil-works/pi-ai";
import {
	CLARIFIER_SYSTEM_PROMPT,
	REPLY_HELPER_SYSTEM_PROMPT,
	attachReplyChats,
	replyHelperSystemPrompt,
	buildReplyChatPrompt,
	clarifyLessonContext,
	clarifyQuestionView,
	clarifyRequestProblem,
	replyChatsSince,
	replyPassageOf,
} from "../src/core/clarify.ts";
import type { ChatRecord, ClarifyExchange, TurnUsage } from "../src/core/contracts.ts";
import { inputAppends } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { compactAnswerForModel, type QuestionAnswerData } from "../src/core/question-core.ts";
import { clarifyQuestion, clarifyThread, parseClarifyTarget, type ClarifyDeps } from "../src/server/clarify.ts";
import type { PiEngine } from "../src/agent/models.ts";

const SECRET = "ZZSECRETZZ";

/** An assistant message: text blocks and an optional question call. */
function assistant(id: string, texts: string[], call?: { id: string; name: string; args: unknown }): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			...texts.map((text) => ({ type: "text", text })),
			...(call ? [{ type: "toolCall", id: call.id, name: call.name, arguments: call.args }] : []),
		],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: call ? "toolUse" : "stop",
		timestamp: 1_000,
	} as never;
}

function answered(callId: string, at: number): LhMessage {
	return {
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName: "quiz",
		content: [{ type: "text", text: "{}" }],
		details: {},
		isError: false,
		timestamp: at,
	} as never;
}

const prediction = {
	question: "Where does the 135° point land?",
	options: [
		{ label: "Upper left", value: `${SECRET}-ul` },
		{ label: "Lower right", value: `${SECRET}-lr` },
	],
	explanation: `${SECRET} because cos is negative`,
	correctAnswer: `${SECRET}-ul`,
};

/** A lesson: an answered check, then the grading text plus the next
 *  question (still open), in one assistant message. */
const lesson = (): LhMessage[] => [
	{ id: "u1", role: "user", content: "teach me circles", timestamp: 500 } as LhMessage,
	assistant("a1", ["First check."], { id: "call_old", name: "quiz", args: { ...prediction, question: "Earlier?" } }),
	answered("call_old", 2_000),
	assistant("a2", ["## Grading\nYou used 4 where the radius is 8.", "Next up."], { id: "call_open", name: "quiz", args: prediction }),
];

const ex = (asked: string, at: string, reply = `about ${asked}`): ClarifyExchange => ({ asked, reply, at });

describe("finding the reply a side chat is about", () => {
	it("reads the nth text block of an assistant message", () => {
		assert.deepEqual(replyPassageOf(lesson(), "a2-t0"), { messageId: "a2", text: "## Grading\nYou used 4 where the radius is 8." });
		assert.equal(replyPassageOf(lesson(), "a2-t1")?.text, "Next up.");
	});

	it("refuses ids that don't point at tutor text", () => {
		for (const id of ["a2-t2", "u1-t0", "nope-t0", "a2", "a2-tx", ""]) assert.equal(replyPassageOf(lesson(), id), null, id);
	});

	it("parses request targets", () => {
		assert.deepEqual(parseClarifyTarget({ replyId: "a2-t0" }), { kind: "reply", id: "a2-t0" });
		assert.deepEqual(parseClarifyTarget({ toolCallId: "call_open" }), { kind: "question", id: "call_open" });
		assert.ok("error" in parseClarifyTarget({ replyId: "not a part id" }));
		assert.ok("error" in parseClarifyTarget({}));
	});
});

describe("the reply helper's prompt", () => {
	it("carries the reply and the open question's wording, never its answer key", () => {
		const prompt = buildReplyChatPrompt({
			lesson: "LESSON",
			reply: "## Grading\nYou used 4 where the radius is 8.",
			openQuestion: clarifyQuestionView("quiz", prediction),
			thread: [ex("why 8?", "2026-10-26T00:00:01.000Z", "It's the radius.")],
			asked: "can you draw it?",
		});
		for (const part of ["LESSON", "You used 4 where the radius is 8.", prediction.question, "- Upper left", "Learner: why 8?", "You: It's the radius.", "can you draw it?"]) {
			assert.ok(prompt.includes(part), part);
		}
		assert.ok(!prompt.includes(SECRET));
		assert.match(prompt, /never answer it/);
	});

	it("allows diagrams and forbids answering open questions", () => {
		assert.match(REPLY_HELPER_SYSTEM_PROMPT, /```mermaid/);
		assert.match(REPLY_HELPER_SYSTEM_PROMPT, /Never answer it/);
	});

	it("tells the helper the tutor reads the chat, except in practice", () => {
		assert.match(REPLY_HELPER_SYSTEM_PROMPT, /The tutor sees this side chat/);
		const practice = replyHelperSystemPrompt("practice");
		assert.doesNotMatch(practice, /tutor sees/);
		assert.match(practice, /```mermaid/);
	});

	it("words the thread limit for replies", () => {
		const full = Array.from({ length: 12 }, (_, i) => ex(`q${i}`, "2026-10-26T00:00:00.000Z"));
		assert.match(clarifyRequestProblem("more?", full, "reply")!, /This reply already has 12/);
	});
});

describe("reply chats ride the next answer", () => {
	const record = () => ({
		messages: lesson(),
		replyChats: {
			"a2-t0": [ex("why 8?", new Date(3_000).toISOString()), ex("draw it", new Date(4_000).toISOString())],
			// Asked before the learner's last answer (at 2,000): already delivered.
			"a1-t0": [ex("stale", new Date(1_500).toISOString())],
		},
	});

	it("collects the exchanges since the learner's last answer, oldest first", () => {
		assert.deepEqual(replyChatsSince(record()).map((e) => e.asked), ["why 8?", "draw it"]);
		assert.deepEqual(replyChatsSince({ messages: lesson() }), []);
	});

	it("keeps them for the next answer across a typed message or a rejected question call", () => {
		const r = record();
		r.messages = [
			...r.messages,
			{ id: "u2", role: "user", content: "hm, ok", timestamp: 4_500 } as LhMessage,
			{ ...answered("call_bad", 4_600), toolName: "quiz", isError: true } as LhMessage,
		];
		assert.deepEqual(replyChatsSince(r).map((e) => e.asked), ["why 8?", "draw it"]);
	});

	it("attaches them to the answer, replacing any the client sent, and shows them to the tutor", () => {
		const answer: QuestionAnswerData = {
			kind: "quiz",
			questionText: prediction.question,
			dontKnow: false,
			answers: [{ index: 1, label: "Upper left", value: "x" }],
			replyChats: [ex("forged", new Date(9_000).toISOString())],
			answeredAt: "2026-10-26T00:00:00.000Z",
		};
		const [result] = inputAppends(record(), { type: "answer", toolCallId: "call_open", answer });
		const details = (result as { details: QuestionAnswerData }).details;
		assert.deepEqual(details.replyChats?.map((e) => e.asked), ["why 8?", "draw it"]);
		const modelView = JSON.parse((result as { content: { text: string }[] }).content[0]!.text);
		assert.deepEqual(modelView.askedAboutYourReply, [
			{ asked: "why 8?", reply: "about why 8?" },
			{ asked: "draw it", reply: "about draw it" },
		]);
		assert.equal("replyChats" in attachReplyChats(answer, []), false);
		assert.equal("askedAboutYourReply" in compactAnswerForModel({ ...answer, replyChats: [] }), false);
	});
});

const SOLUTION = "ZZSOLVEDZZ";

/** A tool result: clean, or an error (a refused call). */
function result(callId: string, toolName: string, at: number, isError = false): LhMessage {
	return {
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: isError ? "refused" : "ok" }],
		details: {},
		isError,
		timestamp: at,
	} as never;
}

/** A practice session: a concluded problem, a refused pose, and the
 *  problem in progress. */
const practiceLesson = (): LhMessage[] => [
	{ id: "u1", role: "user", content: "practice vectors", timestamp: 100 } as LhMessage,
	assistant("p1", ["First problem."], {
		id: "pose_1",
		name: "problem",
		args: { statement: "Find a·b for a = (1, 0), b = (0, 1).", mode: "recall", target: ["dot-zero"], modelSolution: `${SOLUTION}-old` },
	}),
	result("pose_1", "problem", 200),
	assistant("p2", ["Right: perpendicular vectors give 0."], { id: "conc_1", name: "conclude", args: { outcome: "correct" } }),
	result("conc_1", "conclude", 300),
	assistant("p3", [], { id: "pose_bad", name: "problem", args: { statement: "x", mode: "recall", modelSolution: `${SOLUTION}-refused` } }),
	result("pose_bad", "problem", 400, true),
	assistant("p4", ["Next one."], {
		id: "pose_2",
		name: "problem",
		args: { statement: "Find |v| for v = (3, 4).", mode: "recall", target: ["norm"], modelSolution: `${SOLUTION}-active` },
	}),
	result("pose_2", "problem", 500),
];

describe("reply chats in practice sessions", () => {
	it("the helper reads a problem's solution only once a conclude revealed it", () => {
		const context = clarifyLessonContext(practiceLesson());
		assert.ok(context.includes(`${SOLUTION}-old`), "a concluded problem's solution was shown to the learner");
		assert.ok(!context.includes(`${SOLUTION}-active`), "the problem in progress keeps its solution hidden");
		assert.ok(!context.includes(`${SOLUTION}-refused`), "a refused pose's solution stays hidden");
		assert.ok(context.includes("Find |v| for v = (3, 4)."));
		assert.ok(!context.includes('"norm"'), "and its target concept");
	});

	it("a refused pose's error text never reaches the helper (it can echo the arguments)", () => {
		const messages = practiceLesson();
		messages[6] = { ...(messages[6] as object), content: [{ type: "text", text: `Invalid tool input: ${SOLUTION}-echo` }] } as LhMessage;
		const context = clarifyLessonContext(messages);
		assert.ok(!context.includes(`${SOLUTION}-echo`));
		assert.ok(context.includes("(this problem call was rejected; the tutor retried it)"));
	});

	it("guards the problem in progress instead of an open question", () => {
		const practice = replyHelperSystemPrompt("practice");
		assert.match(practice, /Never solve it, hint at it, or do its reasoning/);
		assert.match(practice, /"Your thinking" field or ask the tutor/);
		assert.doesNotMatch(practice, /its own "Ask about this" button/);
		const prompt = buildReplyChatPrompt({ lesson: "L", reply: "R", openQuestion: null, openProblem: "Find |v|.", thread: [], asked: "why?" });
		assert.ok(prompt.includes("## The practice problem the learner is working on (never solve it)\n\nFind |v|."));
	});
});

describe("compaction summaries and open questions", () => {
	const marker = (id: string, content: string, at: number): LhMessage =>
		({ id, role: "custom", customType: "compaction", content, display: true, details: {}, timestamp: at }) as never;

	it("hides a summary written while the open question was waiting (it may describe the answer)", () => {
		const before = marker("m_before", "SUMMARY-BEFORE", 1_500);
		const after = marker("m_after", `SUMMARY-AFTER ${SECRET}`, 2_500);
		const messages = [...lesson()];
		messages.splice(3, 0, before); // before the open question's message
		messages.push(after); // in the pause after it was posed
		const context = clarifyLessonContext(messages);
		assert.ok(context.includes("SUMMARY-BEFORE"));
		assert.ok(!context.includes(SECRET));
		assert.ok(context.includes("the summary is hidden while the question or problem it may describe is still open"));
	});

	it("hides one written while the practice problem was in progress, and keeps it once nothing is open", () => {
		const during = [...practiceLesson(), marker("m_p", `SUMMARY ${SOLUTION}-active`, 600)];
		assert.ok(!clarifyLessonContext(during).includes(`${SOLUTION}-active`));
		const concluded = [
			...during,
			assistant("p5", ["5, by Pythagoras."], { id: "conc_2", name: "conclude", args: { outcome: "correct" } }),
			result("conc_2", "conclude", 700),
		];
		assert.ok(clarifyLessonContext(concluded).includes("SUMMARY"), "nothing open: the summary is back");
	});
});

describe("the server path for reply chats", () => {
	function setup(kind?: "practice", messages: LhMessage[] = lesson()) {
		let current: ChatRecord = {
			id: "chat_1",
			title: "t",
			createdAt: "2026-10-26T00:00:00.000Z",
			updatedAt: "2026-10-26T00:00:00.000Z",
			messages,
			...(kind ? { kind } : {}),
		} as ChatRecord;
		const turns: TurnUsage[] = [];
		const calls: { prompt: string; systemPrompt: string }[] = [];
		const store = {
			getChat: (id: string) => (id === current.id ? structuredClone(current) : null),
			appendTurnUsage: (_id: string, entry: TurnUsage) => void turns.push(entry),
			appendReplyChat: (_id: string, partId: string, e: ClarifyExchange) => {
				const thread = [...(current.replyChats?.[partId] ?? []), e];
				current = { ...current, replyChats: { ...current.replyChats, [partId]: thread } };
				return thread;
			},
			appendClarification: () => {
				throw new Error("reply chats must not write question threads");
			},
		} as unknown as ChatStore;
		const usage: Usage = { input: 50, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 55, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
		const deps: ClarifyDeps = {
			chatStore: store,
			engine: () => ({ engine: { model: { provider: "test", id: "flash" } } as unknown as PiEngine }),
			reply: async ({ prompt, systemPrompt, onUsage }) => {
				calls.push({ prompt, systemPrompt });
				onUsage(usage);
				return "```mermaid\ngraph LR\n  C --> P\n```";
			},
		};
		return { deps, calls, turns, get record() { return current; } };
	}

	it("answers with the reply helper, saves under replyChats, and keys usage to the reply's message", async () => {
		const t = setup();
		const res = await clarifyQuestion("chat_1", { replyId: "a2-t0", text: "can you draw it?" }, undefined, t.deps);
		assert.ok(res.ok);
		assert.equal(t.calls[0]!.systemPrompt, REPLY_HELPER_SYSTEM_PROMPT);
		assert.notEqual(t.calls[0]!.systemPrompt, CLARIFIER_SYSTEM_PROMPT);
		assert.ok(t.calls[0]!.prompt.includes("You used 4 where the radius is 8."));
		assert.ok(!t.calls[0]!.prompt.includes(SECRET), "the open question's answer key stays out");
		assert.deepEqual(t.record.replyChats?.["a2-t0"]?.map((e) => e.asked), ["can you draw it?"]);
		assert.match(t.record.replyChats!["a2-t0"]![0]!.reply, /```mermaid/);
		assert.equal(t.turns[0]!.messageId, "a2");
		assert.deepEqual(clarifyThread("chat_1", { kind: "reply", id: "a2-t0" }, { chatStore: t.deps.chatStore })?.length, 1);
	});

	it("in practice, sends the problem in progress by its statement, never its solution", async () => {
		const t = setup("practice", practiceLesson());
		const res = await clarifyQuestion("chat_1", { replyId: "p2-t0", text: "why was that right?" }, undefined, t.deps);
		assert.ok(res.ok);
		assert.equal(t.calls[0]!.systemPrompt, replyHelperSystemPrompt("practice"));
		assert.ok(
			t.calls[0]!.prompt.includes("## The practice problem the learner is working on (never solve it)\n\nFind |v| for v = (3, 4)."),
		);
		assert.ok(!t.calls[0]!.prompt.includes(`${SOLUTION}-active`));
	});

	it("refuses replies that aren't in the lesson", async () => {
		const t = setup();
		const missing = await clarifyQuestion("chat_1", { replyId: "a9-t0", text: "x" }, undefined, t.deps);
		assert.equal(missing.ok ? 200 : missing.status, 404);
		const malformed = await clarifyQuestion("chat_1", { replyId: "nope", text: "x" }, undefined, t.deps);
		assert.equal(malformed.ok ? 200 : malformed.status, 400);
		assert.equal(t.calls.length, 0);
	});
});
