/**
 * LESSON HIGHLIGHTS — the DOM side (fork feature). One deterministic text
 * map per anchor element (a teacher text part, a learner message, an
 * answered card), the selection → quote mapping, and quote → paintable
 * ranges. Pure DOM reads: React owns the markup, nothing here mutates it.
 *
 * Why not session-find-dom's displayRuns: it splits text at every block
 * (and at KaTeX's table-cell spans) and reads computed styles. Highlights
 * need ONE string per anchor whose offsets don't move with theme, viewport
 * or async re-renders, so this walker is tag/attribute based:
 *   - blocks (P, LI, H1-6, PRE, TD, DIV ... , BR, display math, code lines)
 *     become "\n" separators;
 *   - each formula is ONE atomic token ($tex$ / $$tex$$, from KaTeX's TeX
 *     annotation) mapped to the points just before/after its element;
 *   - chrome is skipped (buttons except Streamdown's link buttons, code
 *     headers, mermaid, svg, [data-hl-exclude] ...).
 */

import type { HighlightQuote } from "@/src/core";
import { HIGHLIGHT_LIMITS, quoteFor } from "@/src/core";

export const HL_ANCHOR_ATTR = "data-hl-anchor";

/** Never part of a quote. Mirrors session-find's EXCLUDED plus the
 *  highlight-specific chrome (Streamdown renders links as buttons, so only
 *  NON-link buttons are chrome). */
const EXCLUDED = [
	"script", "style", "noscript", "textarea", "input", "select", "iframe", "canvas",
	"title", "defs", "metadata", "desc", "svg", ".katex-mathml", ".sr-only", "[hidden]",
	"[data-session-find-exclude]", "[data-lh-menu]", '[role="menu"]', '[role="dialog"]', '[role="tooltip"]',
	'button:not([data-streamdown="link"])',
	'[data-streamdown="link-safety-modal"]',
	'[data-streamdown="code-block-header"]',
	'[data-streamdown$="-actions"]',
	'[data-testid="md-mermaid"]',
	'[data-streamdown="mermaid-error"]',
	"[data-hl-exclude]",
].join(",");

const BLOCK_TAGS = new Set([
	"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "CAPTION", "DD", "DETAILS", "DIV", "DL", "DT", "FIELDSET",
	"FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HR", "LI",
	"MAIN", "NAV", "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD",
	"TR", "UL",
]);

/** Inline-tagged elements that render as blocks. Code lines are spans with
 *  no "\n" between them; treating them as blocks keeps the text identical
 *  before and after shiki swaps in highlighted tokens. */
const BLOCK_SELECTOR = '[data-testid="md-math"], [data-streamdown="code-block-body"] code > span';

const PRESERVE_SELECTOR = "pre, .whitespace-pre-wrap, .whitespace-pre, .whitespace-pre-line";

export interface MapPoint {
	node: Node;
	offset: number;
}

/** One character of the map: where it starts and ends in the DOM. */
interface MapChar {
	start: MapPoint;
	end: MapPoint;
	/** "sep" chars (block breaks) paint nothing; "math" chars share one
	 *  atomic element; "text" chars come from one text node. */
	kind: "text" | "sep" | "math";
}

export interface AnchorTextMap {
	root: Element;
	text: string;
	chars: MapChar[];
	/** Map position of a node's start (every visited child node, atoms and
	 *  skipped chrome included) and an element's end. */
	startOf: Map<Node, number>;
	endOf: Map<Node, number>;
	/** Per text node: the map position for a boundary at each offset
	 *  (length + 1 entries) — the position of the next mapped character. */
	textPos: Map<Node, number[]>;
	/** Atomic or skipped elements: a boundary inside one snaps to its edges. */
	atoms: Set<Node>;
}

function isElement(node: Node): node is Element {
	return node.nodeType === 1;
}

function isText(node: Node): node is Text {
	return node.nodeType === 3;
}

function matches(el: Element, selector: string): boolean {
	try {
		return el.matches(selector);
	} catch {
		return false;
	}
}

