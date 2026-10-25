"use client";
/**
 * The Appearance + Graph sections (thin settings wave).
 *
 * Appearance controls resolve against the factory in the provider; writes
 * PUT the whole appearance section and hand the delta back so the CSS
 * variables move IMMEDIATELY (the section's whole point — it must DO
 * something). Hex inputs commit on blur/Enter; the background derives the
 * raised/accent/edge palette in code (components/settings/appearance.tsx).
 * Mode is dark-only this wave: control rendered DISABLED with a note — the
 * light palette is the design wave's work, and a lying control is worse
 * than an honest disabled one.
 *
 * Graph graying (owner, 2026-09-20) follows the graph viewer's render-panel
 * convention: the whole row dims when a parent is off (stored values
 * persist but resolve inert — the switch shows stored, the dim effective).
 *
 * Reading font (appearance wave, 2026-09-26, owner ruling): a searchable
 * dropdown of the user's INSTALLED fonts (FontMenuList over model-menu's
 * machine) fed by window.queryLocalFonts() in the desktop shell — the
 * enumeration is click-bound (the API requires user activation), deduped
 * to unique families, the factory family excluded (the DEFAULT row is
 * it). In a plain dev browser the API is absent → a small curated list
 * + a footer that says exactly that — never a fabricated system list.
 * The custom-family input inside the menu is the manual escape path.
 * Empty/unset keeps meaning Source Sans 3.
 *
 * Emphasis inks (same wave): the factory tokens default to the regular
 * text color now (globals.css); the rows' empty-state labels say "same
 * as text".
 *
 * Uploaded VS Code themes: the "VS Code themes" row uploads a theme file
 * (the server maps and stores it, /api/themes) and applies it at once;
 * uploaded themes join the Mode list under their own names and can be
 * deleted. Deleting the theme in use switches back to Dark first.
 */

import { useEffect, useRef, useState } from "react";
import {
	CUSTOM_THEME_LIMITS,
	EXTRACTION_CHUNK_TOKENS_FLOOR,
	appearanceChoice,
	customThemeSummary,
	isAppearanceMode,
	resolveSettings,
	type AppearanceSettings,
	type CustomTheme,
	type CustomThemeSummary,
	type GraphSettings,
} from "@/src/core";
import { MenuShell } from "@/components/menu-shell";
import { Hint } from "@/components/ui/hint";
import { useAppearance } from "./appearance.tsx";
import { FontMenuList } from "./model-menu";
import { CommitInput, SettingsRow, ThinSelect, Toggle } from "./controls.tsx";

/** The factory reading family — the DEFAULT row's identity (unset =
 *  this). Exported for tests. */
export const DEFAULT_READING_FONT = "Source Sans 3";

/** The built-in mode labels: an uploaded theme with the same name gets an
 *  "(uploaded)" suffix in the Mode list, so the closed select tells them apart. */
const BUILT_IN_MODE_LABELS = new Set(["Dark", "Paper", "One Dark Pro"]);

/** The dev-browser fallback list (queryLocalFonts is absent there):
 *  the app's own knowns plus a handful of ubiquitous macOS families,
 *  honestly LABELED as common — never presented as the system's real
 *  list. The factory family is absent: the DEFAULT row is it. Exported
 *  for tests. */
export const CURATED_FALLBACK_FONTS: readonly string[] = [
	"Arial",
	"CMU Serif",
	"Courier New",
	"Georgia",
	"Helvetica",
	"Helvetica Neue",
	"Menlo",
	"Times New Roman",
	"Trebuchet MS",
	"Verdana",
];

/** window.queryLocalFonts' shape as this section consumes it (family is
 *  the only field used; the API returns one FontData per FACE — the
 *  caller dedupes). */
type LocalFontsApi = () => Promise<Array<{ family: string }>>;

/** The Local Font Access seam — read lazily (SSR has no window, and
 *  render-time access would evaluate the API on the server). */
function localFontsApi(): LocalFontsApi | null {
	if (typeof window === "undefined") return null;
	return (window as unknown as { queryLocalFonts?: LocalFontsApi }).queryLocalFonts ?? null;
}

/** Compose the reading-font pick: null (or blank) = the factory
 *  Source Sans 3; otherwise the family verbatim (trimmed — the
 *  sanitizer trims again server-side). Pure — exported for tests. */
export function composeFontFamily(
	appearance: AppearanceSettings | undefined,
	family: string | null,
): AppearanceSettings {
	const value = family?.trim() ?? "";
	return { ...appearance, fontFamily: value === "" ? null : value };
}

