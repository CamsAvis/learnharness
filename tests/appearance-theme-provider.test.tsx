/**
 * The appearance provider with uploaded themes: picking one fetches it and
 * keeps the current look until it arrives, then swaps the <html> classes and
 * writes its style block; leaving custom mode removes both; a theme that is
 * gone renders as Dark. Interactive (linkedom + act) with a scripted fetch.
 */
import React, { act } from "react";
(globalThis as Record<string, unknown>).React = React;
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { parseHTML } from "linkedom";
import { createRoot, type Root } from "react-dom/client";
import { AppearanceProvider, useAppearance } from "../components/settings/appearance.tsx";
import { useCodeTheme } from "../components/code-theme.tsx";
import { vscodeThemeToCustom, type CustomTheme } from "../src/core/vscode-theme.ts";
import type { AppearanceSettings } from "../src/core/settings.ts";

const dom = parseHTML("<html class=\"paper\"><head></head><body></body></html>");
Object.assign(globalThis, {
	window: dom.window,
	document: dom.document,
	Element: dom.window.Element,
	HTMLElement: dom.window.HTMLElement,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const THEME: CustomTheme = {
	id: "theme_abc123",
	...vscodeThemeToCustom(
		JSON.stringify({
			name: "Test Dark",
			type: "dark",
			colors: { "editor.background": "#202020", "editor.foreground": "#dddddd" },
			tokenColors: [{ scope: "keyword", settings: { foreground: "#c678dd" } }],
		}),
	).theme,
};

function deferred() {
	let resolve!: (r: Response) => void;
	const promise = new Promise<Response>((r) => (resolve = r));
	return { promise, resolve };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

let control!: { change: (d: AppearanceSettings) => void; codeThemeId: string | null };
function Probe() {
	const { onAppearanceChange } = useAppearance();
	const code = useCodeTheme();
	control = { change: onAppearanceChange, codeThemeId: code?.id ?? null };
	return null;
}

const classes = () => [...document.documentElement.classList].sort().join(" ");
const liveStyle = () => document.getElementById("lh-custom-theme-live")?.textContent ?? null;

const originalFetch = globalThis.fetch;
let root: Root | undefined;
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	globalThis.fetch = originalFetch;
	document.documentElement.className = "paper";
	document.getElementById("lh-custom-theme-live")?.remove();
});

async function mount(themeFetch: (id: string) => Promise<Response>) {
	globalThis.fetch = (async (url: string | URL) => {
		const u = String(url);
		if (u === "/api/settings") return json({ settings: { appearance: { mode: "paper" } } });
		const m = /^\/api\/themes\/(.+)$/.exec(u);
		if (m) return themeFetch(decodeURIComponent(m[1]!));
		throw new Error(`unexpected fetch ${u}`);
	}) as typeof fetch;
	const host = document.createElement("div");
	document.body.appendChild(host);
	root = createRoot(host);
	await act(async () =>
		root!.render(
			<AppearanceProvider>
				<Probe />
			</AppearanceProvider>,
		),
	);
}

describe("AppearanceProvider with uploaded themes", () => {
	it("holds the current look while a picked theme loads, then applies it", async () => {
		const load = deferred();
		await mount(() => load.promise);
		assert.equal(classes(), "paper");
		await act(async () => control.change({ mode: "custom", customThemeId: THEME.id }));
		// Still loading: no flash of Dark, no style yet.
		assert.equal(classes(), "paper");
		assert.equal(liveStyle(), null);
		await act(async () => load.resolve(json({ theme: THEME })));
		assert.equal(classes(), "dark lh-custom lh-theme-theme_abc123");
		assert.match(liveStyle()!, /^\.lh-custom\.lh-theme-theme_abc123\{color-scheme:dark;--background:#202020;/);
		assert.equal(control.codeThemeId, THEME.id, "code blocks get the theme's syntax colors");

		// Leaving custom mode drops the theme's classes and style block.
		await act(async () => control.change({ mode: "paper", customThemeId: THEME.id }));
		assert.equal(classes(), "paper");
		assert.equal(liveStyle(), null);
		assert.equal(control.codeThemeId, null);

		// Back again: already loaded, no second fetch needed.
		await act(async () => control.change({ mode: "custom", customThemeId: THEME.id }));
		assert.equal(classes(), "dark lh-custom lh-theme-theme_abc123");
	});

	it("renders a theme that is gone as Dark", async () => {
		await mount(async () => json({ error: "unknown theme" }, 404));
		await act(async () => control.change({ mode: "custom", customThemeId: "theme_gone00" }));
		assert.equal(classes(), "dark");
		assert.equal(liveStyle(), null);
	});
});
