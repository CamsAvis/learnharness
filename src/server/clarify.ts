/**
 * The side chat's server half (core/clarify.ts has the pure part): one
 * learner message in, one helper reply out, both saved to a thread in the
 * chat record. A side chat is about one target:
 *
 *   question  an OPEN question (the dangling question call), by toolCallId:
 *             explained without its answer; saved under `clarifications`.
 *   reply     one of the tutor's text passages, by part id
 *             (`<message id>-t<n>`): explained in full, diagrams allowed;
 *             saved under `replyChats`.
 *
 * One message at a time per target. The reply is a one-shot, tool-less
 * sub-agent run on the clarifier role (the Cheap slot); its usage goes to
 * the chat's turn log, keyed to the target's assistant message.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	buildClarifyPrompt,
	buildReplyChatPrompt,
	clarifyLessonContext,
	clarifyQuestionView,
	clarifyRequestProblem,
	CLARIFIER_SYSTEM_PROMPT,
	REPLY_CHAT_ID,
	replyHelperSystemPrompt,
	replyPassageOf,
} from "../core/clarify.ts";
import type { CallUsage, ClarifyExchange, ChatRecord } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { activeProblemOf, danglingQuestionOf, type LhMessage } from "../core/native-messages.ts";
import { modelsNotConfigured, providerKeyMissing } from "../core/settings.ts";
import { resolveRoleSpec } from "../core/settings-resolution.ts";
import { usageToCallUsage } from "../core/usage.ts";
import type { PiEngine } from "../agent/models.ts";
import { runSubagent } from "../agent/subagents/pi-run.ts";
import { AcpConnectionUnavailable, engineForSpec } from "./acp.ts";
import { providerKeyPresent } from "./keys.ts";
import { stores } from "./stores.ts";

export type ClarifyResult =
	| { ok: true; exchange: ClarifyExchange; thread: ClarifyExchange[] }
	| { ok: false; status: number; error: string };

type EngineChoice = { engine: PiEngine } | { status: number; error: string };

/** The one-shot model call: resolves to the reply text. Usage is reported
 *  per request as it happens, so a call that fails after billing still
 *  lands in the turn log. */
export type ClarifyReplier = (args: {
	prompt: string;
	systemPrompt: string;
	engine: PiEngine;
	chatId: string;
	signal?: AbortSignal;
	onUsage: (usage: Usage) => void;
}) => Promise<string>;

export interface ClarifyDeps {
	chatStore: ChatStore;
	/** The clarifier's engine, or the refusal the learner sees. */
	engine: () => EngineChoice;
	/** Test seam: a scripted reply replaces the sub-agent run. */
	reply?: ClarifyReplier;
}

/** The clarifier role's engine from the user's settings (BYOK chain: the
 *  Cheap slot). A foreground call: the learner is waiting on it. */
function settingsEngine(): EngineChoice {
	const spec = resolveRoleSpec("clarifier", stores.settingsStore.readSettings());
	if (!spec) return { status: 503, error: modelsNotConfigured(["cheap"]).error };
	if (!providerKeyPresent(spec.provider)) return { status: 503, error: providerKeyMissing(spec.provider, ["cheap"]).error };
	try {
		return { engine: engineForSpec(spec, false) };
	} catch (err) {
		if (err instanceof AcpConnectionUnavailable) return { status: 503, error: err.message };
		return { status: 503, error: err instanceof Error ? err.message : String(err) };
	}
}

const subagentReply: ClarifyReplier = async ({ prompt, systemPrompt, engine, chatId, signal, onUsage }) => {
	const { text } = await runSubagent([], {
		role: "clarifier",
		engine,
		systemPrompt,
		prompt,
		maxTurns: 1,
		abortSignal: signal,
		onUsage,
		chatId,
	});
	return text;
};

const defaultDeps: ClarifyDeps = { chatStore: stores.chatStore, engine: settingsEngine };

