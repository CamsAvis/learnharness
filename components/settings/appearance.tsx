"use client";
/**
 * THE APPEARANCE APPLICATION (thin settings wave, 2026-09-19): the settings
 * record's appearance section actually DOES something — resolved against
 * the factory defaults and applied as RUNTIME CSS variables on <html>.
 *
 * Why variables and not className swaps: every seam the settings touch was
 * built token-first (--font-prose, --lh-prose-size, --lh-ink-strong, …),
 * so application is setProperty and nothing re-renders. The mode is a class
 * on <html> ("dark", "paper", or "dark onedark"): the root layout renders it
 * from the saved settings on the server, and this provider swaps it when
 * the setting changes. The palettes live in globals.css (.paper, .onedark).
 * An uploaded VS Code theme ("custom") brings its palette as a style block
 * keyed to its own class (core/vscode-theme.ts customThemeCss): the layout
 * renders the saved one, and this provider writes the block for a theme
 * picked later and hands its syntax colors to code blocks (CodeThemeContext).
 *
 * The provider is mounted at the ROOT LAYOUT level (like ActivityProvider):
 * every page picks appearance up on load. The settings page writes a
 * section, hands the new appearance here, and the vars move immediately.
 *
 * (The open-settings keyboard chord lives in components/keyboard-shortcuts.tsx
 * with the other navigations — mod+, pushes /settings from anywhere.)
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
	FACTORY_SETTINGS,
	appearanceChoice,
	appearanceModeClass,
	customThemeCss,
	type AppearanceSettings,
	type CustomTheme,
} from "@/src/core";
import { CodeThemeContext } from "@/components/code-theme";

/** The id of the head style block that carries a theme picked after load. */
const LIVE_THEME_STYLE_ID = "lh-custom-theme-live";

/** The resolved, fully-concrete appearance view (delta + factory merged). */
export function resolveAppearance(delta: AppearanceSettings | undefined) {
	const f = FACTORY_SETTINGS.appearance;
	return {
		mode: delta?.mode ?? f.mode,
		customThemeId: delta?.customThemeId ?? f.customThemeId,
		background: delta?.background ?? f.background,
		fontFamily: delta?.fontFamily ?? f.fontFamily,
		proseFontSize: delta?.proseFontSize ?? f.proseFontSize,
		sessionNameSerif: delta?.sessionNameSerif ?? f.sessionNameSerif,
		mdRendering: {
			headingWeight: delta?.mdRendering?.headingWeight ?? f.mdRendering.headingWeight,
			boldColor: delta?.mdRendering?.boldColor ?? f.mdRendering.boldColor,
			italicColor: delta?.mdRendering?.italicColor ?? f.mdRendering.italicColor,
		},
	};
}

/** One channel clamped on the dark curve: additive offsets matching today's
 *  hand-picked palette (#141414 → card #1c1c1c (+8) → accent #2a2a2a (+22)
 *  → border #434343 (+47)) — the "per-mode derivation in code" the schema
 *  promises, as the thinnest curve that keeps the palette's relationships. */
