/**
 * LESSON HIGHLIGHTS — the painter (fork feature). Finds each highlight's
 * text in the transcript and paints it with the CSS Custom Highlight API —
 * the transcript markup itself is never touched (React owns it).
 *
 * Re-finding is incremental: a MutationObserver on the transcript root
 * marks the anchor elements whose subtree changed; each animation frame
 * only rebuilds the text maps of dirty anchors that carry highlights. New
 * or replaced anchor elements (a remount after a turn settles, a plan
 * block spliced in) are new map-cache keys, so they rebuild by themselves.
 * Painting uses StaticRanges (a live Range silently collapses when its
 * nodes are replaced, and costs the engine work on every streamed token).
 */

import type { HighlightColor, LessonHighlight } from "@/src/core";
import { HIGHLIGHT_COLORS, locateQuote } from "@/src/core";
import {
	anchorElements,
	buildTextMap,
	HL_ANCHOR_ATTR,
	pointInRects,
	rangeSpecs,
	type AnchorTextMap,
	type RangeSpec,
} from "@/components/highlight-dom";
import type { HighlightStatus, LessonHighlightsStore } from "@/components/lesson-highlights-store";

export const HIGHLIGHT_NAME: Readonly<Record<HighlightColor, string>> = {
	yellow: "lh-hl-yellow",
	green: "lh-hl-green",
	blue: "lh-hl-blue",
	pink: "lh-hl-pink",
};
export const HIGHLIGHT_FLASH_NAME = "lh-hl-flash";

/** ::highlight() rules ship as a <style> tag (Tailwind v4 rejects them in
 *  globals.css — the session-find precedent). Colors are theme tokens
 *  (--lh-hl-*) defined per theme in app/globals.css. */
