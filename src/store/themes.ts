/**
 * The uploaded VS Code themes (data/themes.json): a small list, kept out of
 * settings.json because section writes replace the whole section and a
 * theme's syntax rules can run to tens of kilobytes. Appearance settings
 * hold only the picked theme's id. Every read re-validates
 * (sanitizeCustomTheme), so a hand-edited or older file can't put anything
 * unchecked into the page's CSS.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { THEMES_FILE } from "../../config.ts";
import { CUSTOM_THEME_LIMITS, sanitizeCustomTheme, type CustomTheme } from "../core/vscode-theme.ts";

export class ThemeStoreFullError extends Error {}

/** The stored entries, unvalidated, or null when the file exists but can't
 *  be read as a theme list. */
function readRaw(): unknown[] | null {
	let text: string;
	try {
		text = fs.readFileSync(THEMES_FILE, "utf-8");
	} catch {
		return []; // none uploaded yet
	}
	try {
		const list = (JSON.parse(text) as { themes?: unknown })?.themes;
		return Array.isArray(list) ? list : null;
	} catch {
		return null;
	}
}

/** The stored themes, each re-validated (invalid ones are dropped), or null
 *  when the file can't be read. */
function readFile(): CustomTheme[] | null {
	const list = readRaw();
	return list && list.map(sanitizeCustomTheme).filter((t): t is CustomTheme => t !== null);
}

function readAll(): CustomTheme[] {
	return readFile() ?? [];
}

/** The list a write starts from. An unreadable file is moved aside first
 *  (themes.json.unreadable-<time>), so a write never destroys themes it
 *  couldn't read. */
function readForWrite(): CustomTheme[] {
	const themes = readFile();
	if (themes) return themes;
	fs.renameSync(THEMES_FILE, `${THEMES_FILE}.unreadable-${Date.now()}`);
	console.error(`[themes] ${THEMES_FILE} was unreadable; moved it aside before writing`);
	return [];
}

function writeAll(themes: CustomTheme[]): void {
	fs.mkdirSync(path.dirname(THEMES_FILE), { recursive: true });
	const tmp = `${THEMES_FILE}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ version: 1, themes }, null, "\t"), "utf-8");
	fs.renameSync(tmp, THEMES_FILE);
}

export function listThemes(): CustomTheme[] {
	return readAll();
}

/** One theme, validated on its own: the layout asks on every request, so
 *  the other themes' syntax rules aren't re-checked for it. */
export function getTheme(id: string): CustomTheme | null {
	const entry = readRaw()?.find((t) => (t as { id?: unknown } | null)?.id === id);
	return entry ? sanitizeCustomTheme(entry) : null;
}

/** Store a mapped theme under a fresh id. Throws ThemeStoreFullError at the cap. */
export function addTheme(theme: Omit<CustomTheme, "id">): CustomTheme {
	const themes = readForWrite();
	if (themes.length >= CUSTOM_THEME_LIMITS.themes) {
		throw new ThemeStoreFullError(`You can keep up to ${CUSTOM_THEME_LIMITS.themes} uploaded themes. Delete one first.`);
	}
	const stored = sanitizeCustomTheme({ ...theme, id: `theme_${randomBytes(6).toString("hex")}` });
	if (!stored) throw new Error("The mapped theme failed validation");
	writeAll([...themes, stored]);
	return stored;
}

/** Remove a theme; false when the id is unknown. */
export function deleteTheme(id: string): boolean {
	const themes = readForWrite();
	const next = themes.filter((t) => t.id !== id);
	if (next.length === themes.length) return false;
	writeAll(next);
	return true;
}
