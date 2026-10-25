/**
 * The Paper and One Dark Pro themes: the "paper" and "onedark" appearance
 * modes (settings schema, API body, <html> classes), the dark-only custom
 * background, the theme tokens that replaced hard-coded dark colors, and the
 * stylesheet's .paper / .onedark palettes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import { confidenceRailStyle } from "../components/confidence-rail.tsx";
import { mermaidTheme, oneDarkMermaidTheme, paperMermaidTheme } from "../components/mermaid-render.ts";
import {
	APPEARANCE_MODES,
	appearanceChoice,
	appearanceModeClass,
	isAppearanceMode,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

describe("the paper appearance mode", () => {
	it("is a known mode alongside dark, the reserved light, and onedark", () => {
		assert.deepEqual([...APPEARANCE_MODES], ["dark", "light", "paper", "onedark"]);
		assert.equal(isAppearanceMode("paper"), true);
		assert.equal(isAppearanceMode("onedark"), true);
		assert.equal(isAppearanceMode("sepia"), false);
		assert.equal(isAppearanceMode(undefined), false);
	});

	it("maps to <html> classes; light renders dark until it has a palette", () => {
		assert.equal(appearanceModeClass("paper"), "paper");
		assert.equal(appearanceModeClass("dark"), "dark");
		assert.equal(appearanceModeClass("light"), "dark");
		assert.equal(appearanceModeClass(undefined), "dark");
		// One Dark Pro keeps "dark" so code blocks use their dark syntax colors.
		assert.equal(appearanceModeClass("onedark"), "dark onedark");
	});

	it("the settings choice hides the reserved light mode", () => {
		assert.equal(appearanceChoice("light"), "dark");
		assert.equal(appearanceChoice("onedark"), "onedark");
		assert.equal(appearanceChoice("paper"), "paper");
		assert.equal(appearanceChoice(undefined), "dark");
	});

	it("survives the settings sanitizer; unknown modes are dropped", () => {
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "paper" } })?.appearance?.mode, "paper");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "onedark" } })?.appearance?.mode, "onedark");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "sepia" } })?.appearance?.mode, undefined);
	});

	it("is accepted by the appearance PUT body; unknown modes are rejected with the list", () => {
		const ok = parseAppearanceSettingsBody({ mode: "paper" });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings, { mode: "paper" });
		assert.ok(parseAppearanceSettingsBody({ mode: "onedark" }).ok);
		const bad = parseAppearanceSettingsBody({ mode: "sepia" });
		assert.equal(bad.ok, false);
		assert.match(bad.error, /dark, light, paper, onedark/);
	});
});

describe("custom background is dark-only", () => {
	it("applies its derived palette in dark mode", () => {
		const vars = appearanceVars(resolveAppearance({ mode: "dark", background: "#202020" }));
		assert.equal(vars["--background"], "#202020");
	});

	it("is ignored in Paper and One Dark Pro, which keep their own palettes", () => {
		for (const mode of ["paper", "onedark"] as const) {
			const vars = appearanceVars(resolveAppearance({ mode, background: "#202020" }));
			assert.equal(vars["--background"], undefined, mode);
			assert.equal(vars["--card"], undefined, mode);
			// Non-color settings still apply.
			assert.equal(vars["--lh-prose-size"], "16px", mode);
		}
	});
});

describe("hard-coded dark colors became theme tokens", () => {
	it("the confidence rail sits on the page background with foreground ticks", () => {
		const style = confidenceRailStyle(50);
		assert.equal(style.backgroundColor, "var(--background)");
		assert.match(String(style.backgroundImage), /color-mix\(in srgb, var\(--foreground\) 35%, transparent\)/);
		assert.ok(!String(style.backgroundImage).includes("rgba(230,230,230"));
	});

	it("diagrams keep mermaid's dark theme in dark, and get a Paper palette in Paper", () => {
		assert.equal(mermaidTheme.theme, "dark");
		assert.equal(paperMermaidTheme.theme, "base");
		assert.equal(paperMermaidTheme.themeVariables?.primaryBorderColor, "#8a3b2c");
		assert.equal(paperMermaidTheme.securityLevel, "strict", "inherits the safe defaults");
		assert.equal(oneDarkMermaidTheme.theme, "base");
		assert.equal(oneDarkMermaidTheme.themeVariables?.darkMode, true);
		assert.equal(oneDarkMermaidTheme.themeVariables?.primaryBorderColor, "#61afef");
		assert.equal(oneDarkMermaidTheme.securityLevel, "strict");
	});
});

describe("globals.css theme palettes", () => {
	const css = readFileSync(path.join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
	const block = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} block exists`);
		return css.slice(start, css.indexOf("\n}", start));
	};
	const tokens = (body: string) => new Set([...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));

	it("sets the browser's form controls and scrollbars to match each theme", () => {
		assert.match(block(".paper"), /color-scheme: light;/);
		assert.match(block(".onedark"), /color-scheme: dark;/);
	});

	it("each theme defines every color token the default defines (no leftovers from dark)", () => {
		const layoutOnly = new Set(["--radius", "--lh-prose-size", "--lh-prose-leading", "--lh-heading-weight"]);
		for (const selector of [".paper", ".onedark"]) {
			const theme = tokens(block(selector));
			const missing = [...tokens(block(":root"))].filter((t) => !layoutOnly.has(t) && !theme.has(t));
			assert.deepEqual(missing, [], selector);
		}
	});

	it("One Dark Pro comes after .dark, so its tokens win on <html class=\"dark onedark\">", () => {
		assert.ok(css.indexOf("\n.onedark {") > css.indexOf("\n.dark {"));
		assert.match(block(".onedark"), /--background: #282c34;/);
	});

	it("keeps dark's former hard-coded values for the new ink tokens", () => {
		for (const selector of [":root", ".dark"]) {
			const body = block(selector);
			assert.match(body, /--lh-mark-ink: #ffffff;/);
			assert.match(body, /--lh-mark-ring: rgb\(148, 148, 148\);/);
			assert.match(body, /--lh-callout-border: #ffffff;/);
			assert.match(body, /--lh-strong-line: #ffffff;/);
		}
	});
});
