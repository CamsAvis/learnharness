/**
 * LESSON HIGHLIGHTS (fork feature): the learner's private highlights and
 * notes on a lesson's text. Pure and browser-safe — the anchor vocabulary,
 * request validation, quote location, ordering and the export section.
 *
 * Highlights are stored beside the messages (ChatRecord.highlights) and
 * are NEVER model-facing: nothing here feeds a prompt or extraction.
 *
 * Anchors name the rendered container a highlight lives in:
 *   t:<partId>                  teacher text part (`<messageId>-t<n>`)
 *   u:<messageId>               the learner's own message
 *   q:<messageId>:<toolCallId>  an answered question card (call ids alone
 *                               repeat in legacy records, hence the pair)
 * Inside the anchor a highlight is a text quote (exact + a little context),
 * matched against the anchor's text map (components/highlight-dom.ts).
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { HighlightColor, HighlightQuote, LessonHighlight } from "./contracts/chat.ts";
import type { LhMessage } from "./native-messages.ts";
import { QUESTION_TOOLS } from "./pending.ts";
import { textPartId } from "./view.ts";

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ["yellow", "green", "blue", "pink"];
export const DEFAULT_HIGHLIGHT_COLOR: HighlightColor = "yellow";

/** Display names, in menu order. */
export const HIGHLIGHT_COLOR_LABELS: Readonly<Record<HighlightColor, string>> = {
	yellow: "Yellow",
	green: "Green",
	blue: "Blue",
	pink: "Pink",
};

export const HIGHLIGHT_LIMITS = {
	/** Longest highlighted passage, in characters. */
	exact: 5_000,
	/** Quote context kept on each side. */
	context: 32,
	comment: 10_000,
	anchor: 400,
} as const;

export function isHighlightColor(value: unknown): value is HighlightColor {
	return typeof value === "string" && (HIGHLIGHT_COLORS as readonly string[]).includes(value);
}

/** Client-minted ids: URL-safe, short. */
export function isHighlightId(id: unknown): id is string {
	return typeof id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(id);
}

// ─── anchors ────────────────────────────────────────────────────────────────

export function teacherTextAnchor(partId: string): string {
	return `t:${partId}`;
}

export function userMessageAnchor(messageId: string): string {
	return `u:${messageId}`;
}

export function answeredCardAnchor(messageId: string, toolCallId: string): string {
	return `q:${messageId}:${toolCallId}`;
}

function messageText(m: LhMessage): string {
	const content = (m as { content?: unknown }).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((c): c is { type: "text"; text: string } => c?.type === "text" && typeof c.text === "string")
		.map((c) => c.text)
		.join("\n");
}

/**
 * Every anchor a highlight may use in this native record, mapped to its
 * transcript position (an increasing ordinal). The server validates PUTs
 * against it; the client runs it over the SERVER record only, so text
 * that is still streaming or not yet saved can't be highlighted.
 */
export function highlightAnchorsOf(messages: readonly LhMessage[]): Map<string, number> {
	const anchors = new Map<string, number>();
	let ordinal = 0;
	// Which call ids have an ANSWER, and from which message index on — an
	// answered card needs one after its call. Like the view (core/view.ts
	// applyResultTo), only a clean result carrying the answer data counts:
	// the "question posed" placeholder (details null) renders no card.
	const resultAt = new Map<string, number[]>();
	messages.forEach((m, i) => {
		if ((m as { role?: string }).role !== "toolResult") return;
		const r = m as ToolResultMessage;
		if (r.isError || r.details == null) return;
		const id = r.toolCallId;
		const at = resultAt.get(id) ?? [];
		at.push(i);
		resultAt.set(id, at);
	});
	messages.forEach((m, i) => {
		const id = (m as { id?: string }).id;
		if (!id) return; // legacy records without ids are never anchorable
		const role = (m as { role?: string }).role;
		if (role === "user") {
			if (messageText(m).trim()) anchors.set(userMessageAnchor(id), ordinal++);
			return;
		}
		if (role !== "assistant") return;
		let textN = 0;
		for (const block of (m as AssistantMessage).content) {
			if (block.type === "text") {
				const partId = textPartId(id, textN++);
				if (block.text.trim()) anchors.set(teacherTextAnchor(partId), ordinal++);
			} else if (block.type === "toolCall" && (QUESTION_TOOLS as readonly string[]).includes(block.name)) {
				if ((resultAt.get(block.id) ?? []).some((r) => r > i)) {
					anchors.set(answeredCardAnchor(id, block.id), ordinal++);
				}
			}
		}
	});
	return anchors;
}

