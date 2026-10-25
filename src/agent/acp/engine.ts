import {
	createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, clampThinkingLevel,
	type AssistantMessage, type Message, type Model, type Api, type StreamFunction,
	type TranscriptContext, type ToolCall,
} from "@earendil-works/pi-ai";
import { ACP_AGENTS, ACP_THINKING_LEVELS, type AcpAgentId, type AcpConnectionConfig, type AcpModelInfo } from "../../core/acp.ts";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { PiEngine } from "../models.ts";
import { AcpClient } from "./client.ts";
import { createToolBridge } from "./tool-bridge.ts";
import { selectAcpModel } from "./catalog.ts";
import { setTimeout, clearTimeout } from "node:timers";
import type { PiUsageLike } from "../../core/usage.ts";

export function acpModel(id: AcpAgentId, info?: AcpModelInfo): Model<Api> {
	const agent = ACP_AGENTS.find((agent) => agent.id === id)!;
	return {
		id: info?.id ?? "default", name: info?.id !== "default" && info ? info.name : `${agent.label} (agent default)`, provider: agent.provider,
		api: "acp", baseUrl: "", input: ["text", "image"], reasoning: Object.keys(info?.reasoning ?? {}).length > 0,
		thinkingLevelMap: Object.fromEntries(ACP_THINKING_LEVELS.map((level) => [level, info?.reasoning[level] ?? null])),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		// The native agent owns model selection and context management. Zero
		// means unreported, and is omitted from the app's context-limit joins.
		contextWindow: 0, maxTokens: 0,
	};
}

type PromptBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
interface PromptResult {
	stopReason?: string;
	usage?: { inputTokens?: number; outputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; thoughtTokens?: number; totalTokens?: number };
}

function recordUsage(message: AssistantMessage, result: PromptResult | undefined) {
	if (!result?.usage) return;
	const count = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
	const usage = result.usage;
	(message.usage as PiUsageLike).lhReportedUsage = {
		inputTokens: count(usage.inputTokens), outputTokens: count(usage.outputTokens),
		cacheReadTokens: count(usage.cachedReadTokens), cacheWriteTokens: count(usage.cachedWriteTokens),
		reasoningTokens: count(usage.thoughtTokens),
	};
	message.usage.input = count(usage.inputTokens) ?? 0;
	message.usage.output = count(usage.outputTokens) ?? 0;
	message.usage.cacheRead = count(usage.cachedReadTokens) ?? 0;
	message.usage.cacheWrite = count(usage.cachedWriteTokens) ?? 0;
	message.usage.reasoning = count(usage.thoughtTokens);
	// Reasoning is a subset of output, not another billable token bucket.
	message.usage.totalTokens = message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite;
}

/** ACP is an agent protocol rather than a completion API. Replay the app's
 * authoritative transcript into a fresh native session each model round.
 * This preserves compaction, steering, model switches, and question pauses
 * without a second, diverging conversation store in the CLI. */
export function acpPrompt(context: TranscriptContext): PromptBlock[] {
	const blocks: PromptBlock[] = [{ type: "text", text: "The following is the saved LearnHarness conversation. Continue it as the assistant. Prior tool calls have already run; use their recorded results.\n<conversation-history>" }];
	for (const message of context.messages) {
		if (message.role === "system") continue;
		const content = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
		const serialized = content.filter((part) => part.type !== "thinking").map((part) => part.type === "image" ? { type: "image", mimeType: part.mimeType, note: "Image attached below this message" } : part);
		const details = message.role === "toolResult" ? { toolCallId: message.toolCallId, toolName: message.toolName, isError: message.isError } : {};
		blocks.push({ type: "text", text: JSON.stringify({ role: message.role, ...details, content: serialized }) });
		for (const part of content) if (part.type === "image") blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
	}
	blocks.push({ type: "text", text: "</conversation-history>\nContinue from the end. Use the LearnHarness MCP tools for all application actions. Request one tool at a time; LearnHarness will execute it and provide the result in the next round." });
	return blocks;
}

function blankMessage(model: Model<Api>): AssistantMessage {
	const usage: AssistantMessage["usage"] & PiUsageLike = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, lhReportedUsage: {} };
	return {
		role: "assistant", content: [], api: "acp", provider: model.provider, model: model.id,
		timestamp: Date.now(), stopReason: "stop",
		usage,
	};
}