function raise(hex: string, add: number): string {
	const n = hex.length === 4
		? hex.slice(1).split("").map((c) => parseInt(c + c, 16))
		: [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
	return `#${n.map((c) => Math.min(255, c + add).toString(16).padStart(2, "0")).join("")}`;
}

/** The derived palette a chosen background implies (dark curve): background
 *  itself, the raised surfaces (card/popover/secondary/muted, +8), the
 *  accent (+22), the edges (border/input, +47), and primary-foreground
 *  (the inverted text on primary = the background's own color, as today). */
export function derivedPalette(background: string): Record<string, string> {
	const card = raise(background, 8);
	const accent = raise(background, 22);
	const border = raise(background, 47);
	return {
		"--background": background,
		"--card": card,
		"--popover": card,
		"--secondary": card,
		"--muted": card,
		"--accent": accent,
		"--border": border,
		"--input": border,
		"--primary-foreground": background,
	};
}

/** THE mapping: resolved appearance → the CSS variables to set on <html>.
 *  Absent entries = leave the factory stylesheet value in place. Pure —
 *  exported for tests. */
export function appearanceVars(a: ReturnType<typeof resolveAppearance>): Record<string, string> {
	const vars: Record<string, string> = {};
	// The custom background derives on the DARK curve (surfaces lighten), so it
	// only applies in plain dark mode; Paper, One Dark Pro and uploaded themes
	// keep their own palettes.
	if (a.background !== null && appearanceChoice(a.mode) === "dark") Object.assign(vars, derivedPalette(a.background));
	if (a.fontFamily !== null) {
		vars["--font-prose"] = `"${a.fontFamily}", var(--font-sans3), ui-sans-serif, system-ui, sans-serif`;
	}
	// The ONE documented reading-size variable (typography round 4): prose,
	// inputs, and session titles all read it, so one setProperty moves them.
	vars["--lh-prose-size"] = `${a.proseFontSize}px`;
	// Session names: CMU Serif by default; the toggle swaps the title font
	// to the prose family — covers chat.tsx + new-session.tsx titles with
	// zero component edits (they use the .font-title utility).
	if (!a.sessionNameSerif) vars["--font-title"] = "var(--font-prose)";
	// Markdown rendering: heading weight + the emphasis inks (the vars
	// were built "ready for the settings UI").
	vars["--lh-heading-weight"] = String(a.mdRendering.headingWeight);
	if (a.mdRendering.boldColor !== null) vars["--lh-ink-strong"] = a.mdRendering.boldColor;
	if (a.mdRendering.italicColor !== null) vars["--lh-ink-italic"] = a.mdRendering.italicColor;
	return vars;
}

/** Pure: the previously-applied names ABSENT from the next var set —
 *  these get removeProperty so the factory stylesheet value returns.
 *  (Owner repro, fix wave: resets and toggle-backs never reverted because
 *  application only ever SET properties — the removal half was missing.)
 *  Exported for tests. */
export function staleVarNames(
	prevNames: readonly string[],
	nextVars: Record<string, string>,
): string[] {
	return prevNames.filter((n) => !(n in nextVars));
}

interface AppearanceContextValue {
	/** Resolved appearance; factory until the record arrives. */
	appearance: ReturnType<typeof resolveAppearance>;
	/** Called by the settings page after a successful section PUT. */
	onAppearanceChange: (delta: AppearanceSettings | undefined) => void;
	/** The uploaded theme on screen (custom mode with its theme loaded). */
	activeTheme: CustomTheme | null;
	/** Hand over a theme the caller already has (a fresh upload), so picking
	 *  it needs no fetch. */
	rememberTheme: (theme: CustomTheme) => void;
}

const AppearanceContext = createContext<AppearanceContextValue>({
	appearance: resolveAppearance(undefined),
	onAppearanceChange: () => {},
	activeTheme: null,
	rememberTheme: () => {},
});

export function useAppearance() {
	return useContext(AppearanceContext);
}

export function AppearanceProvider({
	children,
	initialTheme = null,
}: {
	children: React.ReactNode;
	/** The uploaded theme the server rendered the page with, if any. */
	initialTheme?: CustomTheme | null;
}) {
	const [delta, setDelta] = useState<AppearanceSettings | undefined>(undefined);
	// The server already rendered <html> with the saved mode's class (root
	// layout). Until the record arrives here the delta is unknown, so the
	// class is left alone: syncing the factory "dark" first would flash.
	const [loaded, setLoaded] = useState(false);
	const appliedRef = useRef<string>("");
	const resolved = resolveAppearance(delta);

	// The uploaded theme custom mode points at: the one the page was
	// rendered with, a fresh upload, or fetched when picked. A picked theme
	// still loading keeps the current look (no flash of Dark); one that is
	// gone (deleted elsewhere) renders as Dark.
	const [themes, setThemes] = useState<Record<string, CustomTheme>>(() =>
		initialTheme ? { [initialTheme.id]: initialTheme } : {},
	);
	const [missing, setMissing] = useState<string | null>(null);
	const wantedId = resolved.mode === "custom" ? resolved.customThemeId : null;
	const wanted = wantedId ? (themes[wantedId] ?? null) : null;
	const pending = wantedId !== null && wanted === null && missing !== wantedId;
	useEffect(() => {
		if (!wantedId || themes[wantedId]) return;
		let alive = true;
		fetch(`/api/themes/${encodeURIComponent(wantedId)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((body: { theme?: CustomTheme } | null) => {
				if (!alive) return;
				if (body?.theme) setThemes((all) => ({ ...all, [wantedId]: body.theme! }));
				else setMissing(wantedId);
			})
			.catch(() => {
				if (alive) setMissing(wantedId);
			});
		return () => {
			alive = false;
		};
	}, [wantedId, themes]);
	const rememberTheme = useCallback((theme: CustomTheme) => {
		setThemes((all) => ({ ...all, [theme.id]: theme }));
	}, []);
	// Before the record arrives, the page shows what the server rendered.
	const activeTheme = loaded ? wanted : initialTheme;

	const modeClass = appearanceModeClass(resolved.mode, wanted);
	useEffect(() => {
		if (!loaded || pending) return;
		const root = document.documentElement;
		for (const name of [...root.classList]) {
			if (name === "dark" || name === "paper" || name === "onedark" || name === "lh-custom" || name.startsWith("lh-theme-")) {
				root.classList.remove(name);
			}
		}
		root.classList.add(...modeClass.split(" "));
	}, [loaded, pending, modeClass]);

	// A theme picked after load gets its style block here (the one the page
	// was rendered with already has the layout's). One block, the current
	// theme only; leaving custom mode empties it.
	const liveCss = useMemo(() => (loaded && wanted ? customThemeCss(wanted) : ""), [loaded, wanted]);
	useEffect(() => {
		let el = document.getElementById(LIVE_THEME_STYLE_ID);
		if (!liveCss) {
			el?.remove();
			return;
		}
		if (!el) {
			el = document.createElement("style");
			el.id = LIVE_THEME_STYLE_ID;
			document.head.appendChild(el);
		}
		el.textContent = liveCss;
	}, [liveCss]);
	const codeTheme = useMemo(
		() => (activeTheme?.code ? { id: activeTheme.id, code: activeTheme.code } : null),
		[activeTheme],
	);

	// The vars apply on every change — stringified as the change signal.
	const vars = useMemo(() => appearanceVars(resolveAppearance(delta)), [delta]);
	const key = useMemo(() => JSON.stringify(vars), [vars]);
	// REMOVAL is half the job (owner repro, fix wave): a later write that
	// OMITS a var (empty field = factory, serif toggle back on) must clear
	// the previously-set inline value or the stale one wins forever —
	// backgrounds never reset, toggles looked dead. Every name this effect
	// has ever set is tracked; names absent from the new set are removed so
	// the factory stylesheet value returns.
	const appliedNamesRef = useRef<Set<string>>(new Set());
	useEffect(() => {
		if (appliedRef.current === key) return;
		appliedRef.current = key;
		const root = document.documentElement;
		for (const name of staleVarNames([...appliedNamesRef.current], vars)) {
			root.style.removeProperty(name);
			appliedNamesRef.current.delete(name);
		}
		for (const [name, value] of Object.entries(vars)) {
			root.style.setProperty(name, value);
			appliedNamesRef.current.add(name);
		}
	}, [key, vars]);

	// One fetch per app load: the record (sanitized server-side) carries the
	// delta; resolution happens here against the compiled factory.
	useEffect(() => {
		let alive = true;
		fetch("/api/settings")
			.then((r) => r.json())
			.then((body: { settings?: Record<string, unknown> }) => {
				if (!alive) return;
				// The record arrives sanitized server-side; the appearance
				// slice is unknown-shaped here, so it goes through the same
				// resolve (absent/invalid fields = factory anyway).
				const appearance = body.settings?.appearance;
				setDelta(
					appearance && typeof appearance === "object" ? (appearance as AppearanceSettings) : undefined,
				);
				setLoaded(true);
			})
			.catch(() => {/* settings stay factory — not worth a crash */});
		return () => {
			alive = false;
		};
	}, []);

	const onAppearanceChange = useCallback((next: AppearanceSettings | undefined) => {
		setDelta(next);
		setLoaded(true);
	}, []);

	const value = useMemo(
		() => ({ appearance: resolveAppearance(delta), onAppearanceChange, activeTheme, rememberTheme }),
		[delta, onAppearanceChange, activeTheme, rememberTheme],
	);
	return (
		<AppearanceContext.Provider value={value}>
			<CodeThemeContext.Provider value={codeTheme}>{children}</CodeThemeContext.Provider>
		</AppearanceContext.Provider>
	);
}