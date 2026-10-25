/**
 * LESSON HIGHLIGHTS — the client store (fork feature). One instance per
 * mounted lesson. An external store (useSyncExternalStore) so only the
 * panel, the chip and the painter re-render on highlight changes — typing
 * a note never re-renders the transcript.
 *
 * Writes are optimistic and chained per highlight id (a PUT never races
 * the previous one). Comment edits save after a short idle pause and are
 * flushed on blur / page hide. A re-sync (another tab's change) adopts the
 * server list except for highlights with unsaved local changes.
 */

import type { HighlightColor, HighlightQuote, LessonHighlight } from "@/src/core";
import { DEFAULT_HIGHLIGHT_COLOR } from "@/src/core";

export type HighlightStatus = "pending" | "found" | "orphan";

export interface LessonHighlightsState {
	list: LessonHighlight[];
	/** Painter's verdict per highlight id; absent = pending. */
	status: ReadonlyMap<string, HighlightStatus>;
	/** Panel open (persisted per browser). */
	open: boolean;
	/** The panel's selected item. */
	selectedId: string | null;
	/** A one-shot request for the panel to focus this item's comment box. */
	focusCommentId: string | null;
	/** Panel color filter; null = all. */
	filter: HighlightColor | null;
	/** Last save failure, shown in the panel until dismissed or a save works. */
	error: string | null;
}

const OPEN_KEY = "lh:highlights-open";
const COMMENT_SAVE_MS = 600;

