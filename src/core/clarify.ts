/**
 * THE SIDE CHAT (clarifier): a separate helper the learner can ask without
 * touching the lesson. About an open QUESTION, it explains wording, terms
 * and notation without answering it. About one of the tutor's REPLIES (a
 * grading, an explanation), it explains the reply in full and can draw
 * diagrams, but never answers a question that is still open.
 *
 * Everything here is pure and browser-safe. The server runs the model call
 * (src/server/clarify.ts); the record keeps each question's thread under
 * `clarifications[toolCallId]`, and the answer carries a copy so the
 * teacher reads it (compactAnswerForModel).
 *
 * The answer key never reaches the helper: every question call it can see,
 * the open one and any queued or past ones, is reduced to its wording
 * (clarifyQuestionView) before the transcript is serialized, and a rejected
 * question call's error (it quotes the call's arguments) becomes a note.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ClarifyExchange } from "./contracts/chat.ts";
import {
	activeProblemOf,
	danglingQuestionOf,
	PRACTICE_CONCLUDE_TOOL,
	PRACTICE_PROBLEM_TOOL,
	type LhMessage,
} from "./native-messages.ts";
import { serializeForSummary } from "./compaction.ts";
import { QUESTION_TOOLS, toolQuestionKind } from "./pending.ts";
import { parseAskInput, parseExplainInput, parseQuizInput } from "./tool-parts.ts";

/** Most exchanges one question may collect. */
export const CLARIFY_MAX_EXCHANGES = 12;
/** Longest learner message the side chat accepts. */
export const CLARIFY_MAX_CHARS = 2_000;
/** How much of the lesson transcript (its most recent part) the helper reads. */
export const CLARIFY_CONTEXT_CHARS = 16_000;

/** The parts of a question call the helper may see: its wording only. */
export interface ClarifyQuestionView {
	tool: string;
	question: string;
	details?: string;
	options?: string[];
	multiSelect?: boolean;
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim().length > 0 ? v : undefined);

/** The option labels of a raw (unparsed) options value. With
 *  `descriptions`, an option's description follows its label ("label: …");
 *  only ungraded (ask) questions pass it — quiz descriptions were used to
 *  telegraph the answer, so they never reach the helper. */
function optionLines(options: unknown, descriptions: boolean): string[] | undefined {
	if (!Array.isArray(options)) return undefined;
	const lines = options
		.map((o) => {
			if (typeof o === "string") return o;
			const opt = (o ?? {}) as { label?: unknown; description?: unknown };
			const label = str(opt.label);
			const description = descriptions ? str(opt.description) : undefined;
			return label && description ? `${label}: ${description}` : label;
		})
		.filter((l): l is string => typeof l === "string");
	return lines.length > 0 ? lines : undefined;
}

/**
 * A question call reduced to what the learner sees: the question, its
 * details line, and the option labels. A whitelist, so a new answer-key
 * field can never leak: correctAnswer, explanation, option values and
 * nodeId are all dropped. Uses the display parsers (escape repair) and
 * falls back to the raw fields when a record doesn't parse.
 */
export function clarifyQuestionView(tool: string, input: unknown): ClarifyQuestionView {
	const kind = toolQuestionKind(tool);
	const raw = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
	const parsed =
		kind === "quiz" ? parseQuizInput(input) : kind === "explain" ? parseExplainInput(input) : parseAskInput(input);
	const source = (parsed ?? raw) as Record<string, unknown>;
	const view: ClarifyQuestionView = { tool, question: str(source.question) ?? "" };
	const details = str(source.details);
	if (details) view.details = details;
	if (kind !== "explain") {
		const options = optionLines(source.options, kind === "ask");
		if (options) view.options = options;
		if (source.multiSelect === true) view.multiSelect = true;
	}
	return view;
}

/** The note that replaces a rejected question call's error: validation
 *  errors quote the call's arguments, the intended answer included. */
const rejectedNote = (what: "question" | "problem") => `(this ${what} call was rejected; the tutor retried it)`;

/** Stands in for a compaction summary that may describe a still-open
 *  question's or problem's answer (compaction runs in the learner's pause,
 *  and its summary records what's pending). */