function isBlock(el: Element): boolean {
	return BLOCK_TAGS.has(el.tagName.toUpperCase()) || matches(el, BLOCK_SELECTOR) || el.classList?.contains("katex-display");
}

function mathSource(el: Element): string {
	const tex = el.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
	if (tex && tex.trim()) return tex.trim();
	return (el.textContent ?? "").replace(/\s+/g, " ").trim();
}

function pointBefore(node: Node): MapPoint {
	const parent = node.parentNode!;
	return { node: parent, offset: Array.prototype.indexOf.call(parent.childNodes, node) };
}

function pointAfter(node: Node): MapPoint {
	const before = pointBefore(node);
	return { node: before.node, offset: before.offset + 1 };
}

/** Build the anchor's text map. Deterministic for a given DOM. */
export function buildTextMap(root: Element): AnchorTextMap {
	let text = "";
	const chars: MapChar[] = [];
	const startOf = new Map<Node, number>();
	const endOf = new Map<Node, number>();
	const textPos = new Map<Node, number[]>();
	const atoms = new Set<Node>();
	/** The last emitted char was a collapsible space (collapse mode). */
	let pendingSpace = false;

	const atLineStart = () => text.length === 0 || text.endsWith("\n");

	const separate = () => {
		// A trailing collapsed space never survives a block break.
		if (pendingSpace && text.endsWith(" ")) {
			text = text.slice(0, -1);
			chars.pop();
		}
		pendingSpace = false;
		if (atLineStart()) return;
		const last = chars.at(-1)!;
		text += "\n";
		chars.push({ start: last.end, end: last.end, kind: "sep" });
	};

	const appendText = (node: Text, preserve: boolean) => {
		const pos: number[] = [];
		const data = node.data;
		for (let i = 0; i < data.length; i++) {
			pos.push(text.length);
			const ch = data[i]!;
			if (ch === "$") {
				// A literal dollar is written `\$` so it can never be read as a
				// math token's delimiter (the panel renders quotes as markdown,
				// and the export is markdown). Both characters map to this "$".
				const at = { start: { node, offset: i }, end: { node, offset: i + 1 }, kind: "text" as const };
				text += "\\$";
				chars.push(at, { ...at });
				pendingSpace = false;
				continue;
			}
			if (preserve) {
				if (ch === "\r") continue;
				text += ch;
				chars.push({ start: { node, offset: i }, end: { node, offset: i + 1 }, kind: ch === "\n" ? "sep" : "text" });
				pendingSpace = false;
				continue;
			}
			const space = /[\t\n\r\f ]/.test(ch);
			if (space) {
				if (atLineStart() || pendingSpace) {
					// Skipped: extend the previous collapsed space's end over it.
					if (pendingSpace) chars.at(-1)!.end = { node, offset: i + 1 };
					continue;
				}
				text += " ";
				chars.push({ start: { node, offset: i }, end: { node, offset: i + 1 }, kind: "text" });
				pendingSpace = true;
				continue;
			}
			text += ch;
			chars.push({ start: { node, offset: i }, end: { node, offset: i + 1 }, kind: "text" });
			pendingSpace = false;
		}
		pos.push(text.length);
		textPos.set(node, pos);
	};

	const appendMath = (el: Element, display: boolean) => {
		const token = display ? `$$${mathSource(el)}$$` : `$${mathSource(el)}$`;
		const start = pointBefore(el);
		const end = pointAfter(el);
		if (display) separate();
		for (const ch of token) {
			text += ch;
			chars.push({ start, end, kind: "math" });
		}
		pendingSpace = false;
		if (display) separate();
	};

	const visit = (el: Element, preserve: boolean) => {
		const block = el !== root && isBlock(el);
		if (block) separate();
		if (el.tagName.toUpperCase() === "BR") {
			separate();
			return;
		}
		const keep = preserve || matches(el, PRESERVE_SELECTOR);
		for (const child of Array.from(el.childNodes)) {
			startOf.set(child, text.length);
			if (isText(child)) {
				appendText(child, keep);
			} else if (isElement(child)) {
				if (matches(child, EXCLUDED) || child.hasAttribute(HL_ANCHOR_ATTR)) {
					atoms.add(child);
				} else if (child.classList?.contains("katex-display")) {
					atoms.add(child);
					appendMath(child, true);
				} else if (child.classList?.contains("katex") || child.classList?.contains("katex-error")) {
					atoms.add(child);
					appendMath(child, false);
				} else {
					visit(child, keep);
				}
			}
			endOf.set(child, text.length);
		}
		if (block) separate();
	};

	startOf.set(root, 0);
	visit(root, false);
	// Trim trailing breaks/spaces (positions past the end clamp to length).
	while (text.length > 0 && (text.endsWith("\n") || (pendingSpace && text.endsWith(" ")))) {
		text = text.slice(0, -1);
		chars.pop();
		pendingSpace = false;
	}
	endOf.set(root, text.length);
	return { root, text, chars, startOf, endOf, textPos, atoms };
}

