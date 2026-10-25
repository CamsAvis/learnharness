/**
 * The question side chat (clarifier): the answer key never reaches the
 * helper, the thread is saved per open question, and the answer carries
 * the record's copy to the teacher.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs";
import type { Usage } from "@earendil-works/pi-ai";
import { PATHS } from "../config.ts";
import {
	attachClarifications,
	buildClarifyPrompt,
	CLARIFY_MAX_CHARS,
	CLARIFY_MAX_EXCHANGES,
	clarifyLessonContext,
	clarifyQuestionView,
	clarifyRequestProblem,
} from "../src/core/clarify.ts";
import type { ChatRecord, ClarifyExchange, TurnUsage } from "../src/core/contracts.ts";
import { serializeForSummary } from "../src/core/compaction.ts";
import { dismissAppends, inputAppends } from "../src/core/input-events.ts";
import type { LhMessage } from "../src/core/native-messages.ts";
import type { ChatStore } from "../src/core/ports.ts";
import { compactAnswerForModel, dismissedAnswer, type QuestionAnswerData } from "../src/core/question-core.ts";
import { ROLE_SLOT } from "../src/core/settings.ts";
import { resolveRoleSpec } from "../src/core/settings-resolution.ts";
import { clarifyQuestion, type ClarifyDeps } from "../src/server/clarify.ts";
import { chatStore } from "../src/store/chats.ts";
import type { PiEngine } from "../src/agent/models.ts";

// ─── fixtures ────────────────────────────────────────────────────────────────

const SECRET = "ZZSECRETZZ";

function assistantWithCall(id: string, callId: string, name: string, args: unknown, text = "Here is a check."): LhMessage {
	return {
		id,
		role: "assistant",
		content: [
			{ type: "text", text },
			{ type: "toolCall", id: callId, name, arguments: args as never },
		],
		api: "openai-completions",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		stopReason: "toolUse",
		timestamp: 1,
	} as never;
}

function resultFor(callId: string, toolName: string, compact: unknown): LhMessage {
	return {
		id: `r_${callId}`,
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text: JSON.stringify(compact) }],
		details: compact as never,
		isError: false,
		timestamp: 1,
	} as never;
}

const user = (text: string): LhMessage => ({ id: `u_${text.length}`, role: "user", content: text, timestamp: 1 }) as LhMessage;

const quizArgs = {
	question: "Which collider shape wraps the forearm best?",
	details: "Think about the limb's silhouette.",
	options: [
		{ label: "A capsule", value: `${SECRET}-capsule` },
		{ label: "A box", value: `${SECRET}-box` },
	],
	explanation: `${SECRET} capsules hug long round limbs.`,
	correctAnswer: `${SECRET}-capsule`,
	nodeId: `${SECRET}-node`,
	type: "check",
};

const explainArgs = {
	question: "Explain why the limb hides when the capsule is hit.",
	correctAnswer: `${SECRET} because the bone scale goes to zero.`,
	nodeId: `${SECRET}-node`,
};

const askArgs = {
	question: "Which engine version are you on?",
	options: [
		{ label: "UE 5.5", description: "the newest" },
		{ label: "UE 5.3", description: "older" },
	],
	multiSelect: true,
};

/** A lesson with one answered quiz and one open quiz. */
function lesson(): LhMessage[] {
	return [
		user("Teach me VATS limb visibility"),
		assistantWithCall("a1", "call_old", "quiz", { ...quizArgs, question: "An earlier check?" }),
		resultFor("call_old", "quiz", { kind: "quiz", answers: [{ index: 1, label: "A capsule", value: "capsule" }], correct: true }),
		assistantWithCall("a2", "call_open", "quiz", quizArgs, "Capsules approximate limbs."),
	];
}

