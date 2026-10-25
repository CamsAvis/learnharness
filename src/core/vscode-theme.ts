/**
 * UPLOADED VS CODE THEMES: a VS Code color theme file (the JSON inside a
 * theme extension's themes/ folder) mapped onto the app's palette, the same
 * mapping One Dark Pro got by hand (globals.css .onedark), automated.
 *
 * VS Code has hundreds of color slots; the app has about twenty tokens. Each
 * token reads the VS Code colors that play the same role (editor background,
 * widgets, buttons, borders, focus, lists), falls back to a mix of the
 * background and text when a theme leaves them out, and every value is
 * validated as a hex color before it can reach the page's CSS. The theme's
 * tokenColors become the code blocks' syntax theme (Shiki reads the VS Code
 * format natively).
 *
 * Pure and browser-safe: the server maps uploads (POST /api/themes) and
 * re-validates what it stores; the layout and the appearance provider turn
 * a stored theme into CSS with customThemeCss.
 */

/** The app tokens an uploaded theme sets (globals.css :root names, no "--"). */
export const CUSTOM_THEME_TOKENS = [
	"background",
	"foreground",
	"card",
	"card-foreground",
	"popover",
	"popover-foreground",
	"primary",
	"primary-foreground",
	"secondary",
	"secondary-foreground",
	"muted",
	"muted-foreground",
	"accent",
	"accent-foreground",
	"destructive",
	"border",
	"input",
	"ring",
	"lh-mark-ink",
	"lh-mark-ring",
	"lh-callout-border",
	"lh-strong-line",
] as const;
export type CustomThemeToken = (typeof CUSTOM_THEME_TOKENS)[number];

/** One syntax rule, VS Code's tokenColors shape (validated subset). */
export interface CodeTokenColor {
	scope?: string | string[];
	settings: { foreground?: string; background?: string; fontStyle?: string };
}

/** The code blocks' syntax theme (a Shiki/VS Code theme, validated subset). */
export interface CustomCodeTheme {
	type: "dark" | "light";
	colors: { "editor.background": string; "editor.foreground": string };
	tokenColors: CodeTokenColor[];
}

/** A stored uploaded theme. */
export interface CustomTheme {
	id: string;
	name: string;
	type: "dark" | "light";
	colors: Record<CustomThemeToken, string>;
	/** Text selection background (may carry alpha). */
	selection: string;
	/** Syntax colors for code blocks; absent when the file has none usable. */
	code?: CustomCodeTheme;
}

/** What the theme list shows. */
export interface CustomThemeSummary {
	id: string;
	name: string;
	type: "dark" | "light";
}

export const CUSTOM_THEME_LIMITS = {
	/** Largest theme file accepted (characters). */
	fileChars: 1_000_000,
	nameChars: 80,
	tokenColors: 2_000,
	scopeChars: 400,
	/** Most uploaded themes kept. */
	themes: 30,
} as const;

/** Stored theme ids: also used in a CSS class name, so a strict alphabet. */
export const CUSTOM_THEME_ID = /^theme_[a-z0-9]{6,32}$/;

export class ThemeFileError extends Error {}

// ─── JSON with comments ──────────────────────────────────────────────────────

/** Parse JSONC, the format VS Code theme files use: // and block comments
 *  and trailing commas are allowed. Comment markers inside strings are kept. */