const STYLE_ID = "lh-lesson-highlights-style";
function injectStyles(): void {
	if (document.getElementById(STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = STYLE_ID;
	style.textContent = [
		...HIGHLIGHT_COLORS.map((c) => `::highlight(${HIGHLIGHT_NAME[c]}) { background-color: var(--lh-hl-${c}); }`),
		`::highlight(${HIGHLIGHT_FLASH_NAME}) { background-color: var(--lh-hl-flash); }`,
	].join("\n");
	document.head.appendChild(style);
}

function highlightApi(): { registry: HighlightRegistry; make: () => Highlight } | null {
	if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return null;
	return { registry: CSS.highlights, make: () => new Highlight() };
}

function toStatic(spec: RangeSpec): AbstractRange | null {
	try {
		return new StaticRange(spec);
	} catch {
		return null;
	}
}

/** A live Range over a spec list (for rects and scrolling); null if stale. */
export function liveRange(specs: readonly RangeSpec[]): Range | null {
	if (specs.length === 0) return null;
	const first = specs[0]!;
	const last = specs[specs.length - 1]!;
	if (!first.startContainer.isConnected || !last.endContainer.isConnected) return null;
	try {
		const range = document.createRange();
		range.setStart(first.startContainer, first.startOffset);
		range.setEnd(last.endContainer, last.endOffset);
		return range;
	} catch {
		return null;
	}
}

function paintSignature(list: readonly { id: string; color: HighlightColor }[]): string {
	return list.map((h) => `${h.id}:${h.color}`).join("|");
}

interface Resolved {
	element: Element;
	map: AnchorTextMap;
	specs: RangeSpec[];
}

export class LessonHighlightsPainter {
	private readonly root: HTMLElement;
	private readonly store: LessonHighlightsStore;
	private readonly observer: MutationObserver;
	private readonly unsubscribe: () => void;
	private readonly api = highlightApi();
	private readonly painted = new Map<string, Highlight>();
	private maps = new WeakMap<Element, AnchorTextMap>();
	private resolved = new Map<string, Resolved>();
	private raf = 0;
	private timer = 0;
	private flashTimer = 0;
	private lastList: unknown = null;
	/** Ids + colors last painted: note edits change neither, so they never repaint. */
	private paintedSig = "";
	/** Anchor keys that carry highlights (mutations elsewhere inside an
	 *  anchor — a streaming reply — need no re-find). */
	private highlighted = new Set<string>();
	private destroyed = false;

	constructor(root: HTMLElement, store: LessonHighlightsStore) {
		this.root = root;
		this.store = store;
		if (this.api) {
			injectStyles();
			for (const color of HIGHLIGHT_COLORS) {
				const h = this.api.make();
				// Below Session Find (0/1): a find match always paints on top.
				h.priority = -2;
				this.api.registry.set(HIGHLIGHT_NAME[color], h);
				this.painted.set(color, h);
			}
			const flash = this.api.make();
			flash.priority = -1;
			this.api.registry.set(HIGHLIGHT_FLASH_NAME, flash);
			this.painted.set("flash", flash);
		}
		this.observer = new MutationObserver((records) => {
			let relevant = false;
			for (const r of records) {
				const target = r.target.nodeType === 1 ? (r.target as Element) : r.target.parentElement;
				const anchor = target?.closest(`[${HL_ANCHOR_ATTR}]`);
				if (anchor) {
					this.maps.delete(anchor);
					if (this.highlighted.has(anchor.getAttribute(HL_ANCHOR_ATTR) ?? "")) relevant = true;
				} else {
					// Outside every anchor: anchors may have been added, removed or
					// replaced (a remount) — re-find.
					relevant = true;
				}
			}
			if (relevant) this.schedule();
		});
		this.observer.observe(root, { childList: true, characterData: true, subtree: true });
		this.unsubscribe = store.subscribe(() => {
			if (store.getSnapshot().list !== this.lastList) this.schedule();
		});
		this.schedule();
	}

	destroy(): void {
		this.destroyed = true;
		cancelAnimationFrame(this.raf);
		window.clearTimeout(this.timer);
		window.clearTimeout(this.flashTimer);
		this.observer.disconnect();
		this.unsubscribe();
		if (this.api) {
			for (const color of HIGHLIGHT_COLORS) this.api.registry.delete(HIGHLIGHT_NAME[color]);
			this.api.registry.delete(HIGHLIGHT_FLASH_NAME);
		}
	}

	/** One batched run per frame — with a timer fallback, because hidden
	 *  and background tabs pause animation frames entirely. */
	private schedule(): void {
		if (this.destroyed || this.raf || this.timer) return;
		const go = () => {
			cancelAnimationFrame(this.raf);
			window.clearTimeout(this.timer);
			this.raf = 0;
			this.timer = 0;
			this.run();
		};
		this.raf = requestAnimationFrame(go);
		this.timer = window.setTimeout(go, 250);
	}

	/** Re-find every highlight and repaint if anything moved. */
	run(): void {
		if (this.destroyed) return;
		const list = this.store.getSnapshot().list;
		this.lastList = list;
		this.highlighted = new Set(list.map((h) => h.anchor));
		if (list.length === 0) {
			// Nothing to find: skip the transcript scan.
			if (this.resolved.size > 0 || this.paintedSig) {
				this.resolved = new Map();
				this.paint(list);
			}
			this.store.setStatus(new Map());
			return;
		}
		const anchors = anchorElements(this.root);
		const next = new Map<string, Resolved>();
		const status = new Map<string, HighlightStatus>();
		for (const h of list) {
			const element = anchors.get(h.anchor);
			if (!element) {
				status.set(h.id, "orphan");
				continue;
			}
			let map = this.maps.get(element);
			if (!map) {
				map = buildTextMap(element);
				this.maps.set(element, map);
			}
			const prev = this.resolved.get(h.id);
			if (prev && prev.element === element && prev.map === map && prev.specs.length > 0) {
				// Unchanged anchor, unchanged map: the old resolution stands
				// unless the quote itself changed (it never does after creation).
				next.set(h.id, prev);
				status.set(h.id, "found");
				continue;
			}
			const at = locateQuote(map.text, h.quote);
			const specs = at ? rangeSpecs(map, at.start, at.end) : [];
			if (specs.length === 0) {
				status.set(h.id, "orphan");
				continue;
			}
			next.set(h.id, { element, map, specs });
			status.set(h.id, "found");
		}
		// Reused resolutions keep their identity, so "changed" is exact.
		const changed = next.size !== this.resolved.size || [...next].some(([id, r]) => this.resolved.get(id) !== r);
		this.resolved = next;
		// Recolors move no text but need a repaint; note edits need neither.
		if (changed || paintSignature(list) !== this.paintedSig) this.paint(list);
		this.store.setStatus(status);
	}

	private paint(list: readonly { id: string; color: HighlightColor }[]): void {
		this.paintedSig = paintSignature(list);
		if (!this.api) return;
		for (const color of HIGHLIGHT_COLORS) this.painted.get(color)!.clear();
		for (const h of list) {
			const r = this.resolved.get(h.id);
			if (!r) continue;
			const target = this.painted.get(h.color);
			if (!target) continue;
			for (const spec of r.specs) {
				const range = toStatic(spec);
				if (range) target.add(range);
			}
		}
	}

	/** The painted pieces of one highlight (empty = not found). */
	specsOf(id: string): RangeSpec[] {
		return this.resolved.get(id)?.specs ?? [];
	}

	/** Highlights under a viewport point, newest first (overlaps: the
	 *  newest acts). With the event target, only highlights in the
	 *  target's own anchor are measured. */
	hitTest(x: number, y: number, target?: Node | null): string[] {
		const el = target ? (target.nodeType === 1 ? (target as Element) : target.parentElement) : null;
		const anchor = el ? el.closest(`[${HL_ANCHOR_ATTR}]`) : undefined;
		if (target && !anchor) return []; // not inside any highlightable text
		const hits: LessonHighlight[] = [];
		for (const h of this.store.getSnapshot().list) {
			const r = this.resolved.get(h.id);
			if (!r || (anchor && r.element !== anchor)) continue;
			const hit = r.specs.some((spec) => {
				const range = liveRange([spec]);
				return !!range && pointInRects(range.getClientRects(), x, y, 1);
			});
			if (hit) hits.push(h);
		}
		return hits.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((h) => h.id);
	}

	/** Briefly emphasize one highlight (after a jump). */
	flash(id: string, ms = 1500): void {
		const target = this.painted.get("flash");
		if (!target) return;
		target.clear();
		for (const spec of this.specsOf(id)) {
			const range = toStatic(spec);
			if (range) target.add(range);
		}
		window.clearTimeout(this.flashTimer);
		this.flashTimer = window.setTimeout(() => target.clear(), ms);
	}
}