const HIDDEN_SUMMARY_NOTE =
	"(the earlier lesson was summarized here; the summary is hidden while the question or problem it may describe is still open)";

/** One message as the helper may read it: question calls reduced to their
 *  wording, rejected question and problem calls' errors (which can echo
 *  their arguments) replaced by a neutral note, and practice problem calls
 *  reduced to their statement unless a conclude has shown the learner the
 *  solution (`revealed`). */
function withoutAnswerKey(m: LhMessage, revealed: ReadonlySet<string>): LhMessage {
	const role = (m as { role?: string }).role;
	if (role === "toolResult") {
		const result = m as ToolResultMessage & LhMessage;
		if (!result.isError) return m;
		const what = isQuestionTool(result.toolName) ? "question" : result.toolName === PRACTICE_PROBLEM_TOOL ? "problem" : null;
		if (!what) return m;
		return { ...result, content: [{ type: "text", text: rejectedNote(what) }] } as LhMessage;
	}
	if (role !== "assistant") return m;
	const assistant = m as AssistantMessage & LhMessage;
	const hidden = (b: AssistantMessage["content"][number]) =>
		b.type === "toolCall" && (isQuestionTool(b.name) || (b.name === PRACTICE_PROBLEM_TOOL && !revealed.has(b.id)));
	if (!assistant.content.some(hidden)) return m;
	return {
		...assistant,
		content: assistant.content.map((b) => {
			if (b.type !== "toolCall" || !hidden(b)) return b;
			return isQuestionTool(b.name)
				? { ...b, arguments: { ...clarifyQuestionView(b.name, b.arguments) } }
				: { ...b, arguments: { statement: (b.arguments as { statement?: unknown } | undefined)?.statement } };
		}),
	} as LhMessage;
}

/** Practice problem calls whose solution the learner has seen: each one a
 *  clean conclude revealed (the conclude card shows it), pairing with the
 *  newest clean pose before it. Every other pose (the problem in progress,
 *  a refused one) keeps its solution and target hidden. */
function revealedProblemIds(messages: readonly LhMessage[]): Set<string> {
	const clean = new Set<string>();
	for (const m of messages) {
		const r = m as { role?: string; isError?: boolean; toolCallId?: string };
		if (r.role === "toolResult" && r.isError !== true && r.toolCallId) clean.add(r.toolCallId);
	}
	const revealed = new Set<string>();
	let posed: string | null = null;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const b of (m as AssistantMessage).content) {
			if (b.type !== "toolCall" || !clean.has(b.id)) continue;
			if (b.name === PRACTICE_PROBLEM_TOOL) posed = b.id;
			else if (b.name === PRACTICE_CONCLUDE_TOOL && posed) {
				revealed.add(posed);
				posed = null;
			}
		}
	}
	return revealed;
}

/** Where the open question or the practice problem in progress was posed
 *  (its message index), or -1. A compaction summary written after it may
 *  describe its answer. */
function openPoseIndex(messages: readonly LhMessage[]): number {
	const ids = new Set<string>();
	const question = danglingQuestionOf(messages);
	if (question) ids.add(question.toolCallId);
	const problem = activeProblemOf(messages);
	if (problem) ids.add(problem.toolCallId);
	// The latest call with each id is the open one (legacy records reuse ids
	// like call_0); the earliest of those bounds the summaries to hide.
	let at = -1;
	for (let i = messages.length - 1; i >= 0 && ids.size > 0; i--) {
		if ((messages[i] as { role?: string }).role !== "assistant") continue;
		for (const b of (messages[i] as AssistantMessage).content) {
			if (b.type === "toolCall" && ids.delete(b.id)) at = i;
		}
	}
	return at;
}

const isCompactionMarker = (m: LhMessage): boolean =>
	(m as { role?: string }).role === "custom" && (m as { customType?: string }).customType === "compaction";

const isQuestionTool = (name: string): boolean => (QUESTION_TOOLS as readonly string[]).includes(name);

