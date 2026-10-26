"use client";
/**
 * "Ask about this" under a tutor passage in the transcript: opens the side
 * chat about that reply (the dock shows it beside the chat box or question),
 * or closes it when it's the one open, like the question's own toggle.
 * Always visible on the latest reply; on older ones it appears on hover or
 * keyboard focus, so the transcript stays clean.
 */
import { MessageCircleQuestionIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function AskAboutReply({
	active,
	alwaysVisible,
	onAsk,
}: {
	/** This reply's side chat is the one open. */
	active: boolean;
	alwaysVisible: boolean;
	onAsk: () => void;
}) {
	return (
		<button
			type="button"
			data-testid="ask-about-reply"
			// UI chrome, not lesson text: Find skips it and a copy leaves it out.
			data-session-find-exclude=""
			aria-pressed={active}
			onClick={onAsk}
			className={cn(
				"mt-1 inline-flex select-none items-center gap-1 rounded-sm px-1 py-0.5 font-ui text-xs transition-[opacity,color] hover:text-foreground focus-visible:opacity-100",
				active ? "text-foreground" : "text-muted-foreground",
				active || alwaysVisible ? "opacity-100" : "opacity-0 group-hover/reply:opacity-100",
			)}
		>
			<MessageCircleQuestionIcon className="size-3.5" />
			Ask about this
		</button>
	);
}