export function createAcpEngine(id: AcpAgentId, config: AcpConnectionConfig, info?: AcpModelInfo, requestedLevel?: ThinkingLevel): PiEngine {
	const selectedModel = acpModel(id, info);
	const legacyDefault = info?.modelId === undefined && requestedLevel === "off" && info?.reasoning.off === undefined;
	const level = requestedLevel === undefined || legacyDefault || !selectedModel.reasoning ? undefined : clampThinkingLevel(selectedModel, requestedLevel);
	const streamFn: StreamFunction = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const message = blankMessage(model);
		void (async () => {
			let client: AcpClient | undefined;
			let bridge: Awaited<ReturnType<typeof createToolBridge>> | undefined;
			let activeBlock: number | undefined;
			let accepting = true;
			const endBlock = () => {
				if (activeBlock === undefined) return;
				const part = message.content[activeBlock]!;
				if (part.type === "text") stream.push({ type: "text_end", contentIndex: activeBlock, content: part.text, partial: message });
				if (part.type === "thinking") stream.push({ type: "thinking_end", contentIndex: activeBlock, content: part.thinking, partial: message });
				activeBlock = undefined;
			};
			try {
				options?.signal?.throwIfAborted();
				stream.push({ type: "start", partial: message });
				let toolRequested!: () => void;
				const toolTurn = new Promise<"tool">((resolve) => { toolRequested = () => resolve("tool"); });
				const capture = (toolCall: ToolCall) => {
					if (!accepting) return;
					accepting = false;
					endBlock();
					const index = message.content.length;
					message.content.push({ ...toolCall, arguments: {} });
					stream.push({ type: "toolcall_start", contentIndex: index, partial: message });
					message.content[index] = toolCall;
					stream.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(toolCall.arguments), partial: message });
					stream.push({ type: "toolcall_end", contentIndex: index, toolCall, partial: message });
					toolRequested();
				};
				const tools = getCurrentTools(context.messages);
				const instructions = `${getCurrentSystemPrompt(context.messages)}\n\nYou are running inside LearnHarness. Use only the provided LearnHarness MCP tools for application actions. Native coding, terminal, and file tools are not needed. The conversation history in the prompt is authoritative.`;
				client = new AcpClient(id, config, { signal: options?.signal, applicationTools: tools.map((tool) => tool.name), systemPrompt: instructions, onNotification: (method, params) => {
					if (method !== "session/update" || !accepting) return;
					const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string } } | undefined;
					if (update?.content?.type !== "text" || typeof update.content.text !== "string") return;
					const kind = update.sessionUpdate === "agent_message_chunk" ? "text" : update.sessionUpdate === "agent_thought_chunk" ? "thinking" : undefined;
					if (!kind) return;
					if (activeBlock === undefined || message.content[activeBlock]?.type !== kind) {
						endBlock();
						activeBlock = message.content.length;
						message.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
						stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: activeBlock, partial: message });
					}
					const part = message.content[activeBlock]!;
					if (part.type === "text") part.text += update.content.text;
					if (part.type === "thinking") part.thinking += update.content.text;
					stream.push({ type: kind === "text" ? "text_delta" : "thinking_delta", contentIndex: activeBlock, delta: update.content.text, partial: message });
				} });
				const initialized = await client.initialize();
				if (tools.length && !initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error("This ACP adapter must support HTTP MCP servers. Update the adapter to use LearnHarness tools.");
				const prompt = acpPrompt(context);
				if (prompt.some((part) => part.type === "image") && !initialized.agentCapabilities?.promptCapabilities?.image) throw new Error("This ACP adapter does not support image input. Choose an image-capable agent for the Vision slot.");
				bridge = tools.length ? await createToolBridge(tools, capture) : undefined;
				const promptCapability = initialized.agentCapabilities?.sessionCapabilities?.systemPrompt;
				const session = await client.newSession({
					mcpServers: bridge ? [bridge.mcpServer] : [],
					...(promptCapability ? { systemPrompt: { mode: promptCapability.mode?.override !== undefined ? "override" : "append", content: [{ type: "text", text: instructions }] } } : {}),
					_meta: { systemPrompt: instructions, disableBuiltInTools: true, claudeCode: { options: { tools: [], allowedTools: tools.map((tool) => `mcp__learnharness__${tool.name}`), settingSources: [], persistSession: false } } },
				});
				await selectAcpModel(client, session, info, level);
				const completion = client.request<PromptResult>("session/prompt", { sessionId: session.sessionId, prompt }, 10 * 60_000);
				const result = await Promise.race([
					toolTurn,
					completion,
				]);
				endBlock();
				if (result === "tool") {
					message.stopReason = "toolUse";
					client.notify("session/cancel", { sessionId: session.sessionId });
					// Let native cancellation report measured usage before disposal.
					// An uncooperative adapter cannot hold an application tool hostage.
					let timer: ReturnType<typeof setTimeout> | undefined;
					try {
						const cancelled = await Promise.race([completion.catch(() => undefined), new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 1500); })]);
						recordUsage(message, cancelled);
					} finally { clearTimeout(timer); }
				}
				else if (result.stopReason === "cancelled") throw new DOMException("ACP turn cancelled", "AbortError");
				else if (result.stopReason === "max_tokens") message.stopReason = "length";
				else if (result.stopReason !== "end_turn") throw new Error(`ACP turn did not complete (${result.stopReason ?? "missing stop reason"})`);
				if (result !== "tool") recordUsage(message, result);
				options?.signal?.throwIfAborted();
				accepting = false;
				await client.close();
				await bridge?.close();
				stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
			} catch (error) {
				accepting = false;
				message.stopReason = options?.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "aborted" : "error";
				message.errorMessage = error instanceof Error ? error.message : String(error);
				await client?.close();
				await bridge?.close();
				stream.push({ type: "error", reason: message.stopReason, error: message });
			} finally {
				await client?.close();
				await bridge?.close();
				stream.end();
			}
		})();
		return stream;
	};
	return { model: selectedModel, level, streamFn };
}