/** One reply in flight per target (a double send would fork the thread). */
const inFlight = new Set<string>();

/** What a side chat is about. */
export type ClarifyTarget = { kind: "question"; id: string } | { kind: "reply"; id: string };

/** The target named by a request body or query: `toolCallId` (a question)
 *  or `replyId` (a tutor text part), or why it's malformed. */
export function parseClarifyTarget(raw: { toolCallId?: unknown; replyId?: unknown }): ClarifyTarget | { error: string } {
	if (typeof raw.replyId === "string" && raw.replyId.length > 0) {
		return REPLY_CHAT_ID.test(raw.replyId) ? { kind: "reply", id: raw.replyId } : { error: "replyId isn't a tutor reply's id" };
	}
	if (typeof raw.toolCallId === "string" && raw.toolCallId.length > 0) return { kind: "question", id: raw.toolCallId };
	return { error: "toolCallId or replyId is required" };
}

/** Everything one target contributes: its thread, how to prompt for it,
 *  the message its usage keys to, whether a finished reply may still be
 *  saved, and where it's saved. */
interface ResolvedTarget {
	thread: ClarifyExchange[];
	subject: "question" | "reply";
	systemPrompt: string;
	prompt: (asked: string) => string;
	usageMessageId: string;
	stillOpen: (record: ChatRecord) => boolean;
	save: (store: ChatStore, chatId: string, exchange: ClarifyExchange) => ClarifyExchange[];
	closedError: string;
}

function resolveTarget(record: ChatRecord, target: ClarifyTarget): ResolvedTarget | { status: number; error: string } {
	if (target.kind === "question") {
		const question = openQuestion(record, target.id);
		if (!question) return { status: 409, error: "This question is no longer open." };
		const thread = record.clarifications?.[target.id] ?? [];
		return {
			thread,
			subject: "question",
			systemPrompt: CLARIFIER_SYSTEM_PROMPT,
			prompt: (asked) =>
				buildClarifyPrompt({
					lesson: clarifyLessonContext(record.messages),
					question: clarifyQuestionView(question.tool, question.input),
					thread,
					asked,
				}),
			usageMessageId: question.messageId,
			// The learner may answer while the reply is being written: only an
			// exchange about a still-open question joins the thread.
			stillOpen: (latest) => openQuestion(latest, target.id) !== null,
			save: (store, chatId, exchange) => store.appendClarification(chatId, target.id, exchange),
			closedError: "This question was answered before the reply arrived.",
		};
	}
	const passage = replyPassageOf(record.messages, target.id);
	if (!passage) return { status: 404, error: "That reply isn't in this lesson." };
	const thread = record.replyChats?.[target.id] ?? [];
	const pending = danglingQuestionOf(record.messages);
	// Practice: the problem in progress is off limits (its statement only),
	// and no answers carry the chat to the tutor.
	const practice = record.kind === "practice";
	const statement = practice ? (activeProblemOf(record.messages)?.input as { statement?: unknown } | undefined)?.statement : undefined;
	return {
		thread,
		subject: "reply",
		systemPrompt: replyHelperSystemPrompt(practice ? "practice" : "teach"),
		prompt: (asked) =>
			buildReplyChatPrompt({
				lesson: clarifyLessonContext(record.messages),
				reply: passage.text,
				openQuestion: pending ? clarifyQuestionView(pending.tool, pending.input) : null,
				openProblem: typeof statement === "string" ? statement : null,
				thread,
				asked,
			}),
		usageMessageId: passage.messageId,
		stillOpen: (latest) => replyPassageOf(latest.messages, target.id) !== null,
		save: (store, chatId, exchange) => store.appendReplyChat(chatId, target.id, exchange),
		closedError: "That reply is no longer in this lesson.",
	};
}