export function AppearanceSection({
	appearance,
	onSectionChange,
}: {
	/** The record's appearance delta (absent = factory). */
	appearance: AppearanceSettings | undefined;
	/** PUT the whole appearance section; the page re-applies on success. */
	onSectionChange: (next: AppearanceSettings) => void;
}) {
	const { appearance: resolved, activeTheme, rememberTheme } = useAppearance();
	const md = appearance?.mdRendering;
	// The custom background only applies in plain dark mode (appearance.tsx);
	// Paper, One Dark Pro and uploaded themes have their own palettes.
	const ownPalette = appearanceChoice(resolved.mode) !== "dark";

	// Uploaded VS Code themes: the list (names only), the upload's state,
	// and what the last upload or delete had to say.
	const [themeList, setThemeList] = useState<CustomThemeSummary[]>([]);
	const [uploading, setUploading] = useState(false);
	const [themeNote, setThemeNote] = useState<{ error: boolean; lines: string[] } | null>(null);
	const themeFileRef = useRef<HTMLInputElement>(null);
	useEffect(() => {
		let alive = true;
		fetch("/api/themes")
			.then((r) => r.json())
			.then((body: { themes?: CustomThemeSummary[] }) => {
				if (alive && Array.isArray(body.themes)) setThemeList(body.themes);
			})
			.catch(() => {/* the list stays empty; upload still works */});
		return () => {
			alive = false;
		};
	}, []);
	const customId = resolved.mode === "custom" ? resolved.customThemeId : null;
	// The picked theme shows in the Mode list even before the list loads.
	const listedThemes =
		customId && activeTheme?.id === customId && !themeList.some((t) => t.id === customId)
			? [...themeList, customThemeSummary(activeTheme)]
			: themeList;
	const modeValue = customId ? `custom:${customId}` : appearanceChoice(resolved.mode) === "custom" ? "dark" : appearanceChoice(resolved.mode);

	const uploadTheme = async (file: File) => {
		setUploading(true);
		setThemeNote(null);
		try {
			if (file.size > CUSTOM_THEME_LIMITS.fileChars) throw new Error("This file is too large to be a color theme.");
			const res = await fetch("/api/themes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ text: await file.text(), fileName: file.name }),
			});
			const body = (await res.json().catch(() => ({}))) as { theme?: CustomTheme; warnings?: string[]; error?: string };
			if (!res.ok || !body.theme) {
				setThemeNote({ error: true, lines: [body.error ?? `The upload failed (${res.status}).`] });
				return;
			}
			const theme = body.theme;
			rememberTheme(theme);
			setThemeList((list) => [...list, customThemeSummary(theme)]);
			onSectionChange({ ...appearance, mode: "custom", customThemeId: theme.id });
			setThemeNote({ error: false, lines: [`Applied ${theme.name}.`, ...(body.warnings ?? [])] });
		} catch (err) {
			setThemeNote({ error: true, lines: [err instanceof Error ? err.message : String(err)] });
		} finally {
			setUploading(false);
			if (themeFileRef.current) themeFileRef.current.value = "";
		}
	};

	const deleteTheme = async (theme: CustomThemeSummary) => {
		setThemeNote(null);
		if (customId === theme.id) onSectionChange({ ...appearance, mode: "dark", customThemeId: null });
		const res = await fetch(`/api/themes/${encodeURIComponent(theme.id)}`, { method: "DELETE" }).catch(() => null);
		if (res && (res.ok || res.status === 404)) setThemeList((list) => list.filter((t) => t.id !== theme.id));
		else setThemeNote({ error: true, lines: [`Couldn't delete ${theme.name}. Try again.`] });
	};

	// The font dropdown's open state + its enumeration cache. undefined =
	// not enumerated yet (desktop: click-bound queryLocalFonts pending);
	// null = enumeration UNAVAILABLE (the API is absent in a plain
	// browser, rejected, or resolved EMPTY — Electron 44's local-fonts
	// grant passes and the enumeration still yields zero fonts,
	// reproduced 2026-09-26) → the curated fallback; a list = the deduped
	// families. enumEmpty distinguishes WHY it fell back, for the footer.
	const [fontMenuOpen, setFontMenuOpen] = useState(false);
	const [localFonts, setLocalFonts] = useState<string[] | null | undefined>(undefined);
	const [enumEmpty, setEnumEmpty] = useState(false);
	const menuAnchorRef = useRef<HTMLSpanElement>(null);

	// The enumeration runs INSIDE the trigger click — queryLocalFonts
	// requires user activation, so it cannot be a mount effect. First
	// open only: the families are cached for the section's life (font
	// installs mid-dialog are not a case); ANY unavailable enumeration
	// (absent / rejected / empty) falls back to the curated list rather
	// than an empty picker.
	const openFontMenu = () => {
		setFontMenuOpen((open) => {
			if (!open && localFonts === undefined) {
				const api = localFontsApi();
				if (api === null) {
					setLocalFonts(null);
					setEnumEmpty(false);
				} else {
					void api()
						.then((fonts) => {
							const families = [...new Set(fonts.map((f) => f.family))]
								.filter((f) => f !== DEFAULT_READING_FONT)
								.sort((a, b) => a.localeCompare(b));
							if (families.length === 0) {
								// Resolved-but-empty: not a failure the catch sees —
								// an honest unavailable (this Electron 44 build
								// enumerates nothing even granted).
								setLocalFonts(null);
								setEnumEmpty(true);
							} else {
								setLocalFonts(families);
							}
						})
						.catch(() => {
							setLocalFonts(null);
							setEnumEmpty(false);
						});
				}
			}
			return !open;
		});
	};

	const pickFont = (family: string | null) => {
		setFontMenuOpen(false);
		onSectionChange(composeFontFamily(appearance, family));
	};

	// The dropdown contract (agent-section's, mirrored): any click
	// outside the open menu — or an Esc — closes it. Esc is CLAIMED with
	// stopPropagation so the settings dialog behind does NOT also close.
	useEffect(() => {
		if (!fontMenuOpen) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (menuAnchorRef.current?.contains(target)) return;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (target instanceof Element && target.closest('[role="dialog"]')) {
				setFontMenuOpen(false);
			}
			// else: outside the dialog — the dialog's own close handles it.
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setFontMenuOpen(false);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [fontMenuOpen]);

	return (
		<>
			{/* Mode: Dark (the default), Paper (ivory + burgundy) or One Dark Pro
			    (globals.css .paper / .onedark). "light" stays reserved for
			    upstream's planned light palette and isn't offered until it
			    exists. */}
			<SettingsRow label="Mode" testid="row-mode">
				<ThinSelect
					value={modeValue}
					ariaLabel="mode"
					onChange={(v) =>
						onSectionChange(
							v.startsWith("custom:")
								? { ...appearance, mode: "custom", customThemeId: v.slice("custom:".length) }
								: { ...appearance, mode: isAppearanceMode(v) && v !== "custom" ? appearanceChoice(v) : "dark" },
						)
					}
					testid="select-mode"
				>
					<option value="dark">Dark</option>
					<option value="paper">Paper</option>
					<option value="onedark">One Dark Pro</option>
					{listedThemes.length > 0 && (
						<optgroup label="Uploaded">
							{listedThemes.map((t) => (
								<option key={t.id} value={`custom:${t.id}`}>
									{BUILT_IN_MODE_LABELS.has(t.name) ? `${t.name} (uploaded)` : t.name}
								</option>
							))}
						</optgroup>
					)}
				</ThinSelect>
			</SettingsRow>
			{/* Uploaded VS Code themes: upload applies the theme at once. */}
			<SettingsRow label="VS Code themes" hint="Upload a color theme's .json file" testid="row-vscode-themes">
				<span className="flex items-center gap-2">
					<button
						type="button"
						data-testid="upload-theme"
						disabled={uploading}
						onClick={() => themeFileRef.current?.click()}
						className="rounded-sm border border-border px-3 py-1.5 font-ui text-xs disabled:opacity-40"
					>
						{uploading ? "Uploading…" : "Upload theme"}
					</button>
					<input
						ref={themeFileRef}
						type="file"
						accept=".json,.jsonc,application/json"
						className="hidden"
						data-testid="theme-file"
						onChange={(e) => {
							const file = e.target.files?.[0];
							if (file) void uploadTheme(file);
						}}
					/>
				</span>
			</SettingsRow>
			{themeNote && (
				<div
					role={themeNote.error ? "alert" : "status"}
					data-testid="theme-note"
					className={themeNote.error ? "text-xs text-red-500" : "text-xs text-muted-foreground"}
				>
					{themeNote.lines.map((line, i) => (
						<p key={i}>{line}</p>
					))}
				</div>
			)}
			{themeList.length > 0 && (
				<ul data-testid="theme-list" className="flex flex-col gap-1 pb-1">
					{themeList.map((t) => (
						<li key={t.id} className="flex items-center justify-between gap-3 text-sm">
							<span className="min-w-0 truncate">
								{t.name}
								<span className="ml-2 text-xs text-muted-foreground">{t.type}</span>
								{customId === t.id && <span className="ml-2 text-xs text-muted-foreground">in use</span>}
							</span>
							<button
								type="button"
								aria-label={`Delete ${t.name}`}
								onClick={() => void deleteTheme(t)}
								className="shrink-0 px-2 text-xs text-muted-foreground transition-colors hover:text-foreground"
							>
								Delete
							</button>
						</li>
					))}
				</ul>
			)}
			<SettingsRow
				label="Background"
				hint={ownPalette ? "Dark mode only" : `Empty = ${resolved.background ?? "#141414"}`}
				testid="row-background"
				dimmed={ownPalette}
			>
				<CommitInput
					value={appearance?.background ?? ""}
					placeholder="#141414"
					ariaLabel="background hex"
					testid="input-background"
					onCommit={(v) => onSectionChange({ ...appearance, background: v === "" ? null : v })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Reading font"
				hint={`Empty = ${DEFAULT_READING_FONT}`}
				testid="row-font"
			>
				<span ref={fontMenuOpen ? menuAnchorRef : undefined} className="relative flex items-center gap-2">
					{/* The MenuTrigger look (agent-section's collapsed
					    select — it lives unexported there, so the
					    classes ride inline; the searchable machine is
					    the shared part). The tooltip rides the CLOSED
					    button ONLY (owner ruling 2026-09-26: never while
					    the dropdown is out — it popped over the open
					    menu when the wrap covered the whole anchor
					    span). */}
					{(() => {
						const triggerButton = (
							<button
								type="button"
								aria-label="Reading font"
								aria-expanded={fontMenuOpen}
								data-testid="font-trigger"
								onClick={openFontMenu}
								className="flex h-7 min-w-20 items-center gap-1 rounded-sm border border-border bg-background px-1.5 font-ui text-xs text-foreground transition-colors hover:border-muted-foreground/50"
							>
								<span className="min-w-0 flex-1 truncate">{appearance?.fontFamily || DEFAULT_READING_FONT}</span>
								<span aria-hidden className="text-muted-foreground">
									▾
								</span>
							</button>
						);
						return fontMenuOpen ? (
							triggerButton
						) : (
							<Hint label="Choose from your installed fonts" side="left">
								{triggerButton}
							</Hint>
						);
					})()}
					{fontMenuOpen && (
						<MenuShell
							preferredSide="down"
							anchorTestid="font-trigger"
							testid="font-menu"
							menuClass="flex w-[18rem] flex-col gap-0.5 rounded-xl border border-border bg-card p-2 text-xs shadow-xl"
						>
							<FontMenuList
								families={localFonts === undefined ? undefined : (localFonts ?? [...CURATED_FALLBACK_FONTS])}
								effectiveFamily={appearance?.fontFamily ?? null}
								onPick={pickFont}
								footer={
									localFonts === undefined
										? undefined
										: localFonts === null
											? enumEmpty
												? "Common families — installed fonts could not be read"
												: "Common families — your installed list needs the desktop app"
											: "Your installed fonts"
								}
							/>
						</MenuShell>
					)}
				</span>
			</SettingsRow>
			<SettingsRow label="Reading font size" hint={`${resolved.proseFontSize}px`} testid="row-prose-size">
				<CommitInput
					type="number"
					value={String(appearance?.proseFontSize ?? "")}
					placeholder="16"
					ariaLabel="prose font size"
					testid="input-prose-size"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): omit the key so the record
						// UNSETS and the field stays empty (absence, not null, is the
						// unset for numbers). Number("") is 0, so the old clamp wrote 12.
						if (v === "") {
							onSectionChange({ ...appearance, proseFontSize: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return; // bad input: no write, factory stays
						onSectionChange({ ...appearance, proseFontSize: Math.min(24, Math.max(12, Math.round(n))) });
					}}
				/>
			</SettingsRow>
			<SettingsRow label="Session names in serif" testid="row-session-serif">
				<Toggle
					checked={appearance?.sessionNameSerif ?? true}
					label="session names serif"
					onChange={(on) => onSectionChange({ ...appearance, sessionNameSerif: on })}
				/>
			</SettingsRow>
			<SettingsRow label="Heading weight" hint={`${resolved.mdRendering.headingWeight}`} testid="row-heading-weight">
				<CommitInput
					type="number"
					value={String(md?.headingWeight ?? "")}
					placeholder="900"
					ariaLabel="heading weight"
					testid="input-heading-weight"
					onCommit={(v) => {
						// Empty = factory default (owner, fix wave): Number("") is 0, so
						// Absence is the unset representation — the old clamp wrote 100.
						if (v === "") {
							onSectionChange({ ...appearance, mdRendering: { ...md, headingWeight: undefined } });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n)) return;
						onSectionChange({
							...appearance,
							mdRendering: { ...md, headingWeight: Math.min(900, Math.max(100, Math.round(n))) },
						});
					}}
				/>
			</SettingsRow>
			{/* The emphasis inks default to the REGULAR TEXT COLOR now
			    (appearance wave, 2026-09-26) — the empty-state labels say
			    so; explicit hex overrides ride unchanged. */}
			<SettingsRow label="Bold color" hint="Empty = same as text" testid="row-bold-color">
				<CommitInput
					value={md?.boldColor ?? ""}
					placeholder="same as text"
					ariaLabel="bold color"
					testid="input-bold-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, boldColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
			<SettingsRow label="Italic color" hint="Empty = same as text" testid="row-italic-color">
				<CommitInput
					value={md?.italicColor ?? ""}
					placeholder="same as text"
					ariaLabel="italic color"
					testid="input-italic-color"
					onCommit={(v) => onSectionChange({ ...appearance, mdRendering: { ...md, italicColor: v === "" ? null : v } })}
				/>
			</SettingsRow>
		</>
	);
}

