/**
 * THE QUESTION SIDE CHAT (clarifier): while a question waits for an answer,
 * the learner can ask a separate helper what the question means. The helper
 * explains wording, terms and notation without answering the question.
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
import type { LhMessage } from "./native-messages.ts";
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
const REJECTED_QUESTION_NOTE = "(this question call was rejected; the tutor retried it)";

/** One message as the helper may read it: question calls reduced to their
 *  wording, and rejected question calls' errors replaced by a neutral note. */
function withoutAnswerKey(m: LhMessage): LhMessage {
	const role = (m as { role?: string }).role;
	if (role === "toolResult") {
		const result = m as ToolResultMessage & LhMessage;
		if (!result.isError || !isQuestionTool(result.toolName)) return m;
		return { ...result, content: [{ type: "text", text: REJECTED_QUESTION_NOTE }] } as LhMessage;
	}
	if (role !== "assistant") return m;
	const assistant = m as AssistantMessage & LhMessage;
	if (!assistant.content.some((b) => b.type === "toolCall" && isQuestionTool(b.name))) return m;
	return {
		...assistant,
		content: assistant.content.map((b) =>
			b.type === "toolCall" && isQuestionTool(b.name)
				? { ...b, arguments: { ...clarifyQuestionView(b.name, b.arguments) } }
				: b,
		),
	} as LhMessage;
}

const isQuestionTool = (name: string): boolean => (QUESTION_TOOLS as readonly string[]).includes(name);

/**
 * The lesson transcript as the helper reads it: answer keys stripped, then
 * serialized, then cut to its most recent CLARIFY_CONTEXT_CHARS (at a line
 * boundary when one is near). Walks back from the newest message, so a long
 * session serializes only the tail it keeps.
 */
export function clarifyLessonContext(messages: readonly LhMessage[], maxChars = CLARIFY_CONTEXT_CHARS): string {
	const parts: string[] = [];
	let size = 0;
	let i = messages.length - 1;
	for (; i >= 0 && size <= maxChars; i--) {
		// serializeForSummary renders each message as one block joined by a
		// blank line, so per-message pieces join back to the same text.
		const piece = serializeForSummary([withoutAnswerKey(messages[i]!)]);
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
export function clarifyRequestProblem(text: unknown, thread: readonly ClarifyExchange[]): string | null {
	if (typeof text !== "string" || text.trim().length === 0) return "Type a question first.";
	if (text.length > CLARIFY_MAX_CHARS) return `Keep it under ${CLARIFY_MAX_CHARS} characters.`;
	if (thread.length >= CLARIFY_MAX_EXCHANGES)
		return `This question already has ${CLARIFY_MAX_EXCHANGES} side-chat messages. Answer it to go on.`;
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