/**
 * The lesson transcript as the helper reads it: answer keys, unrevealed
 * practice solutions and summaries written while those were open stripped,
 * then
 * serialized, then cut to its most recent CLARIFY_CONTEXT_CHARS (at a line
 * boundary when one is near). Walks back from the newest message, so a long
 * session serializes only the tail it keeps.
 */
export function clarifyLessonContext(messages: readonly LhMessage[], maxChars = CLARIFY_CONTEXT_CHARS): string {
	const parts: string[] = [];
	let size = 0;
	let i = messages.length - 1;
	const revealed = revealedProblemIds(messages);
	const openAt = openPoseIndex(messages);
	for (; i >= 0 && size <= maxChars; i--) {
		const m = messages[i]!;
		const readable =
			openAt >= 0 && i > openAt && isCompactionMarker(m)
				? ({ ...m, content: HIDDEN_SUMMARY_NOTE } as LhMessage)
				: withoutAnswerKey(m, revealed);
		// serializeForSummary renders each message as one block joined by a
		// blank line, so per-message pieces join back to the same text.
		const piece = serializeForSummary([readable]);
		if (!piece) continue;
		parts.push(piece);
		size += piece.length + 2;
	}
	const text = parts.reverse().join("\n\n");
	if (i < 0 && text.length <= maxChars) return text;
	const tail = text.slice(Math.max(0, text.length - maxChars));
	const cut = tail.indexOf("\n");
	return `[…earlier lesson omitted]\n${cut >= 0 && cut < 400 ? tail.slice(cut + 1) : tail}`;
}

/** The helper's standing instructions. */
export const CLARIFIER_SYSTEM_PROMPT = [
	"You are the side-chat helper in a tutoring app. The tutor has asked the learner a question, and the learner has not answered yet. Before answering, the learner is asking you about the question itself: what it means, what a term or symbol refers to, or what kind of answer is expected.",
	"",
	"Rules:",
	"- Explain the wording, terms and notation, and what the question is asking for. Use the lesson transcript so your explanation matches what the tutor taught.",
	"- Never answer the question. Never say or hint which option is right or wrong, never rule options in or out, and never do the reasoning the question is checking.",
	"- Never describe the method, steps or formula that gets to the answer, and never point to an earlier step in the lesson as the one to repeat: that hands over the reasoning too. Explain what the words mean, not how to solve it. If a term is the very thing being tested, explain only enough to make the question readable.",
	'- If the learner asks for the answer or a hint, say kindly that you can\'t help with that part, and that a best guess or "I don\'t know" is a fine answer.',
	"- If the question really is ambiguous, say so and describe the possible readings. The tutor sees this side chat along with the learner's answer.",
	"- For questions that are not graded (they ask about the learner's own goals or situation), you may explain what the options mean and how they differ, but don't choose for the learner.",
	"- If a picture would help the learner read the question, you may draw what the question STATES (its givens and setup, placed where the question puts them) as an ```svg fenced block: one <svg> with a viewBox about 300-500 units wide (font-size 14 for labels), coordinates worked out carefully (SVG's y axis points down), strokes and text in currentColor, accents only from #3b82f6, #f59e0b, #10b981, #ef4444.",
	"- Never draw what the question ASKS for: no label, mark or measurement for a value the learner has to find, and no construction (projections, components, extra lines) that works it out. If the setup can't be drawn without showing the answer, explain in words instead. Never draw ASCII art.",
	"- Keep replies short: a few sentences of plain language. Markdown and LaTeX ($...$) are fine.",
].join("\n");

/** How the open question is answered, in words the helper can relay. */
function answerShape(view: ClarifyQuestionView): string {
	const kind = toolQuestionKind(view.tool);
	if (kind === "explain") return "A free-text answer in the learner's own words (graded by the tutor).";
	if (kind === "quiz")
		return view.multiSelect
			? 'Multiple choice, select all that apply, or "I don\'t know" (graded).'
			: 'Multiple choice, pick one, or "I don\'t know" (graded).';
	return view.options
		? "Pick from the options or type their own answer (not graded: there is no right answer)."
		: "A free-text reply (not graded: there is no right answer).";
}

/** The helper's one-shot prompt: lesson context, the open question, the
 *  side chat so far, and the learner's new message. */