// ─── request validation ─────────────────────────────────────────────────────

/** A malformed highlight request (the route's honest 400). */
export class HighlightInputError extends Error {}

/** What a PUT carries; the route adds id + timestamps. */
export interface HighlightPutBody {
	anchor: string;
	quote: HighlightQuote;
	color: HighlightColor;
	comment: string;
}

function str(value: unknown, field: string, max: number, allowEmpty = true): string {
	if (typeof value !== "string") throw new HighlightInputError(`${field} must be a string`);
	if (!allowEmpty && value.trim().length === 0) throw new HighlightInputError(`${field} must not be empty`);
	if (value.length > max) throw new HighlightInputError(`${field} is too long (max ${max} characters)`);
	return value;
}

export function parseHighlightPut(body: unknown): HighlightPutBody {
	if (typeof body !== "object" || body === null) throw new HighlightInputError("body must be an object");
	const b = body as Record<string, unknown>;
	const anchor = str(b.anchor, "anchor", HIGHLIGHT_LIMITS.anchor, false);
	if (!/^(t|u|q):\S/.test(anchor)) throw new HighlightInputError("anchor has an unknown form");
	const q = b.quote;
	if (typeof q !== "object" || q === null) throw new HighlightInputError("quote must be an object");
	const qq = q as Record<string, unknown>;
	const quote: HighlightQuote = {
		exact: str(qq.exact, "quote.exact", HIGHLIGHT_LIMITS.exact, false),
		prefix: str(qq.prefix ?? "", "quote.prefix", HIGHLIGHT_LIMITS.context),
		suffix: str(qq.suffix ?? "", "quote.suffix", HIGHLIGHT_LIMITS.context),
		start: typeof qq.start === "number" && Number.isInteger(qq.start) && qq.start >= 0 ? qq.start : 0,
	};
	const color = b.color ?? DEFAULT_HIGHLIGHT_COLOR;
	if (!isHighlightColor(color)) throw new HighlightInputError(`color must be one of: ${HIGHLIGHT_COLORS.join(", ")}`);
	const comment = str(b.comment ?? "", "comment", HIGHLIGHT_LIMITS.comment);
	return { anchor, quote, color, comment };
}

/** The stored record for a PUT: creation time survives updates. */
export function buildHighlight(
	id: string,
	body: HighlightPutBody,
	existing: LessonHighlight | undefined,
	now: string,
): LessonHighlight {
	return { id, ...body, createdAt: existing?.createdAt ?? now, updatedAt: now };
}

// ─── quote location ─────────────────────────────────────────────────────────

/** How many trailing characters of `a` agree with trailing characters of `b`. */
function commonSuffix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
	return n;
}

/** How many leading characters of `a` agree with leading characters of `b`. */
function commonPrefix(a: string, b: string): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n] === b[n]) n++;
	return n;
}

