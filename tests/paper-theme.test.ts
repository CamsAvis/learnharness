/**
 * The Paper theme: the "paper" appearance mode (settings schema, API body,
 * <html> class), the dark-only custom background, the theme tokens that
 * replaced hard-coded dark colors, and the stylesheet's .paper palette.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { appearanceVars, resolveAppearance } from "../components/settings/appearance.tsx";
import { confidenceRailStyle } from "../components/confidence-rail.tsx";
import { mermaidTheme, paperMermaidTheme } from "../components/mermaid-render.ts";
import {
	APPEARANCE_MODES,
	appearanceModeClass,
	isAppearanceMode,
	sanitizeUserSettings,
} from "../src/core/settings.ts";
import { parseAppearanceSettingsBody } from "../src/server/settings-body.ts";

describe("the paper appearance mode", () => {
	it("is a known mode alongside dark and the reserved light", () => {
		assert.deepEqual([...APPEARANCE_MODES], ["dark", "light", "paper"]);
		assert.equal(isAppearanceMode("paper"), true);
		assert.equal(isAppearanceMode("sepia"), false);
		assert.equal(isAppearanceMode(undefined), false);
	});

	it("maps to an <html> class; light renders dark until it has a palette", () => {
		assert.equal(appearanceModeClass("paper"), "paper");
		assert.equal(appearanceModeClass("dark"), "dark");
		assert.equal(appearanceModeClass("light"), "dark");
		assert.equal(appearanceModeClass(undefined), "dark");
	});

	it("survives the settings sanitizer; unknown modes are dropped", () => {
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "paper" } })?.appearance?.mode, "paper");
		assert.equal(sanitizeUserSettings({ version: 1, appearance: { mode: "sepia" } })?.appearance?.mode, undefined);
	});

	it("is accepted by the appearance PUT body; unknown modes are rejected with the list", () => {
		const ok = parseAppearanceSettingsBody({ mode: "paper" });
		assert.ok(ok.ok);
		assert.deepEqual(ok.settings, { mode: "paper" });
		const bad = parseAppearanceSettingsBody({ mode: "sepia" });
		assert.equal(bad.ok, false);
		assert.match(bad.error, /dark, light, paper/);
	});
});

describe("custom background is dark-only", () => {
	it("applies its derived palette in dark mode", () => {
		const vars = appearanceVars(resolveAppearance({ mode: "dark", background: "#202020" }));
		assert.equal(vars["--background"], "#202020");
	});

	it("is ignored in Paper, which keeps its own palette", () => {
		const vars = appearanceVars(resolveAppearance({ mode: "paper", background: "#202020" }));
		assert.equal(vars["--background"], undefined);
		assert.equal(vars["--card"], undefined);
		// Non-color settings still apply.
		assert.equal(vars["--lh-prose-size"], "16px");
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
	});
});

describe("globals.css .paper palette", () => {
	const css = readFileSync(path.join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
	const block = (selector: string) => {
		const start = css.indexOf(`\n${selector} {`);
		assert.ok(start >= 0, `${selector} block exists`);
		return css.slice(start, css.indexOf("\n}", start));
	};
	const tokens = (body: string) => new Set([...body.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]!));

	it("switches the browser to light form controls and scrollbars", () => {
		assert.match(block(".paper"), /color-scheme: light;/);
	});

	it("defines every color token the default theme defines (no dark leftovers on paper)", () => {
		const layoutOnly = new Set(["--radius", "--lh-prose-size", "--lh-prose-leading", "--lh-heading-weight"]);
		const paper = tokens(block(".paper"));
		const missing = [...tokens(block(":root"))].filter((t) => !layoutOnly.has(t) && !paper.has(t));
		assert.deepEqual(missing, []);
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