/** True when `a` comes before `b` in document order (neither contains the
 *  other). Hand-rolled: test DOMs mis-handle compareDocumentPosition. */
function precedes(a: Node, b: Node): boolean {
	const chain = (n: Node) => {
		const out: Node[] = [];
		for (let x: Node | null = n; x; x = x.parentNode) out.unshift(x);
		return out;
	};
	const ca = chain(a);
	const cb = chain(b);
	let i = 0;
	while (i < ca.length && i < cb.length && ca[i] === cb[i]) i++;
	if (i === 0 || i >= ca.length || i >= cb.length) return false;
	const siblings = Array.from(ca[i - 1]!.childNodes);
	return siblings.indexOf(ca[i] as ChildNode) < siblings.indexOf(cb[i] as ChildNode);
}

/** The map position of a DOM boundary (a Range end), clamped to the
 *  anchor. Boundaries inside a formula or skipped chrome snap outward:
 *  a start to the atom's start, an end to its end. */
export function positionOf(map: AnchorTextMap, node: Node, offset: number, side: "start" | "end"): number {
	const { root } = map;
	if (node !== root && node.contains(root)) {
		// A boundary in an ANCESTOR (container, child index) — e.g. a drag
		// that starts in the margin: before or after the child holding us.
		let branch: Node = root;
		while (branch.parentNode !== node) branch = branch.parentNode!;
		const index = Array.prototype.indexOf.call(node.childNodes, branch);
		return offset <= index ? 0 : map.text.length;
	}
	if (node !== root && !root.contains(node)) {
		// Outside the anchor: before it → 0, after it → the end.
		return precedes(node, root) ? 0 : map.text.length;
	}
	// Inside an atom (math, chrome)? Snap to its edge.
	let atom: Node | null = null;
	for (let n: Node | null = node; n && n !== root; n = n.parentNode) {
		if (map.atoms.has(n)) atom = n; // keep climbing: the OUTERMOST atom wins
	}
	if (atom) return side === "start" ? (map.startOf.get(atom) ?? 0) : (map.endOf.get(atom) ?? map.text.length);
	if (isText(node)) {
		const pos = map.textPos.get(node);
		if (!pos) return side === "start" ? 0 : map.text.length;
		return Math.min(pos[Math.min(offset, pos.length - 1)] ?? map.text.length, map.text.length);
	}
	const children = node.childNodes;
	if (offset < children.length) {
		const child = children[offset]!;
		return Math.min(map.startOf.get(child) ?? map.endOf.get(node) ?? map.text.length, map.text.length);
	}
	return Math.min(map.endOf.get(node) ?? map.text.length, map.text.length);
}

/** Is a viewport point inside any of these rects (with a small tolerance)? */
export function pointInRects(rects: Iterable<DOMRectReadOnly>, x: number, y: number, tolerance = 2): boolean {
	for (const r of rects) {
		if (x >= r.left - tolerance && x <= r.right + tolerance && y >= r.top - tolerance && y <= r.bottom + tolerance) return true;
	}
	return false;
}

