"use client";

/**
 * LESSON HIGHLIGHTS — the React layer (fork feature): the per-lesson store
 * hook, the transcript layer (painter + right-click menu + click-to-select)
 * and the top-bar chip. The panel lives in components/highlights-panel.tsx.
 *
 * Right-click inside the transcript with text selected → our menu
 * (Highlight in one of four colors, Copy). Right-click on an existing
 * highlight with nothing selected → its menu (Edit note, recolor, Copy,
 * Remove). Anywhere else the browser's own menu shows. A plain click on
 * highlighted text selects its item in the panel.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";
import { createPortal } from "react-dom";
import { CopyIcon, HighlighterIcon, PencilIcon, Trash2Icon } from "lucide-react";
import type { StickToBottomContext } from "use-stick-to-bottom";
import type { HighlightColor, LessonHighlight } from "@/src/core";
import { HIGHLIGHT_COLOR_LABELS, HIGHLIGHT_COLORS } from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { scrollSessionTarget } from "@/components/session-navigation";
import { copyText } from "@/components/md-blocks";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { pointInRects, selectionQuote, type SelectionQuoteResult } from "@/components/highlight-dom";
import { LessonHighlightsStore, type LessonHighlightsState } from "@/components/lesson-highlights-store";
import { LessonHighlightsPainter, liveRange } from "@/components/lesson-highlights-painter";
import { cn } from "@/lib/utils";

const useIsoLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/** Swatch fill per color (the menu + panel dots): the theme token, solid. */
export const SWATCH_CLASS: Readonly<Record<HighlightColor, string>> = {
	yellow: "bg-[var(--lh-hl-yellow-solid)]",
	green: "bg-[var(--lh-hl-green-solid)]",
	blue: "bg-[var(--lh-hl-blue-solid)]",
	pink: "bg-[var(--lh-hl-pink-solid)]",
};

/** Quote text for the clipboard: literal dollars unescaped (the text map
 *  writes them `\$`; math stays as its `$tex$` source). */
export function plainQuote(exact: string): string {
	return exact.replace(/\\\$/g, "$");
}

/** Jumping + the painter handle, shared by the layer and the panel. */
export class HighlightNavigator {
	painter: LessonHighlightsPainter | null = null;
	scopeRef: RefObject<HTMLElement | null> | null = null;
	scrollContextRef: RefObject<StickToBottomContext | null> | null = null;

	/** Scroll the transcript to a highlight and flash it. False = not found. */
	jump(id: string): boolean {
		const painter = this.painter;
		const scope = this.scopeRef?.current;
		if (!painter || !scope) return false;
		const range = liveRange(painter.specsOf(id));
		if (!range) return false;
		scrollSessionTarget(range, scope, this.scrollContextRef?.current ?? null);
		painter.flash(id);
		return true;
	}
}

/** The per-lesson store + navigator, wired to server sync and page hide. */
export function useLessonHighlights(chatId: string, initial: readonly LessonHighlight[]) {
	const ref = useRef<{ store: LessonHighlightsStore; nav: HighlightNavigator } | null>(null);
	if (ref.current === null) ref.current = { store: new LessonHighlightsStore(chatId, initial), nav: new HighlightNavigator() };
	const { store, nav } = ref.current;

	// The remembered panel state, read before paint (no column jump).
	useIsoLayoutEffect(() => {
		store.hydrateOpen();
	}, [store]);

	// A cached page (back/forward) may carry an old list: re-sync once.
	useEffect(() => {
		void store.sync();
	}, [store]);

	// Another tab changed this lesson's highlights — or the event stream
	// reconnected and such news may have been missed.
	useServerEvent("highlights-changed", (p) => {
		if (p.chatId === chatId && p.source !== store.tabId) void store.sync();
	});
	useServerResync(() => void store.sync());

	// Unsaved note edits ride out with the page.
	useEffect(() => {
		const onHide = () => store.flush(undefined, true);
		window.addEventListener("pagehide", onHide);
		return () => {
			window.removeEventListener("pagehide", onHide);
			store.flush(undefined, true);
		};
	}, [store]);

	return { store, nav };
}