/** The open question's id and its assistant message, or null. */
function openQuestion(record: ChatRecord, toolCallId: string): { messageId: string; tool: string; input: unknown } | null {
	const pending = danglingQuestionOf(record.messages);
	if (!pending || pending.toolCallId !== toolCallId) return null;
	const message = record.messages.find(
		(m) =>
			(m as { role?: string }).role === "assistant" &&
			(m as AssistantMessage).content.some((b) => b.type === "toolCall" && b.id === toolCallId),
	) as (LhMessage & { id: string }) | undefined;
	return { messageId: message?.id ?? toolCallId, tool: pending.tool, input: pending.input };
}

/** The saved side chat for one target ([] when none), or null for an
 *  unknown chat. */
export function clarifyThread(chatId: string, target: ClarifyTarget, deps: Pick<ClarifyDeps, "chatStore"> = defaultDeps): ClarifyExchange[] | null {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return null;
	return (target.kind === "question" ? record.clarifications : record.replyChats)?.[target.id] ?? [];
}

/** Ask the helper about a question or a tutor reply.
 *  Body: {toolCallId | replyId, text}. */
export async function clarifyQuestion(
	chatId: string,
	body: unknown,
	signal?: AbortSignal,
	deps: ClarifyDeps = defaultDeps,
): Promise<ClarifyResult> {
	const b = (typeof body === "object" && body !== null ? body : {}) as { toolCallId?: unknown; replyId?: unknown; text?: unknown };
	const target = parseClarifyTarget(b);
	if ("error" in target) return { ok: false, status: 400, error: target.error };
	const record = deps.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "unknown chat" };
	const resolved = resolveTarget(record, target);
	if ("error" in resolved) return { ok: false, ...resolved };
	const problem = clarifyRequestProblem(b.text, resolved.thread, resolved.subject);
	if (problem) return { ok: false, status: 400, error: problem };
	const asked = (b.text as string).trim();

	const key = `${chatId}:${target.kind}:${target.id}`;
	if (inFlight.has(key)) return { ok: false, status: 409, error: "Still answering your last message." };
	const choice = deps.engine();
	if (!("engine" in choice)) return { ok: false, ...choice };
	const { engine } = choice;

	inFlight.add(key);
	try {
		const prompt = resolved.prompt(asked);
		// The money channel: every billed request lands in the turn log,
		// whether the reply succeeds, fails, or can no longer be saved.
		const usage: Usage[] = [];
		const recordUsage = () => {
			if (usage.length === 0) return;
			const steps: CallUsage[] = usage.map((u) => usageToCallUsage(u));
			try {
				deps.chatStore.appendTurnUsage(chatId, {
					id: crypto.randomUUID(),
					messageId: resolved.usageMessageId,
					at: new Date().toISOString(),
					model: `${engine.model.provider}:${engine.model.id}`,
					steps,
				});
			} catch (err) {
				console.error(`[chat ${chatId}] could not save side-chat usage`, err);
			}
		};
		let text: string;
		try {
			text = await (deps.reply ?? subagentReply)({
				prompt,
				systemPrompt: resolved.systemPrompt,
				engine,
				chatId,
				signal,
				onUsage: (u) => usage.push(u),
			});
		} catch (err) {
			recordUsage();
			if (err instanceof Error && err.name === "AbortError") return { ok: false, status: 499, error: "cancelled" };
			return { ok: false, status: 502, error: `The side-chat model failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		recordUsage();
		const at = new Date().toISOString();
		const reply = text.trim();
		if (!reply) return { ok: false, status: 502, error: "The side-chat model returned an empty reply. Try again." };
		const latest = deps.chatStore.getChat(chatId);
		if (!latest || !resolved.stillOpen(latest)) return { ok: false, status: 409, error: resolved.closedError };
		const exchange: ClarifyExchange = { asked, reply, at };
		const saved = resolved.save(deps.chatStore, chatId, exchange);
		return { ok: true, exchange, thread: saved };
	} finally {
		inFlight.delete(key);
	}
}