export function buildClarifyPrompt(args: {
	lesson: string;
	question: ClarifyQuestionView;
	thread: readonly ClarifyExchange[];
	asked: string;
}): string {
	const q = args.question;
	const lines: string[] = ["## The lesson so far (most recent part)", "", args.lesson || "(nothing yet)", ""];
	lines.push("## The open question", "", `Answer format: ${answerShape(q)}`, "", q.question);
	if (q.details) lines.push("", q.details);
	if (q.options) lines.push("", "Options:", ...q.options.map((o) => `- ${o}`));
	lines.push("");
	if (args.thread.length > 0) {
		lines.push("## Side chat so far", "");
		for (const ex of args.thread) lines.push(`Learner: ${ex.asked}`, "", `You: ${ex.reply}`, "");
	}
	lines.push("## The learner now asks", "", args.asked);
	return lines.join("\n");
}

/** Why a side-chat message is refused, or null when it may be sent. */
export function clarifyRequestProblem(
	text: unknown,
	thread: readonly ClarifyExchange[],
	subject: "question" | "reply" = "question",
): string | null {
	if (typeof text !== "string" || text.trim().length === 0) return "Type a question first.";
	if (text.length > CLARIFY_MAX_CHARS) return `Keep it under ${CLARIFY_MAX_CHARS} characters.`;
	if (thread.length >= CLARIFY_MAX_EXCHANGES)
		return subject === "question"
			? `This question already has ${CLARIFY_MAX_EXCHANGES} side-chat messages. Answer it to go on.`
			: `This reply already has ${CLARIFY_MAX_EXCHANGES} side-chat messages. Ask about another reply, or ask the tutor.`;
	return null;
}

/** The answer with the record's side-chat thread attached (replacing any
 *  thread the client sent). No thread → the field is removed. */
export function attachClarifications<T extends { clarifications?: ClarifyExchange[] }>(
	answer: T,
	thread: readonly ClarifyExchange[] | undefined,
): T {
	const { clarifications: _client, ...rest } = answer;
	return (thread && thread.length > 0 ? { ...rest, clarifications: [...thread] } : rest) as T;
}

// ─── side chats about the tutor's replies ────────────────────────────────────

/** A reply chat's id: the tutor text part it's about (view.ts textPartId,
 *  `<native message id>-t<n>`, the nth text block of that message). */
export const REPLY_CHAT_ID = /^(.{1,200})-t(\d{1,4})$/;

export interface ReplyPassage {
	/** The native assistant message the text belongs to. */
	messageId: string;
	text: string;
}

/** The tutor text a reply chat is about, or null when the id doesn't point
 *  at a non-empty text block of an assistant message. */
export function replyPassageOf(messages: readonly LhMessage[], partId: string): ReplyPassage | null {
	const match = REPLY_CHAT_ID.exec(partId);
	if (!match) return null;
	const messageId = match[1]!;
	const index = Number(match[2]);
	const message = messages.find(
		(m) => (m as { id?: string }).id === messageId && (m as { role?: string }).role === "assistant",
	) as (AssistantMessage & LhMessage) | undefined;
	if (!message) return null;
	const block = message.content.filter((b) => b.type === "text")[index];
	return block && block.type === "text" && block.text.trim() ? { messageId, text: block.text } : null;
}

/** The reply helper's standing instructions. A practice session has no
 *  open questions but may have a problem in progress (never solved for the
 *  learner), and no answers to carry the chat to the tutor. */