export function useHighlightsState(store: LessonHighlightsStore): LessonHighlightsState {
	return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

type MenuState =
	| { kind: "selection"; x: number; y: number; result: SelectionQuoteResult; copy: string }
	| { kind: "highlight"; x: number; y: number; id: string };

/**
 * The transcript layer: mounts the painter on the transcript root and owns
 * the right-click menu and click-to-select. Renders only the menu.
 */
export function HighlightLayer({
	store,
	nav,
	rootRef,
	scopeRef,
	scrollContextRef,
	allowed,
}: {
	store: LessonHighlightsStore;
	nav: HighlightNavigator;
	/** The transcript root ([data-session-find-root]). */
	rootRef: RefObject<HTMLElement | null>;
	/** The session scope (scroll containers live inside it). */
	scopeRef: RefObject<HTMLElement | null>;
	scrollContextRef: RefObject<StickToBottomContext | null>;
	/** Anchor keys that may be highlighted now (saved, settled text). */
	allowed: { has(key: string): boolean };
}) {
	const [menu, setMenu] = useState<MenuState | null>(null);
	const allowedRef = useRef(allowed);
	allowedRef.current = allowed;
	/** The last right-button press: when, and whether the selection was
	 *  collapsed then (macOS selects the word under a right-click before
	 *  contextmenu fires). No recent press = a keyboard-opened menu. */
	const rightDownRef = useRef<{ at: number; collapsed: boolean } | null>(null);

	nav.scopeRef = scopeRef;
	nav.scrollContextRef = scrollContextRef;

	useEffect(() => {
		const root = rootRef.current;
		if (!root) return;
		const painter = new LessonHighlightsPainter(root, store);
		nav.painter = painter;

		const onPointerDown = (e: PointerEvent) => {
			// Right button, or macOS Ctrl+click (also opens the context menu).
			if (e.button === 2 || (e.button === 0 && e.ctrlKey)) {
				rightDownRef.current = { at: performance.now(), collapsed: window.getSelection()?.isCollapsed ?? true };
			}
		};

		const onContextMenu = (e: MouseEvent) => {
			const down = rightDownRef.current;
			rightDownRef.current = null;
			const viaMouse = !!down && performance.now() - down.at < 1500;
			const sel = window.getSelection();
			const range = sel && sel.rangeCount > 0 && !sel.isCollapsed ? sel.getRangeAt(0) : null;
			// The click must land ON the selection for the menu to act on it.
			const onSelection = !!range && (!viaMouse || pointInRects(range.getClientRects(), e.clientX, e.clientY));
			// A right-click on an existing highlight (no selection under the
			// pointer before the click) acts on the highlight.
			if (viaMouse && (down.collapsed || !onSelection)) {
				const ids = painter.hitTest(e.clientX, e.clientY, e.target as Node | null);
				if (ids.length > 0) {
					e.preventDefault();
					setMenu({ kind: "highlight", x: e.clientX, y: e.clientY, id: ids[0]! });
					return;
				}
			}
			if (!range || !onSelection || !range.intersectsNode(root)) return; // the browser's own menu
			e.preventDefault();
			// Computed NOW: opening the menu moves focus and may collapse the selection.
			const result = selectionQuote(range, root, allowedRef.current);
			const copy = result.ok ? plainQuote(result.quote.exact) : sel!.toString();
			let { clientX: x, clientY: y } = e;
			if (!viaMouse) {
				// Keyboard (menu key / Shift+F10): open at the selection.
				const rect = range.getBoundingClientRect();
				x = rect.left;
				y = rect.bottom;
			}
			setMenu({ kind: "selection", x, y, result, copy });
		};

		// A plain click on highlighted text selects its panel item (never on
		// links/buttons, never when the click ended a text selection).
		const onClick = (e: MouseEvent) => {
			if (e.button !== 0 || e.defaultPrevented) return;
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed) return;
			const target = e.target as Element | null;
			if (target?.closest?.("a, button, input, textarea, select, [role='button']")) return;
			const ids = painter.hitTest(e.clientX, e.clientY, target);
			if (ids.length > 0) store.select(ids[0]!);
		};

		root.addEventListener("pointerdown", onPointerDown);
		root.addEventListener("contextmenu", onContextMenu);
		root.addEventListener("click", onClick);
		return () => {
			root.removeEventListener("pointerdown", onPointerDown);
			root.removeEventListener("contextmenu", onContextMenu);
			root.removeEventListener("click", onClick);
			painter.destroy();
			if (nav.painter === painter) nav.painter = null;
		};
	}, [rootRef, store, nav]);

	const close = useCallback(() => setMenu(null), []);

	// Dismissal: outside pointerdown, the reader scrolling (wheel/touch —
	// not `scroll`, which also fires for the automatic follow-the-reply
	// scroll while a turn streams), Esc (claimed here so it never reaches
	// the abort-turn / dismiss-question chain).
	useEffect(() => {
		if (!menu) return;
		const outside = (e: Event) => !(e.target as Element | null)?.closest?.("[data-lh-menu]");
		const onDown = (e: PointerEvent) => {
			if (outside(e)) close();
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.preventDefault();
			e.stopPropagation();
			close();
		};
		const onUserScroll = (e: Event) => {
			if (outside(e)) close();
		};
		document.addEventListener("pointerdown", onDown, true);
		document.addEventListener("keydown", onKey);
		window.addEventListener("wheel", onUserScroll, { capture: true, passive: true });
		window.addEventListener("touchmove", onUserScroll, { capture: true, passive: true });
		return () => {
			document.removeEventListener("pointerdown", onDown, true);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("wheel", onUserScroll, { capture: true });
			window.removeEventListener("touchmove", onUserScroll, { capture: true });
		};
	}, [menu, close]);

	if (!menu) return null;
	// Keyed by position: a menu reopened in place (keyboard) must re-place.
	const key = `${menu.kind}:${menu.x}:${menu.y}:${menu.kind === "highlight" ? menu.id : ""}`;
	return <HighlightMenu key={key} menu={menu} store={store} onClose={close} />;
}

