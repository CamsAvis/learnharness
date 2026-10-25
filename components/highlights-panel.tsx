"use client";

/**
 * LESSON HIGHLIGHTS — the right-side panel (fork feature). Lists the
 * lesson's highlights in transcript order: the quote (click → scroll the
 * transcript to it), the learner's note (autosaves), recolor and delete.
 * Sits below the top bar beside the transcript; on a narrow column it
 * overlays instead of squeezing the transcript.
 */

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { HighlighterIcon, Trash2Icon, XIcon } from "lucide-react";
import type { HighlightColor, LessonHighlight } from "@/src/core";
import { HIGHLIGHT_COLOR_LABELS, HIGHLIGHT_COLORS, orderHighlights } from "@/src/core";
import { MessageResponse } from "@/components/ai-elements/message";
import { timeAgo } from "@/components/sidebar";
import { cn } from "@/lib/utils";
import type { HighlightStatus, LessonHighlightsStore } from "@/components/lesson-highlights-store";
import { SWATCH_CLASS, useHighlightsState, type HighlightNavigator } from "@/components/lesson-highlights";

/** Panel width (px) and the narrowest transcript it may leave beside it. */
export const HIGHLIGHTS_PANEL_W = 320;
const MIN_TRANSCRIPT_W = 640;

/** The quote as markdown: math tokens stay math, everything else is
 *  literal text (markdown punctuation escaped). Literal dollars arrive
 *  already escaped (`\$`, components/highlight-dom.ts), so an unescaped
 *  `$` is always a math token's delimiter. */
