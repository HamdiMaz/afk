import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { AfkController, shutdownAfk, toggleAfk } from "./controller.ts";
import { AfkToolParamsSchema, type AfkToolDetails, type AfkToolParams } from "./types.ts";

const TOOL_DESCRIPTION =
	"Send Telegram notifications or blocking questions to the user while AFK mode is enabled.";

function describeCall(params: AfkToolParams): string {
	if (params.mode === "notify") return `AFK notify via Telegram: ${params.message?.trim() || "(no message)"}`;
	return `AFK ask via Telegram: ${params.questions?.length ?? 0} question(s)`;
}

function describeResult(result: AgentToolResult<AfkToolDetails>): string {
	const details = result.details;
	if (details?.mode === "notify") return details.sent ? "AFK Telegram notification sent." : "AFK Telegram notification not sent.";
	if (details?.mode === "ask") return `AFK received ${details.answers.length} Telegram answer(s).`;
	if (details?.mode === "disabled") return `AFK disabled: ${details.reason}`;
	if (details?.mode === "cancelled") return `AFK cancelled: ${details.reason}`;
	if (details?.mode === "error") return `AFK error: ${details.reason}`;

	const text = result.content.find((item) => item.type === "text")?.text;
	return text ?? "AFK tool finished.";
}

/** AFK extension entry point. */
export default function extension(pi: ExtensionAPI): void {
	let latestUi: ExtensionContext["ui"] | undefined;
	const captureUi = (ctx: ExtensionContext): void => {
		latestUi = ctx.ui;
	};
	const controller = new AfkController({
		onDisabled(reason) {
			latestUi?.setStatus("afk", undefined);
			latestUi?.notify(reason, "warning");
		},
	});

	pi.registerCommand("afk", {
		description: "Toggle AFK mode and Telegram relay",
		handler: async (_args, ctx) => {
			captureUi(ctx);
			await toggleAfk(controller, ctx);
		},
	});

	pi.registerCommand("afk-settings", {
		description: "Configure AFK Telegram settings",
		handler: async (_args, ctx) => {
			captureUi(ctx);
			await controller.runSettings(ctx);
		},
	});

	pi.registerTool<typeof AfkToolParamsSchema, AfkToolDetails>({
		name: "afk",
		label: "AFK",
		description: TOOL_DESCRIPTION,
		promptSnippet: "Use the afk tool to notify or ask the user through Telegram when AFK mode is active.",
		promptGuidelines: [
			"Use the afk tool for user notifications, questions, and decisions when AFK mode indicates the user is away.",
			"AFK tool calls relay through Telegram; keep messages concise and include clear answer options for blocking questions.",
		],
		parameters: AfkToolParamsSchema,
		async execute(_toolCallId, params, signal) {
			return controller.executeTool(params, signal);
		},
		renderCall(params) {
			return new Text(describeCall(params), 0, 0);
		},
		renderResult(result) {
			return new Text(describeResult(result), 0, 0);
		},
	});

	pi.on("before_agent_start", (event) => {
		const guidance = controller.promptGuidance();
		if (!guidance) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${guidance}` };
	});

	pi.on("session_shutdown", async (event, ctx) => {
		captureUi(ctx);
		await shutdownAfk(controller, ctx, event.reason);
	});
}
