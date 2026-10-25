"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpIcon, XIcon } from "lucide-react";
import { MessageResponse } from "@/components/ai-elements/message";
import { Shimmer } from "@/components/ai-elements/shimmer";
import { cn } from "@/lib/utils";
import { CLARIFY_MAX_CHARS, CLARIFY_MAX_EXCHANGES, type ClarifyExchange } from "@/src/core";

/**
 * THE QUESTION SIDE CHAT: while a question waits, the learner can ask a
 * separate helper what it means ("what do you mean by X?") before
 * answering. The helper explains wording and terms, never the answer; the
 * thread is saved per question and rides the answer to the teacher.
 *
 * useClarifier owns the thread for the open question (loaded from the
 * record, so it survives reloads); ClarifierPanel renders it. The dock
 * opens the panel beside the question on wide screens (the two share the
 * width), inline in the question card on narrow ones.
 */

export interface ClarifierState {
	thread: ClarifyExchange[];
	/** The learner's message while its reply is being written. */
	pendingAsk: string | null;
	error: string | null;
	open: boolean;
	/** The learner's open/close (the toggle, the close button, Esc). */
	setOpen: (open: boolean) => void;
	/** True once per learner-opened panel: the panel that mounts for it
	 *  takes focus. Auto-opens (a saved thread on reload) and placement
	 *  switches (resizing across the margin threshold) don't. */
	takeFocus: () => boolean;
	/** The unsent message. Lives here, not in the panel, so it survives the
	 *  panel moving between the margin and the card (or folding away). */
	draft: string;
	setDraft: (draft: string | ((prev: string) => string)) => void;
	/** Send one message. A refused message goes back to the draft (unless
	 *  the learner already typed something else, or moved to another question). */
	ask: (text: string) => Promise<void>;
}

/** The side chat for the open question (toolCallId null = none open). */
export function useClarifier(chatId: string, toolCallId: string | null, onReplied?: () => void): ClarifierState {
	const [thread, setThread] = useState<ClarifyExchange[]>([]);
	const [pendingAsk, setPendingAsk] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [open, setOpenState] = useState(false);
	const [draft, setDraft] = useState("");
	// Per question: the learner already opened/closed the panel (the saved
	// thread's load must not reopen it), already sent a message (the load
	// must not overwrite the newer thread), and a focus request.
	const toggledRef = useRef(false);
	const askedRef = useRef(false);
	const focusRef = useRef(false);
	// The question the in-flight request belongs to: a reply that lands
	// after the question changed must not paint onto the next one.
	const currentRef = useRef(toolCallId);
	currentRef.current = toolCallId;
	const abortRef = useRef<AbortController | null>(null);
	const onRepliedRef = useRef(onReplied);
	onRepliedRef.current = onReplied;

	useEffect(() => {
		setThread([]);
		setPendingAsk(null);
		setError(null);
		setOpenState(false);
		setDraft("");
		toggledRef.current = false;
		askedRef.current = false;
		focusRef.current = false;
		if (!toolCallId) return;
		const ctrl = new AbortController();
		void (async () => {
			try {
				const res = await fetch(`/api/chats/${chatId}/clarify?toolCallId=${encodeURIComponent(toolCallId)}`, {
					signal: ctrl.signal,
				});
				if (!res.ok) return;
				const body = (await res.json()) as { thread?: ClarifyExchange[] };
				if (currentRef.current !== toolCallId || !Array.isArray(body.thread) || askedRef.current) return;
				setThread(body.thread);
				// A question that already has a side chat reopens with it.
				if (body.thread.length > 0 && !toggledRef.current) setOpenState(true);
			} catch {
				// offline / aborted: the panel starts empty
			}
		})();
		return () => {
			ctrl.abort();
			abortRef.current?.abort();
			abortRef.current = null;
		};
	}, [chatId, toolCallId]);

	const setOpen = useCallback((next: boolean) => {
		toggledRef.current = true;
		focusRef.current = next;
		setOpenState(next);
	}, []);

	const takeFocus = useCallback(() => {
		const take = focusRef.current;
		focusRef.current = false;
		return take;
	}, []);

	const ask = useCallback(
		async (text: string): Promise<void> => {
			const asked = text.trim();
			const id = currentRef.current;
			if (!asked || !id || abortRef.current) return;
			const ctrl = new AbortController();
			abortRef.current = ctrl;
			askedRef.current = true;
			setPendingAsk(asked);
			setError(null);
			let sent = false;
			try {
				const res = await fetch(`/api/chats/${chatId}/clarify`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ toolCallId: id, text: asked }),
					signal: ctrl.signal,
				});
				const body = (await res.json().catch(() => ({}))) as { thread?: ClarifyExchange[]; error?: string };
				if (currentRef.current !== id) return;
				if (!res.ok || !Array.isArray(body.thread)) {
					setError(body.error ?? `The side chat failed (${res.status}).`);
					return;
				}
				setThread(body.thread);
				sent = true;
				onRepliedRef.current?.();
			} catch (err) {
				if (currentRef.current === id && !(err instanceof DOMException && err.name === "AbortError"))
					setError("Couldn't reach the server. Try again.");
			} finally {
				if (abortRef.current === ctrl) abortRef.current = null;
				// Only the same question gets its refused message back: after a
				// question change the draft belongs to the new one.
				if (currentRef.current === id) {
					setPendingAsk(null);
					if (!sent) setDraft((d) => d || asked);
				}
			}
		},
		[chatId],
	);

	return { thread, pendingAsk, error, open, setOpen, takeFocus, draft, setDraft, ask };
}