export function parseJsonc(raw: string): unknown {
	// A byte-order mark is common in files saved by Windows editors.
	const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
	let out = "";
	let i = 0;
	while (i < text.length) {
		const ch = text[i]!;
		if (ch === '"') {
			// Copy a whole string literal, escapes included.
			let j = i + 1;
			while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
			out += text.slice(i, j + 1);
			i = j + 1;
		} else if (ch === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i++;
		} else if (ch === "/" && text[i + 1] === "*") {
			const end = text.indexOf("*/", i + 2);
			i = end < 0 ? text.length : end + 2;
		} else {
			out += ch;
			i++;
		}
	}
	// Trailing commas: a comma followed only by whitespace before } or ].
	// Safe after comment removal; strings are re-scanned so commas inside
	// them stay.
	let clean = "";
	for (let k = 0; k < out.length; k++) {
		const ch = out[k]!;
		if (ch === '"') {
			let j = k + 1;
			while (j < out.length && out[j] !== '"') j += out[j] === "\\" ? 2 : 1;
			clean += out.slice(k, j + 1);
			k = j;
			continue;
		}
		if (ch === ",") {
			let j = k + 1;
			while (j < out.length && /\s/.test(out[j]!)) j++;
			if (out[j] === "}" || out[j] === "]") continue;
		}
		clean += ch;
	}
	try {
		return JSON.parse(clean);
	} catch (err) {
		throw new ThemeFileError(`This file isn't valid theme JSON (${err instanceof Error ? err.message : String(err)}).`);
	}
}

// ─── colors ──────────────────────────────────────────────────────────────────

type Rgba = [number, number, number, number];

/** A #rgb / #rgba / #rrggbb / #rrggbbaa color as lowercase #rrggbb or
 *  #rrggbbaa, or null for anything else (names, rgb(), garbage). */