/** The anchor elements under a root, keyed by anchor key. */
export function anchorElements(root: ParentNode): Map<string, Element> {
	const out = new Map<string, Element>();
	for (const el of Array.from(root.querySelectorAll(`[${HL_ANCHOR_ATTR}]`))) {
		const key = el.getAttribute(HL_ANCHOR_ATTR);
		if (key && !out.has(key)) out.set(key, el);
	}
	return out;
}

export type SelectionQuoteResult =
	| { ok: true; anchor: string; element: Element; quote: HighlightQuote; start: number; end: number }
	| { ok: false; reason: string };

/** Minimal range shape (a live Range, or a test stand-in). */
export interface RangeLike {
	startContainer: Node;
	startOffset: number;
	endContainer: Node;
	endOffset: number;
}

function intersects(range: RangeLike, el: Element): boolean {
	const r = range as Partial<Range>;
	if (typeof r.intersectsNode === "function") return r.intersectsNode(el);
	// Stand-in: a boundary inside the element, or the element between them.
	return el.contains(range.startContainer) || el.contains(range.endContainer);
}

/**
 * A selection → the quote to store. The selection must cover non-blank
 * text in exactly ONE anchor (triple-click selections that spill into the
 * next block still work); `allowed` is the set of anchor keys that may be
 * highlighted right now (saved, settled text).
 */
export function selectionQuote(range: RangeLike, root: ParentNode, allowed: { has(key: string): boolean }): SelectionQuoteResult {
	const hits: { key: string; element: Element; map: AnchorTextMap; start: number; end: number }[] = [];
	for (const [key, element] of anchorElements(root)) {
		if (!intersects(range, element)) continue;
		const map = buildTextMap(element);
		let start = positionOf(map, range.startContainer, range.startOffset, "start");
		let end = positionOf(map, range.endContainer, range.endOffset, "end");
		while (start < end && /\s/.test(map.text[start]!)) start++;
		while (end > start && /\s/.test(map.text[end - 1]!)) end--;
		if (end > start) hits.push({ key, element, map, start, end });
	}
	if (hits.length === 0) return { ok: false, reason: "This part can't be highlighted" };
	if (hits.length > 1) return { ok: false, reason: "Select text within one message" };
	const hit = hits[0]!;
	if (!allowed.has(hit.key)) return { ok: false, reason: "Wait for the reply to finish" };
	if (hit.end - hit.start > HIGHLIGHT_LIMITS.exact) return { ok: false, reason: "Selection is too long to highlight" };
	return {
		ok: true,
		anchor: hit.key,
		element: hit.element,
		quote: quoteFor(hit.map.text, hit.start, hit.end),
		start: hit.start,
		end: hit.end,
	};
}

/** Boundary quadruple for one paintable piece. */
export interface RangeSpec {
	startContainer: Node;
	startOffset: number;
	endContainer: Node;
	endOffset: number;
}

/** The paintable pieces of a map span: one per text node run or formula,
 *  never across a block break or skipped chrome. */
export function rangeSpecs(map: AnchorTextMap, start: number, end: number): RangeSpec[] {
	const specs: RangeSpec[] = [];
	let cur: RangeSpec | null = null;
	let curKey: Node | null = null;
	for (let i = start; i < end && i < map.chars.length; i++) {
		const c = map.chars[i]!;
		if (c.kind === "sep") {
			cur = null;
			curKey = null;
			continue;
		}
		// Group key: the text node, or the formula element's boundary parent+offset.
		const key = c.kind === "math" ? (c.start.node.childNodes[c.start.offset] ?? null) : c.start.node;
		if (cur && key === curKey) {
			cur.endContainer = c.end.node;
			cur.endOffset = c.end.offset;
			continue;
		}
		cur = { startContainer: c.start.node, startOffset: c.start.offset, endContainer: c.end.node, endOffset: c.end.offset };
		curKey = key;
		specs.push(cur);
	}
	return specs;
}
