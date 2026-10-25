/**
 * The app's ONE mermaid renderer (the chrome-melt wave, 2026-09-19): both the
 * in-chat block (components/md-blocks.tsx) and the session-scoped focus
 * overlay (components/session-overlay.tsx) render charts through this module
 * — one dark-theme config, one plugin instance, unique render ids. This
 * REPLACES streamdown's internal mermaid path entirely: its fullscreen portal
 * was hard-wired `fixed inset-0` (covering the window-drag bar, X landing in
 * drag territory) with no styling hook, which is what drove the custom
 * component in the first place.
 */

import { createMermaidPlugin } from "@streamdown/mermaid";
import type { MermaidConfig } from "mermaid";

/** The chart's base font size (px) — mermaid sizes ALL text relative to
 *  this, so it's the number the display-width cap (md-blocks) divides by:
 *  a chart shown at its natural width renders text at exactly this size.
 *  Pinned explicitly so a mermaid default change can't silently shift the
 *  cap (owner rule, chrome-melt tweaks wave, 2026-09-19: chart text must
 *  never render larger than the session's own text). */
export const MERMAID_FONT_SIZE = 16;

// Dark mode (html.dark, the default) renders in mermaid's dark theme. (Moved
// from ai-elements/message.tsx when the renderer became app-owned; the old
// `mermaid` prop wiring is retired.)
export const mermaidTheme: MermaidConfig = {
	fontFamily: "ui-sans-serif, system-ui, sans-serif",
	fontSize: MERMAID_FONT_SIZE,
	securityLevel: "strict",
	theme: "dark",
};

/** Paper mode (html.paper): mermaid's "base" theme painted with the Paper
 *  palette from globals.css (ivory fills, brown-black ink, burgundy node
 *  borders). Mermaid needs literal colors here, not CSS variables. */
export const paperMermaidTheme: MermaidConfig = {
	...mermaidTheme,
	theme: "base",
	themeVariables: {
		background: "#fcf9f3",
		primaryColor: "#f3ece0",
		primaryTextColor: "#2b2520",
		primaryBorderColor: "#8a3b2c",
		secondaryColor: "#ede6d8",
		tertiaryColor: "#fcf9f3",
		mainBkg: "#f3ece0",
		nodeBorder: "#8a3b2c",
		lineColor: "#7a6d5f",
		textColor: "#2b2520",
		clusterBkg: "#f6f2e9",
		clusterBorder: "#dacfbb",
		edgeLabelBackground: "#fcf9f3",
	},
};

/** One Dark Pro mode (html.dark.onedark): "base" painted with the theme's
 *  own colors (globals.css .onedark): grey panels, blue node borders. */
export const oneDarkMermaidTheme: MermaidConfig = {
	...mermaidTheme,
	theme: "base",
	themeVariables: {
		darkMode: true,
		background: "#282c34",
		primaryColor: "#2c313a",
		primaryTextColor: "#d7dae0",
		primaryBorderColor: "#61afef",
		secondaryColor: "#3a3f4b",
		tertiaryColor: "#21252b",
		mainBkg: "#2c313a",
		nodeBorder: "#61afef",
		lineColor: "#7f848e",
		textColor: "#abb2bf",
		clusterBkg: "#21252b",
		clusterBorder: "#3e4452",
		edgeLabelBackground: "#282c34",
	},
};

/** The theme for the page's current mode, read at render time. Diagrams
 *  already on screen keep the colors they were drawn with until they
 *  re-render (a reload after switching modes). */
function currentMermaidTheme(): MermaidConfig {
	if (typeof document === "undefined") return mermaidTheme;
	const classes = document.documentElement.classList;
	if (classes.contains("paper")) return paperMermaidTheme;
	if (classes.contains("onedark")) return oneDarkMermaidTheme;
	return mermaidTheme;
}

const plugin = createMermaidPlugin();

/** Render one chart source to an svg string. The id is unique per call —
 *  mermaid caches rendered ids, and a repeated id across charts/renders
 *  returns the stale svg (the bug streamdown's own id minting avoids). */
export async function renderMermaid(chart: string): Promise<string> {
	const id = `lh-mermaid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
	const { svg } = await plugin.getMermaid(currentMermaidTheme()).render(id, chart);
	return svg;
}