function MenuItem({
	onSelect,
	disabled,
	children,
	testid,
	danger,
}: {
	onSelect: () => void;
	disabled?: boolean;
	children: React.ReactNode;
	testid?: string;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			data-testid={testid}
			disabled={disabled}
			// Keep the text selection alive until the action runs.
			onMouseDown={(e) => e.preventDefault()}
			onClick={onSelect}
			className={cn(
				"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none transition-colors",
				disabled ? "cursor-default text-muted-foreground/60" : "cursor-pointer hover:bg-accent focus-visible:bg-accent",
				danger && !disabled && "text-red-500",
			)}
		>
			{children}
		</button>
	);
}

function Swatches({
	current,
	onPick,
	disabled,
	testid,
}: {
	current?: HighlightColor;
	onPick: (c: HighlightColor) => void;
	disabled?: boolean;
	testid: string;
}) {
	return (
		<div className="flex items-center gap-1.5 px-2 py-1.5" data-testid={testid}>
			{HIGHLIGHT_COLORS.map((c) => (
				<button
					key={c}
					type="button"
					role="menuitemradio"
					aria-checked={current === c}
					aria-label={HIGHLIGHT_COLOR_LABELS[c]}
					title={HIGHLIGHT_COLOR_LABELS[c]}
					disabled={disabled}
					data-color={c}
					onMouseDown={(e) => e.preventDefault()}
					onClick={() => onPick(c)}
					className={cn(
						"size-5 rounded-full border border-border/60 outline-none transition-transform",
						SWATCH_CLASS[c],
						disabled ? "cursor-default opacity-40" : "cursor-pointer hover:scale-110 focus-visible:ring-2 focus-visible:ring-ring",
						current === c && "ring-2 ring-foreground/70 ring-offset-1 ring-offset-popover",
					)}
				/>
			))}
		</div>
	);
}