function bestOccurrence(
	text: string,
	exact: string,
	prefix: string,
	suffix: string,
	hint: number,
): number | null {
	let best: number | null = null;
	let bestScore = -1;
	let bestDistance = Infinity;
	for (let at = text.indexOf(exact); at !== -1; at = text.indexOf(exact, at + 1)) {
		const before = text.slice(Math.max(0, at - prefix.length), at);
		const after = text.slice(at + exact.length, at + exact.length + suffix.length);
		const score = commonSuffix(before, prefix) + commonPrefix(after, suffix);
		const distance = Math.abs(at - hint);
		if (score > bestScore || (score === bestScore && distance < bestDistance)) {
			best = at;
			bestScore = score;
			bestDistance = distance;
		}
	}
	return best;
}

/** Whitespace-collapsed copy of `text` with a map back to original offsets. */
function collapseWhitespace(text: string): { text: string; map: number[] } {
	let out = "";
	const map: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const space = /\s/.test(text[i]!);
		if (space && out.endsWith(" ")) continue;
		out += space ? " " : text[i];
		map.push(i);
	}
	return { text: out, map };
}

function collapse(s: string): string {
	return s.replace(/\s+/g, " ");
}

/**
 * Find a quote in an anchor's text: every exact occurrence is scored by
 * how well its surroundings agree with the stored prefix/suffix, ties go
 * to the one nearest the stored offset. When the exact text is gone (a
 * renderer change reflowed whitespace), a whitespace-insensitive pass
 * runs before giving up. null = orphan.
 */
export function locateQuote(text: string, quote: HighlightQuote): { start: number; end: number } | null {
	if (!quote.exact) return null;
	const at = bestOccurrence(text, quote.exact, quote.prefix, quote.suffix, quote.start);
	if (at !== null) return { start: at, end: at + quote.exact.length };
	const exact = collapse(quote.exact).trim();
	if (!exact) return null;
	const flat = collapseWhitespace(text);
	const hint = flat.map.findIndex((orig) => orig >= quote.start);
	const found = bestOccurrence(flat.text, exact, collapse(quote.prefix), collapse(quote.suffix), hint === -1 ? flat.text.length : hint);
	if (found === null) return null;
	return { start: flat.map[found]!, end: flat.map[found + exact.length - 1]! + 1 };
}

/** The quote context for a span of an anchor's text. */
export function quoteFor(text: string, start: number, end: number): HighlightQuote {
	return {
		exact: text.slice(start, end),
		prefix: text.slice(Math.max(0, start - HIGHLIGHT_LIMITS.context), start),
		suffix: text.slice(end, end + HIGHLIGHT_LIMITS.context),
		start,
	};
}

// ─── ordering + export ──────────────────────────────────────────────────────

/** Transcript order: by anchor position, then offset, then creation.
 *  Highlights whose anchor is gone from the record sort last. */
export function orderHighlights(
	messages: readonly LhMessage[],
	list: readonly LessonHighlight[],
	anchors: Map<string, number> = highlightAnchorsOf(messages),
): LessonHighlight[] {
	const pos = (h: LessonHighlight) => anchors.get(h.anchor) ?? Number.POSITIVE_INFINITY;
	return [...list].sort(
		(a, b) => pos(a) - pos(b) || a.quote.start - b.quote.start || a.createdAt.localeCompare(b.createdAt),
	);
}

/**
 * The export's trailing section. Appended ONLY by the Markdown route —
 * sessionMarkdown also feeds extraction, and notes must never reach it.
 * No ids or anchors: the export is for reading.
 */
export function highlightsMarkdown(messages: readonly LhMessage[], list: readonly LessonHighlight[]): string {
	if (list.length === 0) return "";
	const entries = orderHighlights(messages, list).map((h) => {
		const quote = h.quote.exact
			.split("\n")
			.map((line) => (line.trim() ? `> ${line}` : ">"))
			.join("\n");
		const label = HIGHLIGHT_COLOR_LABELS[h.color] ?? h.color;
		const note = h.comment.trim() ? `**${label}:** ${h.comment.trim()}` : `*${label}*`;
		return `${quote}\n\n${note}`;
	});
	return `## Highlights\n\n${entries.join("\n\n")}`;
}
