/**
 * Uploaded VS Code themes: the file mapping, the validation that keeps
 * anything unchecked out of the page's CSS, the store, the "custom"
 * appearance mode, and the shared code-highlighter plugin.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { THEMES_FILE } from "../config.ts";
import {
	CUSTOM_THEME_LIMITS,
	CUSTOM_THEME_TOKENS,
	ThemeFileError,
	contrastRatio,
	customThemeCss,
	normalizeHexColor,
	parseJsonc,
	sanitizeCustomTheme,
	sanitizeTokenColors,
	vscodeThemeToCustom,
	type CustomTheme,
} from "../src/core/vscode-theme.ts";
import { appearanceModeClass, sanitizeUserSettings } from "../src/core/settings.ts";
import { resolveSettings } from "../src/core/settings-resolution.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";
import { addTheme, deleteTheme, getTheme, listThemes, ThemeStoreFullError } from "../src/store/themes.ts";

/** A One Dark Pro-like file: comments, trailing commas, a `//` in a string. */
const ONE_DARK = `{
	// One Dark Pro (trimmed)
	"name": "One Dark Pro",
	"type": "dark",
	"semanticHighlighting": true,
	"colors": {
		"editor.background": "#282c34",
		"editor.foreground": "#abb2bf",
		"editorWidget.background": "#21252b",
		"button.background": "#404754",
		"focusBorder": "#3e4452",
		"textLink.foreground": "#61afef",
		"list.hoverBackground": "#2c313a",
		"panel.border": "#3e4452",
		"descriptionForeground": "#abb2bf",
		"editor.selectionBackground": "#67769660", /* half-transparent */
	},
	"tokenColors": [
		{ "name": "url // not a comment", "scope": "markup.underline.link", "settings": { "foreground": "#61afef" } },
		{ "scope": ["keyword", "storage.type"], "settings": { "foreground": "#c678dd", "fontStyle": "italic" } },
		{ "scope": "string", "settings": { "foreground": "#98c379" } },
	],
}`;

const mapped = () => vscodeThemeToCustom(ONE_DARK, "OneDark-Pro.json");

describe("parseJsonc", () => {
	it("drops comments and trailing commas, keeps comment markers inside strings", () => {
		const parsed = parseJsonc(`{ /* c */ "a": "http://x // y", "b": [1, 2,], // tail
			"c": "/* not a comment */", }`) as Record<string, unknown>;
		assert.deepEqual(parsed, { a: "http://x // y", b: [1, 2], c: "/* not a comment */" });
	});

	it("ignores a leading byte-order mark", () => {
		assert.deepEqual(parseJsonc("\uFEFF{ \"a\": 1 }"), { a: 1 });
	});

	it("reports invalid JSON as a theme file error", () => {
		assert.throws(() => parseJsonc("{ nope"), ThemeFileError);
	});
});

describe("normalizeHexColor", () => {
	it("accepts the four hex forms and drops a full alpha", () => {
		assert.equal(normalizeHexColor("#ABC"), "#aabbcc");
		assert.equal(normalizeHexColor("#abcf"), "#aabbcc");
		assert.equal(normalizeHexColor("#abc8"), "#aabbcc88");
		assert.equal(normalizeHexColor("#123456"), "#123456");
		assert.equal(normalizeHexColor("#12345680"), "#12345680");
		assert.equal(normalizeHexColor("#123456ff"), "#123456");
	});

	it("rejects everything else, including CSS that could break out", () => {
		for (const bad of ["red", "rgb(1,2,3)", "#12", "#1234567", "#zzzzzz", "#fff;} body{display:none", "", 7, null]) {
			assert.equal(normalizeHexColor(bad), null, String(bad));
		}
	});
});

