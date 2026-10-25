"use client";
/**
 * The active uploaded theme's syntax colors, for code blocks. The appearance
 * provider supplies it; the markdown renderer (ai-elements/message.tsx)
 * turns it into a Shiki plugin. null = the default github light/dark pair.
 */
import { createContext, useContext } from "react";
import type { CustomCodeTheme } from "@/src/core";

export const CodeThemeContext = createContext<{ id: string; code: CustomCodeTheme } | null>(null);

export function useCodeTheme() {
	return useContext(CodeThemeContext);
}