function newId(): string {
	const c = globalThis.crypto as Crypto | undefined;
	if (c?.randomUUID) return `hl_${c.randomUUID().replace(/-/g, "").slice(0, 20)}`;
	return `hl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export interface LessonHighlightsStoreOptions {
	fetch?: typeof globalThis.fetch;
	/** Injectable timers (tests). */
	setTimeout?: (fn: () => void, ms: number) => unknown;
	clearTimeout?: (handle: unknown) => void;
	now?: () => string;
}

export class LessonHighlightsStore {
	readonly chatId: string;
	/** This tab's id: sent with writes so the server event can skip the echo. */
	readonly tabId: string;
	private state: LessonHighlightsState;
	private listeners = new Set<() => void>();
	private readonly fetchFn: typeof globalThis.fetch;
	private readonly setTimer: (fn: () => void, ms: number) => unknown;
	private readonly clearTimer: (handle: unknown) => void;
	private readonly now: () => string;
	/** Per-id write chain (PUT/DELETE in order). */
	private chains = new Map<string, Promise<void>>();
	/** Debounced comment saves. */
	private timers = new Map<string, unknown>();
	/** Ids with local changes the server hasn't confirmed yet. */
	private dirty = new Set<string>();
	/** Local edit counter per id: a save only clears `dirty` if nothing newer happened. */
	private revs = new Map<string, number>();
	/** Deleted locally; ignored by re-syncs until the DELETE lands. */
	private deleting = new Set<string>();
	/** Saves that failed; retried on the next flush (blur, page hide). */
	private failed = new Set<string>();
	/** Completed writes so far: a re-sync whose GET overlapped a write
	 *  may predate it, so it fetches again instead of adopting. */
	private writeSeq = 0;

	constructor(chatId: string, initial: readonly LessonHighlight[], opts: LessonHighlightsStoreOptions = {}) {
		this.chatId = chatId;
		this.tabId = newId().slice(3, 19);
		this.fetchFn = opts.fetch ?? ((...args) => globalThis.fetch(...args));
		this.setTimer = opts.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
		this.clearTimer = opts.clearTimeout ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
		this.now = opts.now ?? (() => new Date().toISOString());
		this.state = {
			list: [...initial],
			status: new Map(),
			open: false,
			selectedId: null,
			focusCommentId: null,
			filter: null,
			error: null,
		};
	}

	// ── external-store plumbing ──
	getSnapshot = (): LessonHighlightsState => this.state;
	subscribe = (fn: () => void): (() => void) => {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	};
	private set(patch: Partial<LessonHighlightsState>): void {
		this.state = { ...this.state, ...patch };
		for (const fn of this.listeners) fn();
	}

	get(id: string): LessonHighlight | undefined {
		return this.state.list.find((h) => h.id === id);
	}

	// ── panel state ──
	/** Read the remembered open state (client only; after hydration). */
	hydrateOpen(): void {
		try {
			if (localStorage.getItem(OPEN_KEY) === "1" && !this.state.open) this.set({ open: true });
		} catch {
			/* storage unavailable: stays closed */
		}
	}
	setOpen(open: boolean): void {
		try {
			localStorage.setItem(OPEN_KEY, open ? "1" : "0");
		} catch {
			/* storage unavailable: session-only */
		}
		if (open !== this.state.open) this.set({ open });
	}
	/** Select an item; opens the panel. `focusComment` asks the panel to
	 *  put the cursor in its note. */
	select(id: string | null, opts: { focusComment?: boolean } = {}): void {
		if (id) this.setOpen(true);
		// A color filter that would hide the selected item is dropped.
		const color = id ? this.get(id)?.color : undefined;
		const filter = color && this.state.filter && this.state.filter !== color ? null : this.state.filter;
		this.set({ selectedId: id, focusCommentId: id && opts.focusComment ? id : null, filter });
	}
	/** The panel consumed the focus request. */
	clearFocusRequest(): void {
		if (this.state.focusCommentId !== null) this.set({ focusCommentId: null });
	}
	setFilter(filter: HighlightColor | null): void {
		this.set({ filter });
	}
	clearError(): void {
		if (this.state.error) this.set({ error: null });
	}
	/** The painter's verdicts (only published when something changed). */
	setStatus(status: Map<string, HighlightStatus>): void {
		const prev = this.state.status;
		if (prev.size === status.size && [...status].every(([id, s]) => prev.get(id) === s)) return;
		this.set({ status });
	}

	// ── edits ──
	/** Create a highlight (optimistic) and open the panel on its note. */
	create(input: { anchor: string; quote: HighlightQuote; color?: HighlightColor }): LessonHighlight {
		const now = this.now();
		const h: LessonHighlight = {
			id: newId(),
			anchor: input.anchor,
			quote: input.quote,
			color: input.color ?? DEFAULT_HIGHLIGHT_COLOR,
			comment: "",
			createdAt: now,
			updatedAt: now,
		};
		this.set({ list: [...this.state.list, h] });
		this.select(h.id, { focusComment: true });
		this.save(h.id, { removeOnReject: true });
		return h;
	}

	setColor(id: string, color: HighlightColor): void {
		if (!this.patch(id, { color })) return;
		this.save(id);
	}

	/** Edit a note: local at once, saved after a short pause. */
	setComment(id: string, comment: string): void {
		if (!this.patch(id, { comment })) return;
		const pending = this.timers.get(id);
		if (pending !== undefined) this.clearTimer(pending);
		this.timers.set(
			id,
			this.setTimer(() => {
				this.timers.delete(id);
				this.save(id);
			}, COMMENT_SAVE_MS),
		);
	}

	/** Save pending note edits now (blur), and retry failed saves;
	 *  `keepalive` for page hide. */
	flush(id?: string, keepalive = false): void {
		const ids = new Set<string>();
		for (const [hid, handle] of [...this.timers]) {
			if (id !== undefined && hid !== id) continue;
			this.clearTimer(handle);
			this.timers.delete(hid);
			ids.add(hid);
		}
		for (const hid of this.failed) if (id === undefined || hid === id) ids.add(hid);
		for (const hid of ids) this.save(hid, { keepalive });
	}

	remove(id: string): void {
		const h = this.get(id);
		if (!h) return;
		const pending = this.timers.get(id);
		if (pending !== undefined) this.clearTimer(pending);
		this.timers.delete(id);
		this.deleting.add(id);
		this.dirty.delete(id);
		this.failed.delete(id);
		this.set({
			list: this.state.list.filter((x) => x.id !== id),
			selectedId: this.state.selectedId === id ? null : this.state.selectedId,
		});
		this.enqueue(id, async () => {
			try {
				const res = await this.fetchFn(this.url(id), { method: "DELETE", headers: { "x-lh-tab": this.tabId } });
				// 404 = never saved or already gone: the goal state either way.
				if (!res.ok && res.status !== 404) throw new Error(await errorText(res));
			} catch (err) {
				// Put it back: the server still has it.
				this.set({ list: [...this.state.list, h], error: `Couldn't delete the highlight: ${message(err)}` });
			} finally {
				this.deleting.delete(id);
				this.writeSeq++;
			}
		});
	}

	/** Adopt the server's list (another tab changed it, or a cached page). */
	async sync(attempt = 0): Promise<void> {
		try {
			const seq = this.writeSeq;
			const res = await this.fetchFn(`/api/chats/${encodeURIComponent(this.chatId)}/highlights`);
			if (!res.ok) return;
			const body = (await res.json()) as { highlights?: LessonHighlight[] };
			if (!Array.isArray(body.highlights)) return;
			// A write finished while the GET was out: the list may predate it.
			if (this.writeSeq !== seq) {
				if (attempt < 3) await this.sync(attempt + 1);
				return;
			}
			this.adopt(body.highlights);
		} catch {
			/* offline blip: keep what we have */
		}
	}

	/** Merge rule: the server wins, except ids with unsaved local changes
	 *  (kept as local) and ids being deleted (kept out). */
	adopt(server: readonly LessonHighlight[]): void {
		const local = new Map(this.state.list.map((h) => [h.id, h]));
		const merged: LessonHighlight[] = [];
		const seen = new Set<string>();
		for (const s of server) {
			if (this.deleting.has(s.id)) continue;
			merged.push(this.dirty.has(s.id) ? (local.get(s.id) ?? s) : s);
			seen.add(s.id);
		}
		for (const h of this.state.list) if (!seen.has(h.id) && this.dirty.has(h.id)) merged.push(h);
		const selectedId = merged.some((h) => h.id === this.state.selectedId) ? this.state.selectedId : null;
		this.set({ list: merged, selectedId });
	}

	// ── internals ──
	private url(id: string): string {
		return `/api/chats/${encodeURIComponent(this.chatId)}/highlights/${encodeURIComponent(id)}`;
	}

	private patch(id: string, patch: Partial<LessonHighlight>): boolean {
		if (!this.get(id)) return false;
		this.set({ list: this.state.list.map((h) => (h.id === id ? { ...h, ...patch, updatedAt: this.now() } : h)) });
		return true;
	}

	private enqueue(id: string, task: () => Promise<void>): void {
		const prev = this.chains.get(id) ?? Promise.resolve();
		const next = prev.then(task, task);
		this.chains.set(id, next);
		void next.finally(() => {
			if (this.chains.get(id) === next) this.chains.delete(id);
		});
	}

	private save(id: string, opts: { removeOnReject?: boolean; keepalive?: boolean } = {}): void {
		const rev = (this.revs.get(id) ?? 0) + 1;
		this.revs.set(id, rev);
		this.dirty.add(id);
		this.enqueue(id, async () => {
			const h = this.get(id);
			if (!h || this.deleting.has(id)) {
				// Deleted meanwhile: nothing left to save or retry.
				this.failed.delete(id);
				if (!h) this.dirty.delete(id);
				return;
			}
			try {
				const res = await this.fetchFn(this.url(id), {
					method: "PUT",
					headers: { "content-type": "application/json", "x-lh-tab": this.tabId },
					body: JSON.stringify({ anchor: h.anchor, quote: h.quote, color: h.color, comment: h.comment }),
					keepalive: opts.keepalive,
				});
				if (!res.ok) {
					const text = await errorText(res);
					if (opts.removeOnReject && res.status === 400) {
						// The server refused the new highlight outright (e.g. the text
						// isn't saved yet): drop it rather than keep a ghost.
						this.dirty.delete(id);
						this.failed.delete(id);
						this.set({
							list: this.state.list.filter((x) => x.id !== id),
							selectedId: this.state.selectedId === id ? null : this.state.selectedId,
							error: `Couldn't save the highlight: ${text}`,
						});
						return;
					}
					throw new Error(text);
				}
				const saved = ((await res.json()) as { highlight?: LessonHighlight }).highlight;
				if (this.revs.get(id) === rev) this.dirty.delete(id);
				this.failed.delete(id);
				if (saved && this.get(id)) {
					// Adopt the server's timestamps; local fields stay (they may be newer).
					this.set({
						list: this.state.list.map((x) => (x.id === id ? { ...x, createdAt: saved.createdAt } : x)),
						// The banner clears once nothing is left unsaved.
						error: this.failed.size === 0 ? null : this.state.error,
					});
				}
			} catch (err) {
				// Only a highlight that still exists is worth retrying.
				if (this.get(id) && !this.deleting.has(id)) this.failed.add(id);
				this.set({ error: `Couldn't save your highlight: ${message(err)}. It will retry when you leave the note or the page.` });
			} finally {
				this.writeSeq++;
			}
		});
	}
}

async function errorText(res: Response): Promise<string> {
	try {
		const body = (await res.json()) as { error?: string };
		return body.error ?? `HTTP ${res.status}`;
	} catch {
		return `HTTP ${res.status}`;
	}
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