export function GraphSection({
	graph,
	onSectionChange,
}: {
	graph: GraphSettings | undefined;
	onSectionChange: (next: GraphSettings) => void;
}) {
	// Wave 7 collapse (owner ruling 2026-09-23): the section is the MASTER
	// SWITCH — the embedding/clustering/labeling rungs are gone; clustering
	// is the free birth-session partition derived on read, labels ARE session
	// names. The chunk budget (2026-10-02) joined it as the section's second
	// and only other control: it denominates the coverage ring AND gates the
	// auto-extraction trigger (turn settle ≥ budget fires the run).
	//
	// Resolved through the SAME core resolver the server's effective
	// settings use (one source of truth, the 4096-fallback fix 2026-10-02):
	// the hint and placeholder report exactly the number the trigger waits
	// for — never a second hand-rolled default.
	const resolved = resolveSettings(graph === undefined ? null : { version: 1, graph }).graph;
	return (
		<>
			{/* EXTRACTION (renamed, owner 2026-10-06): this switch is the DATA
			    channel — the pipeline, the auditor, the prober's graph tools. It
			    was born labeled "Graph" and that label lied once the rendering
			    switch below arrived: off ≠ no graph, off = the graph stops
			    growing. The testid keeps the old name's shape (row-enabled) so
			    this stays one rename, not a test re-pin. */}
			<SettingsRow label="Extraction" hint="Off = the graph stops growing" testid="graph-row-enabled">
				<Toggle
					checked={graph?.enabled ?? true}
					label="extraction enabled"
					onChange={(on) =>
						// Compose, never replace-whole (the section PUT is, but the
					// row must not drop its sibling field — fixed with the budget
					// row's arrival: the old { enabled: on } wiped a stored budget).
						onSectionChange({ ...graph, enabled: on })
					}
				/>
			</SettingsRow>
			{/* GRAPH RENDERING (owner, 2026-10-06 — the release graph-controls
			    round): display-only. Off = the home shows the chains view
			    instead of the canvas. The ledgers, the pipeline, everything
			    data keeps working — that is the extraction switch above. */}
			<SettingsRow label="Graph rendering" hint="Off = home shows the chains view" testid="graph-row-rendering">
				<Toggle
					checked={graph?.rendering ?? true}
					label="graph rendering enabled"
					onChange={(on) => onSectionChange({ ...graph, rendering: on })}
				/>
			</SettingsRow>
			<SettingsRow
				label="Extraction chunk budget"
				hint={`${resolved.extractionChunkTokens} tok`}
				testid="graph-row-chunk-tokens"
			>
				<CommitInput
					type="number"
					value={String(graph?.extractionChunkTokens ?? "")}
					placeholder={String(resolved.extractionChunkTokens)}
					ariaLabel="extraction chunk budget"
					testid="input-chunk-tokens"
					onCommit={(v) => {
						// Empty = factory default (the fix-wave discipline): absence is
						// the unset for numbers — Number("") is 0, so clamping would
						// write the floor instead of unsetting.
						if (v === "") {
							onSectionChange({ ...graph, extractionChunkTokens: undefined });
							return;
						}
						const n = Number(v);
						if (!Number.isFinite(n) || n <= 0) return; // bad input: no write
						// Mirror the server sanitize exactly: floor only (cost
						// protection), no ceiling — a big budget is the user's call.
						onSectionChange({
							...graph,
							extractionChunkTokens: Math.max(EXTRACTION_CHUNK_TOKENS_FLOOR, Math.round(n)),
						});
					}}
				/>
			</SettingsRow>
		</>
	);
}