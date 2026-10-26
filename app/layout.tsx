import type { Metadata } from "next";
import { JetBrains_Mono, Source_Sans_3 } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";
import { AppShell, SidebarProvider } from "@/components/sidebar";
import { ActivityProvider } from "@/components/activity-dock";
import { ServerEventsProvider } from "@/components/server-events";
import { AppearanceProvider } from "@/components/settings/appearance";
import UpdateBanner from "@/components/update-banner";
import { CalculatorHost } from "@/components/calculator/calculator-host";
import { appearanceModeClass, customThemeCss, type CustomTheme } from "@/src/core";
import { effectiveSettings, getTheme } from "@/src/server";

// The theme class is read from the saved settings on every request, so the
// first paint already has it (no dark flash before Paper loads) on any
// machine. That makes every route dynamic; the app already serves per-request
// data everywhere.
export const dynamic = "force-dynamic";

/** The saved theme: its <html> classes, and the uploaded theme (colors +
 *  syntax rules) when custom mode points at one that exists. */
function savedTheme(): { className: string; custom: CustomTheme | null } {
	try {
		const { mode, customThemeId } = effectiveSettings().appearance;
		const custom = mode === "custom" && customThemeId ? getTheme(customThemeId) : null;
		return { className: appearanceModeClass(mode, custom), custom };
	} catch {
		return { className: "dark", custom: null }; // an unreadable settings file must not take the app down
	}
}

// Chrome = JetBrains Mono, teaching prose = Source Sans 3, titles = CMU
// Serif (the bundled lh-cmu @font-face in globals.css — no CDN).
const ui = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jetbrains" });
const prose = Source_Sans_3({ subsets: ["latin"], variable: "--font-sans3" });

export const metadata: Metadata = {
	title: "Learning Harness",
	description: "A teacher agent with a memory — sessions, quizzes, and a knowledge graph of what you know.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
	const theme = savedTheme();
	return (
		<html lang="en" className={`${theme.className} ${ui.variable} ${prose.variable}`}>
			<body className="min-h-dvh antialiased">
			{/* An uploaded theme's palette, keyed to its own <html> class so the
			    first paint already wears it. Built only from validated hex colors
			    (core/vscode-theme.ts customThemeCss). */}
			{theme.custom && (
				<style id="lh-custom-theme-saved" dangerouslySetInnerHTML={{ __html: customThemeCss(theme.custom) }} />
			)}
			{/* The notification channel rides OUTSIDE everything: sidebar, dock,
				 and pages all subscribe as the polls retire (push S3, 2026-10-02). */}
			<ServerEventsProvider>
				<AppearanceProvider initialTheme={theme.custom}>
					<SidebarProvider>
						<ActivityProvider>
							<AppShell>{children}</AppShell>
						</ActivityProvider>
					</SidebarProvider>
				</AppearanceProvider>
			</ServerEventsProvider>
			{/* Auto-update banner (Wave C): fixed card, Electron-only pushes. */}
			<UpdateBanner />
			{/* The floating calculator (Alt+C or the bar's calculator button). */}
			<CalculatorHost />
		</body>
		</html>
	);
}