describe("vscodeThemeToCustom", () => {
	it("maps a theme's roles onto the app tokens", () => {
		const { theme, warnings } = mapped();
		assert.equal(theme.name, "One Dark Pro");
		assert.equal(theme.type, "dark");
		assert.equal(theme.colors.background, "#282c34");
		assert.equal(theme.colors.foreground, "#abb2bf");
		assert.equal(theme.colors.card, "#21252b");
		assert.equal(theme.colors.accent, "#2c313a");
		assert.equal(theme.colors.border, "#3e4452");
		// The keyword color becomes the callout, as in the hand-made palette.
		assert.equal(theme.colors["lh-callout-border"], "#c678dd");
		assert.equal(theme.selection, "#67769660");
		assert.deepEqual(warnings, []);
		for (const token of CUSTOM_THEME_TOKENS) assert.match(theme.colors[token], /^#[0-9a-f]{6}$/, token);
	});

	it("keeps text readable: dimmer muted text, legible button text, a visible focus ring", () => {
		const { colors } = mapped().theme;
		// descriptionForeground equals body text here: muted must still dim.
		assert.ok(contrastRatio(colors["muted-foreground"], colors.background) < contrastRatio(colors.foreground, colors.background));
		assert.ok(contrastRatio(colors["muted-foreground"], colors.background) >= 2.5);
		assert.ok(contrastRatio(colors["primary-foreground"], colors.primary) >= 3);
		// focusBorder is nearly the page color, so the ring falls back to primary.
		assert.equal(colors.ring, colors.primary);
	});

	it("carries the syntax rules for code blocks, validated", () => {
		const code = mapped().theme.code!;
		assert.equal(code.type, "dark");
		assert.deepEqual(code.colors, { "editor.background": "#282c34", "editor.foreground": "#abb2bf" });
		assert.equal(code.tokenColors.length, 3);
		assert.deepEqual(code.tokenColors[1], { scope: ["keyword", "storage.type"], settings: { foreground: "#c678dd", fontStyle: "italic" } });
	});

	it("infers light vs dark from the background when the file doesn't say", () => {
		const light = vscodeThemeToCustom(JSON.stringify({ colors: { "editor.background": "#fdf6e3", "editor.foreground": "#657b83" } }));
		assert.equal(light.theme.type, "light");
		const dark = vscodeThemeToCustom(JSON.stringify({ colors: { "editor.background": "#101010" } }));
		assert.equal(dark.theme.type, "dark");
	});

	it("fills missing roles with surfaces that still read as different from the page", () => {
		const { theme } = vscodeThemeToCustom(JSON.stringify({ type: "dark", colors: { "editor.background": "#1e1e1e", "sideBar.background": "#1e1e1e" } }));
		assert.notEqual(theme.colors.card, theme.colors.background);
		assert.notEqual(theme.colors.accent, theme.colors.background);
		assert.notEqual(theme.colors.border, theme.colors.background);
	});

	it("keeps input outlines when the theme hides them", () => {
		const { theme } = vscodeThemeToCustom(JSON.stringify({ type: "dark", colors: { "editor.background": "#1e1e1e", "input.border": "#00000000", "panel.border": "#444444" } }));
		assert.equal(theme.colors.input, "#444444");
	});

	it("warns about an include it can't follow and missing syntax colors", () => {
		const { warnings, theme } = vscodeThemeToCustom(JSON.stringify({ include: "./dark_plus.json", colors: { "editor.background": "#1f1f1f" } }));
		assert.equal(warnings.length, 2);
		assert.match(warnings[0]!, /dark_plus\.json/);
		assert.match(warnings[1]!, /no syntax colors/);
		assert.equal(theme.code, undefined);
		const separate = vscodeThemeToCustom(JSON.stringify({ colors: { "editor.background": "#1f1f1f" }, tokenColors: "./syntax.json" }));
		assert.match(separate.warnings[0]!, /separate file/);
	});

	it("names a nameless theme after its file", () => {
		assert.equal(vscodeThemeToCustom(JSON.stringify({ colors: { "editor.background": "#000000" } }), "night-owl_color.json").theme.name, "Night Owl Color");
		assert.equal(vscodeThemeToCustom(JSON.stringify({ colors: { "editor.background": "#000000" } })).theme.name, "Uploaded theme");
	});

	it("refuses files that can't be a color theme", () => {
		assert.throws(() => vscodeThemeToCustom("[1, 2]"), ThemeFileError);
		assert.throws(() => vscodeThemeToCustom(JSON.stringify({ name: "x" })), /No theme colors found/);
		assert.throws(() => vscodeThemeToCustom(" ".repeat(CUSTOM_THEME_LIMITS.fileChars + 1)), /too large/);
	});
});

describe("validation before CSS", () => {
	const stored = (): CustomTheme => ({ id: "theme_abc123", ...mapped().theme });

	it("sanitizeTokenColors keeps well-formed rules only", () => {
		const rules = sanitizeTokenColors([
			{ scope: "string", settings: { foreground: "#98c379" } },
			{ scope: "bad", settings: { foreground: "red" } }, // no valid setting left
			{ scope: 42, settings: { foreground: "#ffffff" } }, // bad scope
			{ settings: { foreground: "#abb2bf", background: "#282c34" } }, // global rule
			{ scope: "x", settings: { fontStyle: "bold; color: red" } },
			"nope",
		]);
		assert.deepEqual(rules, [
			{ scope: "string", settings: { foreground: "#98c379" } },
			{ settings: { foreground: "#abb2bf", background: "#282c34" } },
		]);
	});

	it("sanitizeCustomTheme rejects bad ids and colors", () => {
		assert.ok(sanitizeCustomTheme(stored()));
		assert.equal(sanitizeCustomTheme({ ...stored(), id: "theme_x;}" }), null);
		assert.equal(sanitizeCustomTheme({ ...stored(), colors: { ...stored().colors, primary: "red" } }), null);
		assert.equal(sanitizeCustomTheme({ ...stored(), selection: "url(x)" }), null);
	});

	it("customThemeCss holds only the theme's class, token names and hex colors", () => {
		const css = customThemeCss({ ...stored(), name: "</style><script>alert(1)</script>" });
		assert.match(css, /^\.lh-custom\.lh-theme-theme_abc123\{color-scheme:dark;/);
		assert.ok(css.includes("--background:#282c34;"));
		assert.ok(css.includes("::selection{background:#67769660;}"));
		assert.ok(!css.includes("script"));
		const stripped = css.replace(/#[0-9a-f]{6,8}/g, "").replace(/--[a-z-]+:/g, "");
		assert.match(stripped, /^[.a-z_0-9{}:;\-() ]+$/);
		// Anything that fails validation renders nothing at all.
		assert.equal(customThemeCss({ ...stored(), selection: "red" }), "");
	});
});

describe("the custom appearance mode", () => {
	it("puts the theme's classes on <html>, dark only for dark themes, Dark when the theme is gone", () => {
		assert.equal(appearanceModeClass("custom", { id: "theme_abc123", type: "dark" }), "dark lh-custom lh-theme-theme_abc123");
		assert.equal(appearanceModeClass("custom", { id: "theme_abc123", type: "light" }), "lh-custom lh-theme-theme_abc123");
		assert.equal(appearanceModeClass("custom", null), "dark");
		assert.equal(appearanceModeClass("custom"), "dark");
	});

	it("stores the picked theme's id; bad ids are dropped or refused", () => {
		const record = sanitizeUserSettings({ version: 1, appearance: { mode: "custom", customThemeId: "theme_abc123" } });
		assert.equal(record?.appearance?.customThemeId, "theme_abc123");
		assert.equal(resolveSettings(record).appearance.customThemeId, "theme_abc123");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { customThemeId: "../x" } })?.appearance?.customThemeId, null);
		assert.ok(parseAppearanceSettingsBody({ mode: "custom", customThemeId: "theme_abc123" }).ok);
		assert.ok(parseAppearanceSettingsBody({ customThemeId: null }).ok);
		assert.equal(parseAppearanceSettingsBody({ customThemeId: "nope" }).ok, false);
	});
});