function HighlightMenu({ menu, store, onClose }: { menu: MenuState; store: LessonHighlightsStore; onClose: () => void }) {
	const anchorRef = useRef<HTMLDivElement | null>(null);
	const [anchorReady, setAnchorReady] = useState(false);
	useEffect(() => setAnchorReady(true), []);

	const create = (color: HighlightColor) => {
		if (menu.kind !== "selection" || !menu.result.ok) return;
		store.create({ anchor: menu.result.anchor, quote: menu.result.quote, color });
		window.getSelection()?.removeAllRanges();
		onClose();
	};

	let body: React.ReactNode;
	if (menu.kind === "selection") {
		const r = menu.result;
		body = (
			<>
				<MenuItem testid="hl-menu-highlight" disabled={!r.ok} onSelect={() => create("yellow")}>
					<HighlighterIcon className="size-4 shrink-0" aria-hidden />
					Highlight
				</MenuItem>
				{r.ok ? (
					<Swatches testid="hl-menu-colors" onPick={create} />
				) : (
					<div className="px-2 pb-1.5 text-xs text-muted-foreground" data-testid="hl-menu-reason">
						{r.reason}
					</div>
				)}
				<div className="my-1 h-px bg-border" />
				<MenuItem
					testid="hl-menu-copy"
					onSelect={() => {
						void copyText(menu.copy);
						onClose();
					}}
				>
					<CopyIcon className="size-4 shrink-0" aria-hidden />
					Copy
				</MenuItem>
			</>
		);
	} else {
		const h = store.get(menu.id);
		if (!h) return null;
		body = (
			<>
				<MenuItem
					testid="hl-menu-edit"
					onSelect={() => {
						store.select(h.id, { focusComment: true });
						onClose();
					}}
				>
					<PencilIcon className="size-4 shrink-0" aria-hidden />
					{h.comment.trim() ? "Edit note" : "Add note"}
				</MenuItem>
				<Swatches
					testid="hl-menu-recolor"
					current={h.color}
					onPick={(c) => {
						store.setColor(h.id, c);
						onClose();
					}}
				/>
				<MenuItem
					testid="hl-menu-copy"
					onSelect={() => {
						void copyText(plainQuote(h.quote.exact));
						onClose();
					}}
				>
					<CopyIcon className="size-4 shrink-0" aria-hidden />
					Copy text
				</MenuItem>
				<div className="my-1 h-px bg-border" />
				<MenuItem
					testid="hl-menu-remove"
					danger
					onSelect={() => {
						store.remove(h.id);
						onClose();
					}}
				>
					<Trash2Icon className="size-4 shrink-0" aria-hidden />
					Remove highlight
				</MenuItem>
			</>
		);
	}

	return (
		<>
			{createPortal(
				<div
					ref={anchorRef}
					aria-hidden
					style={{ position: "fixed", left: menu.x, top: menu.y, width: 0, height: 0, pointerEvents: "none" }}
				/>,
				document.body,
			)}
			{anchorReady && (
				<MenuShell
					anchorRef={anchorRef}
					testid="hl-menu"
					preferredSide="down"
					align="left"
					menuClass="w-52 rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
				>
					<div role="menu" aria-label="Highlight">
						{body}
					</div>
				</MenuShell>
			)}
		</>
	);
}

/** The top-bar toggle: highlighter icon + count. */
export function HighlightsChip({ store }: { store: LessonHighlightsStore }) {
	const { list, open } = useHighlightsState(store);
	return (
		<Hint label={open ? "Hide highlights" : "Show highlights"} side="bottom">
			<button
				type="button"
				data-testid="highlights-chip"
				aria-pressed={open}
				onClick={(e) => {
					blurAfterPointerClick(e);
					store.setOpen(!open);
				}}
				className={cn(
					"lh-no-drag flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium uppercase tracking-wide transition-colors",
					open
						? "border-border text-foreground"
						: "border-border/80 text-muted-foreground hover:border-border hover:text-foreground",
				)}
			>
				<HighlighterIcon className="size-3.5 text-primary" aria-hidden />
				<span className="tabular-nums" aria-label={`${list.length} highlight${list.length === 1 ? "" : "s"}`}>
					{list.length}
				</span>
			</button>
		</Hint>
	);
}