const usage = (input: number): Usage => ({
	input,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: input + 10,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const exchange = (asked: string, reply = `About ${asked}`): ClarifyExchange => ({ asked, reply, at: `2026-10-25T00:00:0${asked.length % 10}.000Z` });

// ─── the helper's view: no answer key ───────────────────────────────────────

describe("clarifyQuestionView", () => {
	it("keeps only the quiz's wording", () => {
		for (const tool of ["quiz", "probe"]) {
			const view = clarifyQuestionView(tool, quizArgs);
			assert.deepEqual(view, {
				tool,
				question: quizArgs.question,
				details: quizArgs.details,
				options: ["A capsule", "A box"],
			});
			assert.ok(!JSON.stringify(view).includes(SECRET));
		}
	});

	it("drops the explain commitment and lists no options", () => {
		for (const tool of ["explain", "recall"]) {
			const view = clarifyQuestionView(tool, explainArgs);
			assert.deepEqual(view, { tool, question: explainArgs.question });
		}
	});

	it("keeps ask options with their descriptions, and the multi-select flag", () => {
		const view = clarifyQuestionView("ask_user_question", askArgs);
		assert.deepEqual(view, {
			tool: "ask_user_question",
			question: askArgs.question,
			options: ["UE 5.5: the newest", "UE 5.3: older"],
			multiSelect: true,
		});
	});

	it("never passes quiz option descriptions (old records used them to hint)", () => {
		const hinted = { ...quizArgs, options: quizArgs.options.map((o) => ({ ...o, description: `${SECRET} hint` })) };
		assert.ok(!JSON.stringify(clarifyQuestionView("quiz", hinted)).includes(SECRET));
	});

	it("falls back to the raw fields when the record doesn't parse, still whitelisted", () => {
		const broken = { question: "Q?", options: "not-an-array", correctAnswer: SECRET, explanation: SECRET };
		const view = clarifyQuestionView("quiz", broken);
		assert.deepEqual(view, { tool: "quiz", question: "Q?" });
	});
});

describe("clarifyLessonContext", () => {
	it("strips every question call's answer key, open and past", () => {
		const text = clarifyLessonContext(lesson());
		assert.ok(!text.includes(SECRET), text);
		assert.ok(text.includes("Capsules approximate limbs."));
		assert.ok(text.includes(quizArgs.question));
		assert.ok(text.includes("An earlier check?"));
	});

	it("replaces a rejected question call's error, which quotes the intended answer", () => {
		const rejected = {
			...resultFor("call_bad", "quiz", {}),
			isError: true,
			content: [{ type: "text", text: `Invalid tool input for tool "quiz":\n- correctAnswer "${SECRET}" does not match any option value.` }],
		} as LhMessage;
		const messages = [...lesson().slice(0, 3), assistantWithCall("a_bad", "call_bad", "quiz", quizArgs), rejected, lesson()[3]!];
		const text = clarifyLessonContext(messages);
		assert.ok(!text.includes(SECRET), text);
		assert.ok(text.includes("rejected"));
	});

	it("matches a whole-transcript serialization when it fits", () => {
		const messages = [user("first"), assistantWithCall("a9", "call_plan", "plan_init", { nodes: [] }, "Plan ready."), user("second!")];
		assert.equal(clarifyLessonContext(messages), serializeForSummary(messages));
	});

	it("keeps the most recent part when the lesson is long", () => {
		const long = [user(`old ${"x".repeat(5_000)}`), user("line\nnewest message")];
		const text = clarifyLessonContext(long, 1_000);
		assert.ok(text.startsWith("[…earlier lesson omitted]"));
		assert.ok(text.endsWith("newest message"));
		assert.ok(text.length < 1_100);
	});
});

describe("buildClarifyPrompt", () => {
	it("carries the lesson, the question, the thread so far and the new message", () => {
		const prompt = buildClarifyPrompt({
			lesson: "LESSON-TEXT",
			question: clarifyQuestionView("quiz", quizArgs),
			thread: [exchange("what is a capsule?", "A pill shape.")],
			asked: "and a box?",
		});
		for (const part of ["LESSON-TEXT", quizArgs.question, quizArgs.details, "- A capsule", "- A box", "Learner: what is a capsule?", "You: A pill shape.", "and a box?"])
			assert.ok(prompt.includes(part), part);
		assert.ok(prompt.includes("pick one"));
		assert.ok(!prompt.includes(SECRET));
	});
});

describe("clarifyRequestProblem", () => {
	it("refuses empty, oversized and over-limit messages", () => {
		assert.ok(clarifyRequestProblem("", []));
		assert.ok(clarifyRequestProblem("   ", []));
		assert.ok(clarifyRequestProblem(42, []));
		assert.ok(clarifyRequestProblem("x".repeat(CLARIFY_MAX_CHARS + 1), []));
		const full = Array.from({ length: CLARIFY_MAX_EXCHANGES }, (_, i) => exchange(`q${i}`));
		assert.ok(clarifyRequestProblem("one more", full));
		assert.equal(clarifyRequestProblem("what does X mean?", full.slice(1)), null);
	});
});

// ─── the answer path: the record's thread rides the answer ──────────────────

const answer = (over: Partial<QuestionAnswerData> = {}): QuestionAnswerData => ({
	kind: "quiz",
	tool: "quiz",
	questionText: quizArgs.question,
	dontKnow: false,
	answers: [{ index: 1, label: "A capsule", value: "capsule" }],
	correct: true,
	answeredAt: "2026-10-25T00:00:00.000Z",
	...over,
});

describe("answers carry the side chat", () => {
	it("attachClarifications replaces the client's thread and drops an empty one", () => {
		const record = [exchange("server")];
		assert.deepEqual(attachClarifications(answer({ clarifications: [exchange("client")] }), record).clarifications, record);
		assert.equal("clarifications" in attachClarifications(answer({ clarifications: [exchange("client")] }), undefined), false);
		assert.equal("clarifications" in attachClarifications(answer(), []), false);
	});

	it("the model sees asked/reply pairs on answers and skips, nothing when absent", () => {
		const thread = [exchange("what is a capsule?", "A pill shape.")];
		assert.deepEqual(compactAnswerForModel(answer({ clarifications: thread })).clarifications, [
			{ asked: "what is a capsule?", reply: "A pill shape." },
		]);
		assert.deepEqual(compactAnswerForModel({ ...dismissedAnswer("quiz", "Q"), clarifications: thread }), {
			kind: "quiz",
			dismissed: true,
			clarifications: [{ asked: "what is a capsule?", reply: "A pill shape." }],
		});
		assert.equal("clarifications" in compactAnswerForModel(answer()), false);
		assert.equal("clarifications" in compactAnswerForModel(answer({ clarifications: [] })), false);
	});

	it("inputAppends and dismissAppends attach the record's thread for that question", () => {
		const thread = [exchange("what is a capsule?")];
		const record = { messages: lesson(), clarifications: { call_open: thread, call_old: [exchange("stale")] } };
		const [result] = inputAppends(record, {
			type: "answer",
			toolCallId: "call_open",
			answer: answer({ clarifications: [exchange("forged by the client")] }),
		});
		assert.deepEqual((result as { details: QuestionAnswerData }).details.clarifications, thread);
		const modelText = (result as { content: { text: string }[] }).content[0]!.text;
		assert.ok(modelText.includes("what is a capsule?"));
		assert.ok(!modelText.includes("forged"));

		const [skip] = dismissAppends(record, { type: "dismiss", toolCallId: "call_open", answer: dismissedAnswer("quiz", "Q") });
		assert.deepEqual((skip as { details: QuestionAnswerData }).details.clarifications, thread);

		const [plain] = inputAppends({ messages: lesson() }, { type: "answer", toolCallId: "call_open", answer: answer() });
		assert.equal("clarifications" in (plain as { details: QuestionAnswerData }).details, false);
	});
});

// ─── role + store ────────────────────────────────────────────────────────────

describe("clarifier role and store", () => {
	it("runs on the Cheap slot", () => {
		assert.equal(ROLE_SLOT.clarifier, "cheap");
		const spec = resolveRoleSpec("clarifier", {
			version: 1,
			models: { cheap: { model: { provider: "deepseek", id: "deepseek-flash" } } },
		} as never);
		assert.equal(spec?.provider, "deepseek");
		assert.equal(spec?.id, "deepseek-flash");
	});

	it("appendClarification keeps one thread per question and leaves updatedAt alone", () => {
		const record = chatStore.createChat("clarify store fixture");
		try {
			const before = chatStore.getChat(record.id)!.updatedAt;
			assert.equal(chatStore.appendClarification(record.id, "call_a", exchange("one")).length, 1);
			assert.equal(chatStore.appendClarification(record.id, "call_a", exchange("two")).length, 2);
			chatStore.appendClarification(record.id, "call_b", exchange("other"));
			const saved = chatStore.getChat(record.id)!;
			assert.deepEqual(saved.clarifications?.call_a?.map((e) => e.asked), ["one", "two"]);
			assert.deepEqual(saved.clarifications?.call_b?.map((e) => e.asked), ["other"]);
			assert.equal(saved.updatedAt, before);
			// Messages written later keep the threads (read-modify-write).
			chatStore.saveMessages(record.id, lesson());
			assert.equal(chatStore.getChat(record.id)!.clarifications?.call_a?.length, 2);
		} finally {
			fs.unlinkSync(`${PATHS.chats}/${record.id}.json`);
		}
	});
});

// ─── the server half (scripted reply, in-memory store) ──────────────────────

function memoryStore(record: ChatRecord) {
	let current = structuredClone(record);
	const turns: TurnUsage[] = [];
	const store = {
		getChat: (id: string) => (id === current.id ? structuredClone(current) : null),
		appendTurnUsage: (_id: string, entry: TurnUsage) => void turns.push(entry),
		appendClarification: (_id: string, toolCallId: string, ex: ClarifyExchange) => {
			const thread = [...(current.clarifications?.[toolCallId] ?? []), ex];
			current = { ...current, clarifications: { ...current.clarifications, [toolCallId]: thread } };
			return thread;
		},
	};
	return {
		store: store as unknown as ChatStore,
		turns,
		get record() {
			return current;
		},
		set messages(messages: LhMessage[]) {
			current = { ...current, messages };
		},
	};
}

const engine = { model: { provider: "test", id: "flash" } } as unknown as PiEngine;

function setup(reply?: ClarifyDeps["reply"]) {
	const mem = memoryStore({
		id: "chat_1",
		title: "t",
		createdAt: "2026-10-25T00:00:00.000Z",
		updatedAt: "2026-10-25T00:00:00.000Z",
		messages: lesson(),
	} as ChatRecord);
	const prompts: string[] = [];
	const deps: ClarifyDeps = {
		chatStore: mem.store,
		engine: () => ({ engine }),
		reply:
			reply ??
			(async ({ prompt, onUsage }) => {
				prompts.push(prompt);
				onUsage(usage(100));
				return "  A capsule is a pill shape.  ";
			}),
	};
	return { mem, deps, prompts };
}

describe("clarifyQuestion", () => {
	it("saves the exchange, records usage on the question's message, and never sends the answer key", async () => {
		const { mem, deps, prompts } = setup();
		const res = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: " what is a capsule? " }, undefined, deps);
		assert.ok(res.ok);
		assert.equal(res.exchange.asked, "what is a capsule?");
		assert.equal(res.exchange.reply, "A capsule is a pill shape.");
		assert.deepEqual(mem.record.clarifications?.call_open?.map((e) => e.asked), ["what is a capsule?"]);
		assert.equal(mem.turns.length, 1);
		assert.equal(mem.turns[0]!.messageId, "a2");
		assert.equal(mem.turns[0]!.model, "test:flash");
		assert.equal(mem.turns[0]!.steps[0]!.inputTokens, 100);
		assert.equal(prompts.length, 1);
		assert.ok(!prompts[0]!.includes(SECRET));
		assert.ok(prompts[0]!.includes("what is a capsule?"));

		const second = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "and a box?" }, undefined, deps);
		assert.ok(second.ok);
		assert.equal(second.thread.length, 2);
		assert.ok(prompts[1]!.includes("Learner: what is a capsule?"));
	});

	it("refuses honestly", async () => {
		const { deps } = setup();
		const status = async (chatId: string, body: unknown) => {
			const res = await clarifyQuestion(chatId, body, undefined, deps);
			return res.ok ? 200 : res.status;
		};
		assert.equal(await status("chat_1", {}), 400);
		assert.equal(await status("nope", { toolCallId: "call_open", text: "x" }), 404);
		assert.equal(await status("chat_1", { toolCallId: "call_old", text: "x" }), 409); // already answered
		assert.equal(await status("chat_1", { toolCallId: "call_ghost", text: "x" }), 409);
		assert.equal(await status("chat_1", { toolCallId: "call_open", text: "  " }), 400);
	});

	it("passes an engine refusal through without calling the model", async () => {
		const { deps, prompts } = setup();
		const res = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "x" }, undefined, {
			...deps,
			engine: () => ({ status: 503, error: "No model configured" }),
		});
		assert.deepEqual(res, { ok: false, status: 503, error: "No model configured" });
		assert.equal(prompts.length, 0);
	});

	it("drops a reply whose question was answered meanwhile, but still records its usage", async () => {
		const box: { mem?: ReturnType<typeof setup>["mem"] } = {};
		const { mem, deps } = setup(async ({ onUsage }) => {
			box.mem!.messages = [...lesson(), resultFor("call_open", "quiz", { kind: "quiz", dontKnow: true })];
			onUsage(usage(5));
			return "late reply";
		});
		box.mem = mem;
		const res = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "x" }, undefined, deps);
		assert.equal(res.ok ? 200 : res.status, 409);
		assert.equal(mem.record.clarifications, undefined);
		assert.equal(mem.turns.length, 1);
	});

	it("allows one reply in flight per question", async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const { deps } = setup(async () => {
			await gate;
			return "ok";
		});
		const first = clarifyQuestion("chat_1", { toolCallId: "call_open", text: "one" }, undefined, deps);
		const second = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "two" }, undefined, deps);
		assert.equal(second.ok ? 200 : second.status, 409);
		release();
		assert.ok((await first).ok);
		// Released: the next message goes through.
		assert.ok((await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "three" }, undefined, deps)).ok);
	});

	it("maps model failures, aborts and empty replies", async () => {
		const failing = setup(async ({ onUsage }) => {
			onUsage(usage(7)); // billed before the stream died
			throw new Error("rate limited");
		});
		const failed = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "x" }, undefined, failing.deps);
		assert.equal(failed.ok ? 200 : failed.status, 502);
		assert.ok(!failed.ok && failed.error.includes("rate limited"));
		assert.equal(failing.mem.turns.length, 1, "a failed call's billed usage still lands");
		assert.equal(failing.mem.turns[0]!.steps[0]!.inputTokens, 7);

		const aborting = setup(async () => {
			const err = new Error("aborted");
			err.name = "AbortError";
			throw err;
		});
		const aborted = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "x" }, undefined, aborting.deps);
		assert.equal(aborted.ok ? 200 : aborted.status, 499);

		const empty = setup(async ({ onUsage }) => {
			onUsage(usage(1));
			return "   ";
		});
		const blank = await clarifyQuestion("chat_1", { toolCallId: "call_open", text: "x" }, undefined, empty.deps);
		assert.equal(blank.ok ? 200 : blank.status, 502);
		assert.equal(empty.mem.record.clarifications, undefined);
	});
});