export function ClarifierPanel({
	state,
	variant,
	className,
	style,
}: {
	state: ClarifierState;
	/** "side": its own card beside the question (wide screens). "inline": inside the question card. */
	variant: "side" | "inline";
	className?: string;
	style?: React.CSSProperties;
}) {
	const { thread, pendingAsk, error, ask, setOpen, takeFocus, draft, setDraft } = state;
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const full = thread.length >= CLARIFY_MAX_EXCHANGES;
	const busy = pendingAsk !== null;

	// Opening the panel (the learner's click) puts the cursor in it.
	useEffect(() => {
		if (takeFocus()) inputRef.current?.focus({ preventScroll: true });
	}, [takeFocus]);
	// Keep the newest message in view: the list scrolls itself; inline, the
	// question area scrolls just enough to show the input. Only that one
	// container moves (scrollIntoView would also shift the dock's
	// overflow-hidden ancestors).
	useEffect(() => {
		const list = listRef.current;
		if (list) list.scrollTop = list.scrollHeight;
		if (variant !== "inline") return;
		const field = inputRef.current;
		const area = field?.closest<HTMLElement>("[data-session-find-root]");
		if (!field || !area) return;
		const over = field.getBoundingClientRect().bottom - area.getBoundingClientRect().bottom;
		if (over > 0) area.scrollTop += over + 8;
	}, [thread.length, pendingAsk, error, variant]);

	const send = async () => {
		const text = draft.trim();
		if (!text || busy || full) return;
		setDraft("");
		await ask(text);
		inputRef.current?.focus({ preventScroll: true });
	};

	return (
		<div
			data-testid="clarifier-panel"
			data-clarifier-panel=""
			data-variant={variant}
			onKeyDown={(e) => {
				// Esc anywhere in the side chat closes it, and must not reach
				// the window chain (that would skip the question).
				if (e.key !== "Escape") return;
				e.preventDefault();
				e.stopPropagation();
				setOpen(false);
			}}
			className={cn(
				"flex min-h-0 flex-col",
				variant === "side" ? "rounded-2xl border bg-card shadow-lg" : "mb-3 rounded-xl border border-border/70 bg-background/60",
				className,
			)}
			style={style}
		>
			<div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
				<span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">About this question</span>
				<button
					type="button"
					aria-label="Close the side chat"
					onClick={() => setOpen(false)}
					className="ml-auto rounded-sm p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<XIcon className="size-3.5" />
				</button>
			</div>
			<div
				ref={listRef}
				className={cn("flex min-h-0 flex-col gap-2.5 overflow-y-auto px-3 pb-2 text-sm", variant === "inline" ? "max-h-56" : "flex-1")}
			>
				{thread.length === 0 && !busy && (
					<p className="text-xs text-muted-foreground">
						Ask what a word, symbol or part of the question means. This helper won&apos;t give you the answer, and your tutor
						sees this chat along with your answer.
					</p>
				)}
				{thread.map((ex, i) => (
					<Exchange key={`${i}:${ex.at}`} asked={ex.asked} reply={ex.reply} />
				))}
				{busy && <Exchange asked={pendingAsk} />}
				{error && (
					<p role="alert" data-testid="clarifier-error" className="text-xs text-red-500">
						{error}
					</p>
				)}
			</div>
			<form
				className="p-1.5 pt-0"
				onSubmit={(e) => {
					e.preventDefault();
					void send();
				}}
			>
				<div className="flex items-end gap-1 rounded-[10px] border border-border/70 bg-background/60 transition-colors focus-within:border-primary/50">
					<textarea
						ref={inputRef}
						data-testid="clarifier-input"
						value={draft}
						maxLength={CLARIFY_MAX_CHARS}
						disabled={full}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
								e.preventDefault();
								e.stopPropagation();
								void send();
							}
						}}
						placeholder={full ? "That's the limit for this question." : "What do you mean by…?"}
						rows={1}
						className="field-sizing-content lh-input max-h-32 min-h-9 w-full resize-none bg-transparent px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground/70"
					/>
					<button
						type="submit"
						aria-label="Ask"
						disabled={!draft.trim() || busy || full}
						className="m-1 flex size-7 shrink-0 items-center justify-center rounded-[6px] bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
					>
						<ArrowUpIcon className="size-4" />
					</button>
				</div>
			</form>
		</div>
	);
}

/** One learner message and the helper's reply (absent while it's written). */
function Exchange({ asked, reply }: { asked: string; reply?: string }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="ml-6 self-end whitespace-pre-wrap rounded-lg bg-accent px-2.5 py-1.5">{asked}</div>
			{reply === undefined ? (
				<Shimmer duration={1} className="text-xs">
					Thinking…
				</Shimmer>
			) : (
				<MessageResponse className="lh-prose">{reply}</MessageResponse>
			)}
		</div>
	);
}
