/**
 * The question side chat's server half (core/clarify.ts has the pure part):
 * one learner message in, one clarifier reply out, both saved to the open
 * question's thread in the chat record.
 *
 * Only an OPEN question can be asked about (the dangling question call),
 * one message at a time per question. The reply is a one-shot, tool-less
 * sub-agent run on the clarifier role (the Cheap slot). Its usage goes to
 * the chat's turn log, keyed to the question's assistant message.
 */

import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import {
	buildClarifyPrompt,
	clarifyLessonContext,
	clarifyQuestionView,
	clarifyRequestProblem,
	CLARIFIER_SYSTEM_PROMPT,
} from "../core/clarify.ts";
import type { CallUsage, ClarifyExchange, ChatRecord } from "../core/contracts.ts";
import type { ChatStore } from "../core/ports.ts";
import { danglingQuestionOf, type LhMessage } from "../core/native-messages.ts";
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

const subagentReply: ClarifyReplier = async ({ prompt, engine, chatId, signal, onUsage }) => {
	const { text } = await runSubagent([], {
		role: "clarifier",
		engine,
		systemPrompt: CLARIFIER_SYSTEM_PROMPT,
		prompt,
		maxTurns: 1,
		abortSignal: signal,
		onUsage,
		chatId,
	});
	return text;
};

const defaultDeps: ClarifyDeps = { chatStore: stores.chatStore, engine: settingsEngine };

/** One reply in flight per question (a double send would fork the thread). */
const inFlight = new Set<string>();

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

/** The saved side chat for one question ([] when none), or null for an
 *  unknown chat. */
export function clarifyThread(chatId: string, toolCallId: string, deps: Pick<ClarifyDeps, "chatStore"> = defaultDeps): ClarifyExchange[] | null {
	const record = deps.chatStore.getChat(chatId);
	if (!record) return null;
	return record.clarifications?.[toolCallId] ?? [];
}

/** Ask the clarifier about the open question. Body: {toolCallId, text}. */
export async function clarifyQuestion(
	chatId: string,
	body: unknown,
	signal?: AbortSignal,
	deps: ClarifyDeps = defaultDeps,
): Promise<ClarifyResult> {
	const b = (typeof body === "object" && body !== null ? body : {}) as { toolCallId?: unknown; text?: unknown };
	if (typeof b.toolCallId !== "string" || b.toolCallId.length === 0) return { ok: false, status: 400, error: "toolCallId is required" };
	const toolCallId = b.toolCallId;
	const record = deps.chatStore.getChat(chatId);
	if (!record) return { ok: false, status: 404, error: "unknown chat" };
	const question = openQuestion(record, toolCallId);
	if (!question) return { ok: false, status: 409, error: "This question is no longer open." };
	const thread = record.clarifications?.[toolCallId] ?? [];
	const problem = clarifyRequestProblem(b.text, thread);
	if (problem) return { ok: false, status: 400, error: problem };
	const asked = (b.text as string).trim();

	const key = `${chatId}:${toolCallId}`;
	if (inFlight.has(key)) return { ok: false, status: 409, error: "Still answering your last message." };
	const choice = deps.engine();
	if (!("engine" in choice)) return { ok: false, ...choice };
	const { engine } = choice;

	inFlight.add(key);
	try {
		const prompt = buildClarifyPrompt({
			lesson: clarifyLessonContext(record.messages),
			question: clarifyQuestionView(question.tool, question.input),
			thread,
			asked,
		});
		// The money channel: every billed request lands in the turn log,
		// whether the reply succeeds, fails, or can no longer be saved.
		const usage: Usage[] = [];
		const recordUsage = () => {
			if (usage.length === 0) return;
			const steps: CallUsage[] = usage.map((u) => usageToCallUsage(u));
			try {
				deps.chatStore.appendTurnUsage(chatId, {
					id: crypto.randomUUID(),
					messageId: question.messageId,
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
			text = await (deps.reply ?? subagentReply)({ prompt, engine, chatId, signal, onUsage: (u) => usage.push(u) });
		} catch (err) {
			recordUsage();
			if (err instanceof Error && err.name === "AbortError") return { ok: false, status: 499, error: "cancelled" };
			return { ok: false, status: 502, error: `The side-chat model failed: ${err instanceof Error ? err.message : String(err)}` };
		}
		recordUsage();
		const at = new Date().toISOString();
		const reply = text.trim();
		if (!reply) return { ok: false, status: 502, error: "The side-chat model returned an empty reply. Try again." };
		// The learner may have answered while the reply was being written:
		// only an exchange about a still-open question joins the thread.
		const latest = deps.chatStore.getChat(chatId);
		if (!latest || !openQuestion(latest, toolCallId)) return { ok: false, status: 409, error: "This question was answered before the reply arrived." };
		const exchange: ClarifyExchange = { asked, reply, at };
		const saved = deps.chatStore.appendClarification(chatId, toolCallId, exchange);
		return { ok: true, exchange, thread: saved };
	} finally {
		inFlight.delete(key);
	}
}