describe("themes store", () => {
	it("adds, lists, reads and deletes themes, and caps the list", () => {
		const backup = fs.existsSync(THEMES_FILE) ? fs.readFileSync(THEMES_FILE) : undefined;
		try {
			if (backup) fs.unlinkSync(THEMES_FILE);
			const added = addTheme(mapped().theme);
			assert.match(added.id, /^theme_[a-z0-9]+$/);
			assert.deepEqual(listThemes().map((t) => t.name), ["One Dark Pro"]);
			assert.equal(getTheme(added.id)?.code?.tokenColors.length, 3);
			// A hand-edited file can't smuggle a bad color in: it's dropped on read.
			const file = JSON.parse(fs.readFileSync(THEMES_FILE, "utf-8"));
			file.themes.push({ ...file.themes[0], id: "theme_bad000", colors: { ...file.themes[0].colors, primary: "red" } });
			fs.writeFileSync(THEMES_FILE, JSON.stringify(file));
			assert.equal(listThemes().length, 1);
			assert.equal(deleteTheme(added.id), true);
			// An unreadable file is moved aside, never overwritten by a write.
			fs.writeFileSync(THEMES_FILE, "{ not json");
			assert.deepEqual(listThemes(), []);
			const fresh = addTheme(mapped().theme);
			const dir = path.dirname(THEMES_FILE);
			const asides = fs.readdirSync(dir).filter((f) => f.startsWith(`${path.basename(THEMES_FILE)}.unreadable-`));
			assert.equal(asides.length, 1);
			assert.equal(fs.readFileSync(path.join(dir, asides[0]!), "utf-8"), "{ not json");
			for (const f of asides) fs.rmSync(path.join(dir, f));
			assert.equal(deleteTheme(fresh.id), true);
			assert.equal(deleteTheme(added.id), false);
			assert.equal(getTheme(added.id), null);
			for (let i = 0; i < CUSTOM_THEME_LIMITS.themes; i++) addTheme(mapped().theme);
			assert.throws(() => addTheme(mapped().theme), ThemeStoreFullError);
		} finally {
			if (backup) fs.writeFileSync(THEMES_FILE, backup);
			else fs.rmSync(THEMES_FILE, { force: true });
		}
	});
});