export function normalizeHexColor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const v = value.trim().toLowerCase();
	if (/^#[0-9a-f]{3,4}$/.test(v)) return `#${[...v.slice(1)].map((c) => c + c).join("")}`.replace(/^(#[0-9a-f]{6})ff$/, "$1");
	if (/^#[0-9a-f]{6}$/.test(v)) return v;
	if (/^#[0-9a-f]{8}$/.test(v)) return v.endsWith("ff") ? v.slice(0, 7) : v;
	return null;
}

function rgba(hex: string): Rgba {
	const n = (o: number) => parseInt(hex.slice(o, o + 2), 16);
	return [n(1), n(3), n(5), hex.length === 9 ? n(7) / 255 : 1];
}

function hex([r, g, b]: Rgba): string {
	return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** The color painted over an opaque base (alpha composited away). */
function flatten(color: string, over: string): string {
	const [r, g, b, a] = rgba(color);
	if (a >= 1) return color.slice(0, 7);
	const [br, bg, bb] = rgba(over);
	return hex([r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1]);
}

/** t of the way from a to b (both opaque). */
function mix(a: string, b: string, t: number): string {
	const [ar, ag, ab] = rgba(a);
	const [br, bg, bb] = rgba(b);
	return hex([ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t, 1]);
}

function luminance(color: string): number {
	const lin = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	const [r, g, b] = rgba(color);
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two opaque colors (1 to 21). */
export function contrastRatio(a: string, b: string): number {
	const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
	return (x + 0.05) / (y + 0.05);
}

// ─── the mapping ─────────────────────────────────────────────────────────────

const DEFAULTS = {
	dark: { background: "#1e1e1e", foreground: "#d4d4d4", destructive: "#f14c4c" },
	light: { background: "#ffffff", foreground: "#3b3b3b", destructive: "#e51400" },
} as const;

/** A theme file mapped onto the app's palette, plus what was approximated. */
export interface MappedTheme {
	theme: Omit<CustomTheme, "id">;
	warnings: string[];
}

/**
 * Map a VS Code theme file's text to an app theme. Throws ThemeFileError
 * when the file can't be a color theme at all; returns warnings for what
 * had to be approximated (an `include`d base file, missing syntax colors).
 */
export function vscodeThemeToCustom(text: string, fileName?: string): MappedTheme {
	if (text.length > CUSTOM_THEME_LIMITS.fileChars) throw new ThemeFileError("This file is too large to be a color theme.");
	const json = parseJsonc(text);
	if (typeof json !== "object" || json === null || Array.isArray(json)) throw new ThemeFileError("This file isn't a VS Code color theme.");
	const file = json as Record<string, unknown>;
	const rawColors = typeof file.colors === "object" && file.colors !== null && !Array.isArray(file.colors) ? (file.colors as Record<string, unknown>) : {};
	const hasTokenColors = Array.isArray(file.tokenColors) && file.tokenColors.length > 0;
	if (Object.keys(rawColors).length === 0 && !hasTokenColors) {
		throw new ThemeFileError("No theme colors found. Upload a VS Code color theme file (it has a \"colors\" section).");
	}
	const warnings: string[] = [];
	if (typeof file.include === "string") {
		warnings.push(`This theme builds on another file (${file.include}) that wasn't uploaded, so colors it inherits fall back to defaults.`);
	}
	const color = (key: string) => normalizeHexColor(rawColors[key]);

	const declared = file.type === "light" || file.type === "hcLight" || file.type === "vs" ? "light" : file.type === "dark" || file.type === "hc" || file.type === "hcDark" || file.type === "vs-dark" ? "dark" : null;
	const editorBg = color("editor.background");
	const type: "dark" | "light" = declared ?? (editorBg && luminance(flatten(editorBg, "#000000")) > 0.4 ? "light" : "dark");
	const fallback = DEFAULTS[type];

	const background = flatten(editorBg ?? fallback.background, fallback.background);
	const over = (c: string | null) => (c ? flatten(c, background) : null);
	const first = (...keys: string[]) => {
		for (const key of keys) {
			const c = over(color(key));
			if (c) return c;
		}
		return null;
	};
	/** A surface that must read as different from the page. */
	const distinct = (c: string | null, t: number, min = 1.04) => (c && contrastRatio(c, background) >= min ? c : mix(background, foreground, t));

	const foreground = first("editor.foreground", "foreground") ?? fallback.foreground;
	const card = distinct(first("editorWidget.background", "sideBar.background", "panel.background"), 0.05);
	const popover = first("editorSuggestWidget.background", "dropdown.background", "menu.background", "quickInput.background") ?? card;
	let primary = first("button.background", "focusBorder", "textLink.foreground") ?? foreground;
	if (contrastRatio(primary, background) < 1.5) primary = first("textLink.foreground") ?? foreground;
	// Text on buttons: the theme's own button text, else its page or text
	// color when readable (it looks native), else plain black or white.
	const buttonFg = color("button.foreground");
	const primaryForeground =
		buttonFg && contrastRatio(flatten(buttonFg, primary), primary) >= 3
			? flatten(buttonFg, primary)
			: ([background, foreground].find((c) => contrastRatio(c, primary) >= 4.5) ??
				[background, foreground, "#ffffff", "#000000"].reduce((best, c) => (contrastRatio(c, primary) > contrastRatio(best, primary) ? c : best)));
	// Muted text must read as dimmer than body text yet stay legible.
	let mutedForeground = first("descriptionForeground", "editorLineNumber.foreground") ?? mix(foreground, background, 0.4);
	const bodyContrast = contrastRatio(foreground, background);
	if (contrastRatio(mutedForeground, background) < 2.5 || contrastRatio(mutedForeground, background) > bodyContrast * 0.85) {
		mutedForeground = mix(foreground, background, 0.4);
	}
	const accent = distinct(first("list.hoverBackground", "list.inactiveSelectionBackground", "editor.lineHighlightBackground"), 0.1);
	const accentForeground = first("list.hoverForeground", "list.activeSelectionForeground") ?? foreground;
	const border = distinct(first("panel.border", "editorGroup.border", "sideBar.border", "widget.border", "contrastBorder"), 0.18, 1.15);
	// Input outlines: the theme's own, unless it hides them (transparent).
	const inputBorder = first("input.border");
	const input = inputBorder && contrastRatio(inputBorder, background) >= 1.15 ? inputBorder : border;
	const focus = first("focusBorder");
	const ring = focus && contrastRatio(focus, background) >= 1.5 ? focus : primary;
	const destructive = first("errorForeground", "editorError.foreground") ?? fallback.destructive;
	const callout = keywordColor(file.tokenColors, background) ?? primary;
	const selectionRaw = color("editor.selectionBackground");
	const selection = selectionRaw ?? `${primary}40`;

	const colors: Record<CustomThemeToken, string> = {
		background,
		foreground,
		card,
		"card-foreground": foreground,
		popover,
		"popover-foreground": foreground,
		primary,
		"primary-foreground": primaryForeground,
		secondary: card,
		"secondary-foreground": foreground,
		muted: card,
		"muted-foreground": mutedForeground,
		accent,
		"accent-foreground": accentForeground,
		destructive,
		border,
		input,
		ring,
		"lh-mark-ink": foreground,
		"lh-mark-ring": primary,
		"lh-callout-border": callout,
		"lh-strong-line": foreground,
	};

	let code: CustomCodeTheme | undefined;
	const tokenColors = sanitizeTokenColors(file.tokenColors);
	if (tokenColors.length > 0) {
		code = { type, colors: { "editor.background": background, "editor.foreground": foreground }, tokenColors };
	} else if (typeof file.tokenColors === "string") {
		warnings.push("This theme keeps its syntax colors in a separate file, so code blocks keep the default syntax colors.");
	} else {
		warnings.push("This theme has no syntax colors, so code blocks keep the default syntax colors.");
	}

	const name = themeName(file.name, fileName);
	return { theme: { name, type, colors, selection, ...(code ? { code } : {}) }, warnings };
}

function themeName(raw: unknown, fileName: string | undefined): string {
	const fromFile = fileName
		?.replace(/\.(jsonc?|json5)$/i, "")
		.replace(/[-_]+/g, " ")
		.trim()
		.replace(/\b[a-z]/g, (c) => c.toUpperCase());
	const name = (typeof raw === "string" && raw.trim() ? raw.trim() : fromFile) || "Uploaded theme";
	return name.slice(0, CUSTOM_THEME_LIMITS.nameChars);
}

/** The color of a keyword rule (One Dark Pro's purple callout, generalized). */
function keywordColor(tokenColors: unknown, background: string): string | null {
	if (!Array.isArray(tokenColors)) return null;
	for (const rule of tokenColors) {
		if (typeof rule !== "object" || rule === null) continue;
		const r = rule as { scope?: unknown; settings?: { foreground?: unknown } };
		const scopes = typeof r.scope === "string" ? r.scope.split(",") : Array.isArray(r.scope) ? r.scope : [];
		if (!scopes.some((s) => typeof s === "string" && /^\s*keyword(\.control)?\s*$/.test(s))) continue;
		const fg = normalizeHexColor(r.settings?.foreground);
		if (fg) return flatten(fg, background);
	}
	return null;
}

const FONT_STYLE = /^(?:\s*(?:italic|bold|underline|strikethrough)\s*)*$/;

/** tokenColors, keeping only well-formed rules with validated colors. */
export function sanitizeTokenColors(raw: unknown): CodeTokenColor[] {
	if (!Array.isArray(raw)) return [];
	const out: CodeTokenColor[] = [];
	for (const rule of raw) {
		if (out.length >= CUSTOM_THEME_LIMITS.tokenColors) break;
		if (typeof rule !== "object" || rule === null) continue;
		const r = rule as { scope?: unknown; settings?: unknown };
		if (typeof r.settings !== "object" || r.settings === null) continue;
		const s = r.settings as Record<string, unknown>;
		const settings: CodeTokenColor["settings"] = {};
		const fg = normalizeHexColor(s.foreground);
		const bg = normalizeHexColor(s.background);
		if (fg) settings.foreground = fg;
		if (bg) settings.background = bg;
		if (typeof s.fontStyle === "string" && FONT_STYLE.test(s.fontStyle)) settings.fontStyle = s.fontStyle.trim();
		if (Object.keys(settings).length === 0) continue;
		let scope: CodeTokenColor["scope"];
		if (typeof r.scope === "string") scope = r.scope.slice(0, CUSTOM_THEME_LIMITS.scopeChars);
		else if (Array.isArray(r.scope)) {
			const scopes = r.scope.filter((x): x is string => typeof x === "string").map((x) => x.slice(0, CUSTOM_THEME_LIMITS.scopeChars));
			if (scopes.length > 0) scope = scopes;
		}
		if (r.scope !== undefined && scope === undefined) continue;
		out.push(scope === undefined ? { settings } : { scope, settings });
	}
	return out;
}

// ─── stored themes ───────────────────────────────────────────────────────────

/** A stored theme re-validated (disk reads, API bodies), or null. */
export function sanitizeCustomTheme(raw: unknown): CustomTheme | null {
	if (typeof raw !== "object" || raw === null) return null;
	const r = raw as Record<string, unknown>;
	if (typeof r.id !== "string" || !CUSTOM_THEME_ID.test(r.id)) return null;
	if (typeof r.name !== "string" || !r.name.trim()) return null;
	if (r.type !== "dark" && r.type !== "light") return null;
	if (typeof r.colors !== "object" || r.colors === null) return null;
	const rawColors = r.colors as Record<string, unknown>;
	const colors = {} as Record<CustomThemeToken, string>;
	for (const token of CUSTOM_THEME_TOKENS) {
		const c = normalizeHexColor(rawColors[token]);
		if (!c) return null;
		colors[token] = c;
	}
	const selection = normalizeHexColor(r.selection);
	if (!selection) return null;
	const theme: CustomTheme = { id: r.id, name: r.name.trim().slice(0, CUSTOM_THEME_LIMITS.nameChars), type: r.type, colors, selection };
	if (typeof r.code === "object" && r.code !== null) {
		const c = r.code as Record<string, unknown>;
		const editor = (typeof c.colors === "object" && c.colors !== null ? c.colors : {}) as Record<string, unknown>;
		const background = normalizeHexColor(editor["editor.background"]);
		const foreground = normalizeHexColor(editor["editor.foreground"]);
		const tokenColors = sanitizeTokenColors(c.tokenColors);
		if ((c.type === "dark" || c.type === "light") && background && foreground && tokenColors.length > 0) {
			theme.code = { type: c.type, colors: { "editor.background": background, "editor.foreground": foreground }, tokenColors };
		}
	}
	return theme;
}

export function customThemeSummary(theme: CustomTheme): CustomThemeSummary {
	return { id: theme.id, name: theme.name, type: theme.type };
}

/** The html class that carries one stored theme's colors. */
export function customThemeClass(id: string): string {
	return `lh-theme-${id}`;
}

/** The stylesheet for one stored theme: its tokens on its own class, plus
 *  the selection color. Every value it uses (id, type, colors, selection) is
 *  re-validated here, so nothing from the file reaches the CSS raw; the
 *  syntax rules aren't part of the CSS and aren't re-checked. Any invalid
 *  value renders nothing. */
export function customThemeCss(theme: CustomTheme): string {
	if (!CUSTOM_THEME_ID.test(theme.id) || (theme.type !== "dark" && theme.type !== "light")) return "";
	const selection = normalizeHexColor(theme.selection);
	if (!selection) return "";
	let vars = "";
	for (const token of CUSTOM_THEME_TOKENS) {
		const color = normalizeHexColor(theme.colors?.[token]);
		if (!color) return "";
		vars += `--${token}:${color};`;
	}
	const cls = `.lh-custom.${customThemeClass(theme.id)}`;
	return `${cls}{color-scheme:${theme.type};${vars}--lh-ink-strong:var(--foreground);--lh-ink-italic:var(--foreground);}${cls} ::selection{background:${selection};}`;
}