export function replyHelperSystemPrompt(session: "teach" | "practice"): string {
	return [
		"You are the side-chat helper in a tutoring app. The learner is asking about one of the tutor's replies, shown below (often the tutor's grading of their answer). Help them understand it.",
		"",
		"Rules:",
		"- Explain what the reply says: walk through its reasoning step by step, redo any arithmetic slowly, define its terms, and connect it to what the lesson taught. Use the lesson transcript for context.",
		"- Draw a figure when the learner asks for one, or when a picture explains it better than words. For geometry and anything spatial (triangles, circles, angles, vectors, coordinates), write an ```svg fenced block; it renders as a real picture. One <svg> with a viewBox about 300-500 units wide (font-size 14 for labels), coordinates worked out carefully (SVG's y axis points down), strokes and text in currentColor so it follows the learner's theme, accents only from #3b82f6, #f59e0b, #10b981, #ef4444, every point and length labeled.",
		'- For flows and relationships, use a ```mermaid fenced block instead; node labels with spaces or symbols must use the quoted bracket form (B["u = x^3"]). Never draw ASCII art.',
		session === "teach"
			? "- A question may still be open in the lesson (shown below if so). Never answer it, hint at it, or do its reasoning. If the learner asks about it, tell them the question has its own \"Ask about this\" button."
			: "- The learner may be working on a practice problem (shown below if so). Never solve it, hint at it, or do its reasoning. If the learner asks about it, tell them to work it in the \"Your thinking\" field or ask the tutor.",
		...(session === "teach" ? ["- The tutor sees this side chat along with the learner's next answer."] : []),
		"- Keep replies focused: short paragraphs. Markdown and LaTeX ($...$) are fine.",
	].join("\n");
}

/** The reply helper's instructions in a teaching session. */
export const REPLY_HELPER_SYSTEM_PROMPT = replyHelperSystemPrompt("teach");

/** The reply helper's one-shot prompt: lesson context, the reply, any open
 *  question (wording only) or practice problem in progress (its statement),
 *  the side chat so far, and the new message. */
export function buildReplyChatPrompt(args: {
	lesson: string;
	reply: string;
	openQuestion: ClarifyQuestionView | null;
	openProblem?: string | null;
	thread: readonly ClarifyExchange[];
	asked: string;
}): string {
	const lines: string[] = ["## The lesson so far (most recent part)", "", args.lesson || "(nothing yet)", ""];
	lines.push("## The tutor's reply the learner is asking about", "", args.reply, "");
	const q = args.openQuestion;
	if (q) {
		lines.push("## A question still open in the lesson (never answer it)", "", q.question);
		if (q.details) lines.push("", q.details);
		if (q.options) lines.push("", "Options:", ...q.options.map((o) => `- ${o}`));
		lines.push("");
	}
	if (args.openProblem) {
		lines.push("## The practice problem the learner is working on (never solve it)", "", args.openProblem, "");
	}
	if (args.thread.length > 0) {
		lines.push("## Side chat so far", "");
		for (const ex of args.thread) lines.push(`Learner: ${ex.asked}`, "", `You: ${ex.reply}`, "");
	}
	lines.push("## The learner now asks", "", args.asked);
	return lines.join("\n");
}

/** When the learner last answered or skipped a question (ms), or 0. A
 *  rejected question call (an error result) isn't an answer, and a typed
 *  message carries no side chats, so neither moves the mark. */
function lastAnswerAt(messages: readonly LhMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string; toolName?: string; isError?: boolean; timestamp?: unknown };
		if (m.role === "toolResult" && m.isError !== true && isQuestionTool(m.toolName ?? "")) {
			return typeof m.timestamp === "number" ? m.timestamp : 0;
		}
	}
	return 0;
}

/** The reply-chat exchanges since the learner's last answer, oldest first:
 *  what they asked about the tutor's replies before this one. */
export function replyChatsSince(record: {
	messages: readonly LhMessage[];
	replyChats?: Record<string, ClarifyExchange[]>;
}): ClarifyExchange[] {
	if (!record.replyChats) return [];
	const since = lastAnswerAt(record.messages);
	return Object.values(record.replyChats)
		.flat()
		.filter((ex) => Date.parse(ex.at) > since)
		.sort((a, b) => a.at.localeCompare(b.at));
}

/** The answer with the reply chats attached (replacing any the client sent).
 *  None → the field is removed. */
export function attachReplyChats<T extends { replyChats?: ClarifyExchange[] }>(
	answer: T,
	exchanges: readonly ClarifyExchange[],
): T {
	const { replyChats: _client, ...rest } = answer;
	return (exchanges.length > 0 ? { ...rest, replyChats: [...exchanges] } : rest) as T;
}