describe("code blocks follow the uploaded theme", () => {
	it("shares one highlighter plugin per theme, and the default without one", async () => {
		const React = (await import("react")).default;
		(globalThis as Record<string, unknown>).React = React;
		const { renderToStaticMarkup } = await import("react-dom/server");
		const { CodeThemeContext } = await import("../components/code-theme.tsx");
		const { streamdownPlugins, useStreamdownPlugins } = await import("../components/ai-elements/message.tsx");
		const seen: unknown[] = [];
		const Probe = () => {
			seen.push(useStreamdownPlugins());
			return null;
		};
		const code = mapped().theme.code!;
		const value = { id: "theme_abc123", code };
		renderToStaticMarkup(React.createElement(Probe));
		renderToStaticMarkup(React.createElement(CodeThemeContext.Provider, { value }, React.createElement(Probe)));
		renderToStaticMarkup(React.createElement(CodeThemeContext.Provider, { value: { ...value } }, React.createElement(Probe)));
		assert.equal(seen[0], streamdownPlugins);
		assert.notEqual(seen[1], streamdownPlugins);
		assert.equal(seen[1], seen[2], "one plugin object per theme id");
		const themes = (seen[1] as { code: { getThemes: () => unknown[] } }).code.getThemes();
		assert.equal(themes[0], "github-light");
		assert.equal((themes[1] as { name: string }).name, "lh-theme_abc123");
	});
});