export function quoteMarkdown(exact: string): string {
	const escape = (s: string) =>
		s
			.replace(/\\(?!\$)|[`*_[\]<>#|~]/g, (m) => `\\${m}`)
			.replace(/^(\s*)(\d+)([.)])(\s)/gm, "$1$2\\$3$4")
			.replace(/^(\s*)([-+])(\s)/gm, "$1\\$2$3");
	const parts: string[] = [];
	const math = /(?<!\\)\$\$(?:\\.|[^$\\])+\$\$|(?<!\\)\$(?:\\.|[^$\\\n])+\$/g;
	let last = 0;
	for (const m of exact.matchAll(math)) {
		parts.push(escape(exact.slice(last, m.index)), m[0]);
		last = m.index! + m[0].length;
	}
	parts.push(escape(exact.slice(last)));
	return parts.join("");
}

export function HighlightsPanel({
	store,
	nav,
	anchors,
	rowRef,
}: {
	store: LessonHighlightsStore;
	nav: HighlightNavigator;
	/** Anchor key → transcript position (core highlightAnchorsOf). */
	anchors: Map<string, number>;
	/** The row the panel sits in (measured for overlay vs push). */
	rowRef: RefObject<HTMLElement | null>;
}) {
	const state = useHighlightsState(store);
	const [overlay, setOverlay] = useState(false);

	useEffect(() => {
		const row = rowRef.current;
		if (!row || !state.open) return;
		const measure = () => setOverlay(row.clientWidth - HIGHLIGHTS_PANEL_W < MIN_TRANSCRIPT_W);
		measure();
		const ro = new ResizeObserver(measure);
		ro.observe(row);
		return () => ro.disconnect();
	}, [rowRef, state.open]);

	const ordered = useMemo(() => orderHighlights([], state.list, anchors), [state.list, anchors]);
	if (!state.open) return null;
	return <PanelBody state={state} ordered={ordered} store={store} nav={nav} overlay={overlay} />;
}

/** The open panel (exported for render tests). */
export function PanelBody({
	state,
	ordered,
	store,
	nav,
	overlay = false,
}: {
	state: ReturnType<typeof useHighlightsState>;
	ordered: LessonHighlight[];
	store: LessonHighlightsStore;
	nav: HighlightNavigator | null;
	overlay?: boolean;
}) {
	const shown = state.filter ? ordered.filter((h) => h.color === state.filter) : ordered;
	return (
		<aside
			data-hl-panel=""
			data-testid="highlights-panel"
			aria-label="Highlights"
			style={{ width: HIGHLIGHTS_PANEL_W }}
			className={cn(
				"flex min-h-0 shrink-0 flex-col border-l border-border bg-background",
				overlay && "absolute inset-y-0 right-0 z-30 shadow-xl",
			)}
			onKeyDown={(e) => {
				// Esc inside the panel is the panel's: never the abort chain.
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				if (overlay) store.setOpen(false);
				else (document.activeElement as HTMLElement | null)?.blur?.();
			}}
		>
			<div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
				<HighlighterIcon className="size-4 text-primary" aria-hidden />
				<span className="text-sm font-medium">Highlights</span>
				<span className="text-xs tabular-nums text-muted-foreground">{ordered.length}</span>
				<div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label="Filter by color">
					<button
						type="button"
						role="radio"
						aria-checked={state.filter === null}
						data-testid="hl-filter-all"
						onClick={() => store.setFilter(null)}
						className={cn(
							"rounded-full px-1.5 text-[11px] font-medium uppercase tracking-wide transition-colors",
							state.filter === null ? "text-foreground" : "text-muted-foreground hover:text-foreground",
						)}
					>
						All
					</button>
					{HIGHLIGHT_COLORS.map((c) => (
						<button
							key={c}
							type="button"
							role="radio"
							aria-checked={state.filter === c}
							aria-label={`Only ${HIGHLIGHT_COLOR_LABELS[c].toLowerCase()}`}
							title={`Only ${HIGHLIGHT_COLOR_LABELS[c].toLowerCase()}`}
							data-testid={`hl-filter-${c}`}
							onClick={() => store.setFilter(state.filter === c ? null : c)}
							className={cn(
								"size-3.5 rounded-full border border-border/60 transition-transform hover:scale-110",
								SWATCH_CLASS[c],
								state.filter === c && "ring-2 ring-foreground/70 ring-offset-1 ring-offset-background",
							)}
						/>
					))}
				</div>
				<button
					type="button"
					aria-label="Close highlights"
					data-testid="hl-panel-close"
					onClick={() => store.setOpen(false)}
					className="ml-1 flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-4" />
				</button>
			</div>
			{state.error && (
				<div className="flex items-start gap-2 border-b border-border bg-red-500/10 px-3 py-2 text-xs text-red-500" role="alert">
					<span className="min-w-0 flex-1">{state.error}</span>
					<button type="button" className="shrink-0 underline" onClick={() => store.clearError()}>
						Dismiss
					</button>
				</div>
			)}
			<div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2" data-testid="highlights-list">
				{ordered.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-muted-foreground" data-testid="highlights-empty">
						Select text in the lesson, right-click, and choose Highlight.
					</p>
				) : shown.length === 0 ? (
					<p className="px-2 py-6 text-center text-sm text-muted-foreground">
						No {HIGHLIGHT_COLOR_LABELS[state.filter!].toLowerCase()} highlights.
					</p>
				) : (
					shown.map((h) => (
						<HighlightItem
							key={h.id}
							h={h}
							status={state.status.get(h.id) ?? "pending"}
							selected={state.selectedId === h.id}
							focusComment={state.focusCommentId === h.id}
							store={store}
							nav={nav}
						/>
					))
				)}
			</div>
		</aside>
	);
}

function HighlightItem({
	h,
	status,
	selected,
	focusComment,
	store,
	nav,
}: {
	h: LessonHighlight;
	status: HighlightStatus;
	selected: boolean;
	focusComment: boolean;
	store: LessonHighlightsStore;
	nav: HighlightNavigator | null;
}) {
	const rootRef = useRef<HTMLDivElement>(null);
	const noteRef = useRef<HTMLTextAreaElement>(null);
	const [expanded, setExpanded] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const orphan = status === "orphan";
	const long = h.quote.exact.length > 220 || h.quote.exact.split("\n").length > 4;

	// The one-shot "focus my note" request (a new highlight, or Edit note).
	useEffect(() => {
		if (!focusComment) return;
		rootRef.current?.scrollIntoView({ block: "nearest" });
		noteRef.current?.focus();
		store.clearFocusRequest();
	}, [focusComment, store]);

	// A click on the highlight in the transcript selects this item.
	useEffect(() => {
		if (selected) rootRef.current?.scrollIntoView({ block: "nearest" });
	}, [selected]);

	const jump = () => {
		if (orphan) return;
		store.select(h.id);
		nav?.jump(h.id);
	};

	const remove = () => {
		if (h.comment.trim() && !confirmDelete) {
			setConfirmDelete(true);
			return;
		}
		store.remove(h.id);
	};

	return (
		<div
			ref={rootRef}
			data-testid="highlight-item"
			data-highlight-id={h.id}
			data-status={status}
			className={cn(
				"flex overflow-hidden rounded-lg border bg-card transition-shadow",
				selected ? "border-primary/50 ring-1 ring-primary/40" : "border-border",
			)}
		>
			<div aria-hidden className={cn("w-1 shrink-0", SWATCH_CLASS[h.color])} />
			<div className="min-w-0 flex-1 p-2.5">
				{/* A div, not a <button>: the rendered quote may contain Streamdown's
				    link buttons, and buttons can't nest. */}
				<div
					role="button"
					tabIndex={orphan ? -1 : 0}
					aria-disabled={orphan || undefined}
					data-testid="highlight-quote"
					title={orphan ? undefined : "Show in the lesson"}
					onClick={jump}
					onKeyDown={(e) => {
						if (e.key !== "Enter" && e.key !== " ") return;
						// Claimed here: Enter must not also submit a pending question.
						e.preventDefault();
						e.stopPropagation();
						jump();
					}}
					className={cn(
						"block w-full text-left text-sm outline-none focus-visible:ring-1 focus-visible:ring-ring",
						orphan ? "cursor-default text-muted-foreground" : "cursor-pointer hover:text-foreground",
					)}
				>
					<MessageResponse
						mode="static"
						className={cn("lh-prose pointer-events-none text-sm [&_p]:my-0", !expanded && long && "line-clamp-4")}
					>
						{quoteMarkdown(h.quote.exact)}
					</MessageResponse>
				</div>
				{long && (
					<button
						type="button"
						onClick={() => setExpanded((v) => !v)}
						className="mt-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
					>
						{expanded ? "less" : "more"}
					</button>
				)}
				{orphan && (
					<div className="mt-1 text-xs text-muted-foreground" data-testid="highlight-orphan">
						Couldn&apos;t find this text in the lesson anymore.
					</div>
				)}
				<textarea
					ref={noteRef}
					data-testid="highlight-note"
					value={h.comment}
					rows={1}
					placeholder="Add a note…"
					aria-label="Note"
					onFocus={() => store.select(h.id)}
					onChange={(e) => store.setComment(h.id, e.target.value)}
					onBlur={() => store.flush(h.id)}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							e.preventDefault();
							e.stopPropagation();
							e.currentTarget.blur();
						}
					}}
					className="field-sizing-content lh-input mt-2 max-h-48 min-h-8 w-full resize-none rounded-md border border-border/70 bg-background/60 px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground focus:border-primary/50"
				/>
				<div className="mt-1.5 flex items-center gap-2 text-xs text-muted-foreground">
					<span>{timeAgo(h.createdAt)}</span>
					<div className="ml-auto flex items-center gap-1" role="radiogroup" aria-label="Color">
						{HIGHLIGHT_COLORS.map((c: HighlightColor) => (
							<button
								key={c}
								type="button"
								role="radio"
								aria-checked={h.color === c}
								aria-label={HIGHLIGHT_COLOR_LABELS[c]}
								title={HIGHLIGHT_COLOR_LABELS[c]}
								onClick={() => store.setColor(h.id, c)}
								className={cn(
									"size-3 rounded-full border border-border/60 transition-transform hover:scale-125",
									SWATCH_CLASS[c],
									h.color === c && "ring-1 ring-foreground/70 ring-offset-1 ring-offset-card",
								)}
							/>
						))}
					</div>
					{confirmDelete ? (
						<span className="flex items-center gap-1.5">
							<button type="button" className="font-medium text-red-500" onClick={remove} data-testid="highlight-delete-confirm">
								Delete with note
							</button>
							<button type="button" onClick={() => setConfirmDelete(false)}>
								Cancel
							</button>
						</span>
					) : (
						<button
							type="button"
							aria-label="Delete highlight"
							title="Delete highlight"
							data-testid="highlight-delete"
							onClick={remove}
							className="flex size-6 items-center justify-center rounded-md transition-colors hover:bg-accent hover:text-red-500"
						>
							<Trash2Icon className="size-3.5" />
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
