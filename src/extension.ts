import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { createWorkflowFeedbackController } from "./extension-feedback.js";
import { runWithWorkflowFeedback } from "./lib/feedback.js";
import type { WorkflowRegistry } from "./lib/registry.js";
import type { WorkflowInvocation, WorkflowTurnEnrichment } from "./lib/types.js";
import type { Workflow } from "./lib/workflow.js";

const WORKFLOW_TOOL_PARAMS = Type.Object(
	{
		name: Type.String({ description: "Registered workflow name" }),
		input: Type.String({ description: "String input passed verbatim to workflow.run(input)" }),
	},
	{ additionalProperties: false },
);

const EXCLUDED_WORKFLOW_UI_MESSAGE_TYPES = new Set(["workflow-command", "workflow-preview", "workflow-status"]);

export interface WorkflowToolSuccessDetails<TResult = unknown> {
	status: "success";
	name: string;
	description?: string;
	input: string;
	durationMs: number;
	result: TResult;
}

export interface WorkflowToolErrorDetails {
	status: "error";
	name: string;
	description?: string;
	input: string;
	durationMs: number;
	errorMessage: string;
}

export type WorkflowToolDetails<TResult = unknown> = WorkflowToolSuccessDetails<TResult> | WorkflowToolErrorDetails;

function safeStringify(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		const serialized = JSON.stringify(value, null, 2);
		return serialized ?? String(value);
	} catch {
		return String(value);
	}
}

function formatPreview(text: string, maxLength: number): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatDuration(durationMs: number): string {
	if (durationMs < 1000) {
		return `${durationMs}ms`;
	}
	return `${(durationMs / 1000).toFixed(1)}s`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function isJsonWorkflowRunResult(value: unknown): value is { response: string; output: unknown; outputPath?: never } {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.response === "string" && hasOwn(value, "output") && !hasOwn(value, "outputPath");
}

function isArtifactWorkflowRunResult(
	value: unknown,
): value is { response: string; outputPath: string; output?: never } {
	if (!isRecord(value)) {
		return false;
	}
	return typeof value.response === "string" && typeof value.outputPath === "string";
}

function formatToolContent(name: string, result: unknown): string {
	const payload = isJsonWorkflowRunResult(result)
		? { workflow: name, response: result.response, output: result.output }
		: isArtifactWorkflowRunResult(result)
			? { workflow: name, response: result.response, outputPath: result.outputPath }
			: { workflow: name, result };
	return `Workflow "${name}" completed successfully.\n\n${safeStringify(payload)}`;
}

function formatResultPreview(result: unknown): string {
	if (isJsonWorkflowRunResult(result)) {
		return formatPreview(safeStringify(result.output), 120);
	}
	if (isArtifactWorkflowRunResult(result)) {
		return formatPreview(result.outputPath, 120);
	}
	return formatPreview(safeStringify(result), 120);
}

function parseCommandArgs(args: string): { workflowName?: string; input: string; hasInput: boolean } {
	const trimmed = args.trim();
	if (trimmed.length === 0) {
		return { input: "", hasInput: false };
	}

	const firstWhitespaceIndex = trimmed.search(/\s/);
	if (firstWhitespaceIndex === -1) {
		return { workflowName: trimmed, input: "", hasInput: false };
	}

	return {
		workflowName: trimmed.slice(0, firstWhitespaceIndex),
		input: trimmed.slice(firstWhitespaceIndex).trimStart(),
		hasInput: true,
	};
}

function workflowSelectionLabel(workflow: ReturnType<WorkflowRegistry["list"]>[number]): string {
	return workflow.description ? `${workflow.name} — ${workflow.description}` : workflow.name;
}

function sendCommandMessage(pi: ExtensionAPI, text: string): void {
	pi.sendMessage(
		{
			customType: "workflow-command",
			content: text,
			display: true,
		},
		{ triggerTurn: false },
	);
}

function sendWorkflowPreviewMessage(pi: ExtensionAPI, invocation: WorkflowInvocation): void {
	pi.sendMessage(
		{
			customType: "workflow-preview",
			content: [
				`[WORKFLOW PREVIEW: ${invocation.name}]`,
				"",
				"Preparing workflow context before the main agent responds.",
				"",
				"Request:",
				invocation.input,
			].join("\n"),
			display: true,
			details: {
				workflow: invocation.name,
				input: invocation.input,
				state: "queued",
			},
		},
		{ triggerTurn: false },
	);
}

function shouldExcludeWorkflowUiMessage(message: unknown): boolean {
	if (!isRecord(message)) {
		return false;
	}
	return message.role === "custom" && typeof message.customType === "string"
		? EXCLUDED_WORKFLOW_UI_MESSAGE_TYPES.has(message.customType)
		: false;
}

function getMessageTextContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.map((item) => {
			if (!isRecord(item) || typeof item.type !== "string") {
				return "";
			}
			if (item.type === "text" && typeof item.text === "string") {
				return item.text;
			}
			if (item.type === "image") {
				return "[image]";
			}
			return "";
		})
		.filter((item) => item.length > 0)
		.join("\n");
}

function asStringArray(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
		return undefined;
	}
	return value;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
	return count === 1 ? singular : plural;
}

function getWorkflowSummaryCount(details: unknown, summaryKey: string, outputKey: string): number | undefined {
	if (!isRecord(details)) {
		return undefined;
	}
	const summary = isRecord(details.summary) ? details.summary : undefined;
	if (summary && typeof summary[summaryKey] === "number") {
		return summary[summaryKey];
	}
	const output = isRecord(details.output) ? details.output : undefined;
	const values = output ? asStringArray(output[outputKey]) : undefined;
	return values?.length;
}

function formatWorkflowContextSummary(details: unknown, content: unknown): string {
	const observations = getWorkflowSummaryCount(details, "observations", "observations");
	const openQuestions = getWorkflowSummaryCount(details, "openQuestions", "openQuestions");
	const references = getWorkflowSummaryCount(details, "references", "references");
	const parts = [
		typeof observations === "number" ? `${observations} ${pluralize(observations, "observation")}` : undefined,
		typeof openQuestions === "number" ? `${openQuestions} open ${pluralize(openQuestions, "question")}` : undefined,
		typeof references === "number" ? `${references} ${pluralize(references, "reference")}` : undefined,
	].filter((part): part is string => Boolean(part));
	if (parts.length > 0) {
		return parts.join(" • ");
	}
	return formatPreview(getMessageTextContent(content), 96) || "workflow context ready";
}

function getWorkflowMessageInput(details: unknown): string | undefined {
	return isRecord(details) && typeof details.input === "string" ? details.input : undefined;
}

function getWorkflowMessageName(details: unknown): string {
	return isRecord(details) && typeof details.workflow === "string" ? details.workflow : "workflow";
}

function getWorkflowDuration(details: unknown): string | undefined {
	return isRecord(details) && typeof details.durationMs === "number" ? formatDuration(details.durationMs) : undefined;
}

function mergeWorkflowMessageDetails(existing: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	if (existing === undefined) {
		return patch;
	}
	if (isRecord(existing)) {
		return { ...existing, ...patch };
	}
	return { ...patch, value: existing };
}

function registerWorkflowMessageRenderers(pi: ExtensionAPI): void {
	pi.registerMessageRenderer("workflow-preview", (message, { expanded }, theme) => {
		const details = message.details;
		const workflowName = getWorkflowMessageName(details);
		const input = getWorkflowMessageInput(details) ?? getMessageTextContent(message.content);
		const header = theme.fg("warning", "◌") + " " + theme.fg("accent", "workflow-preview") + " " + theme.bold(workflowName);
		if (!expanded) {
			return new Text(`${header}\n${theme.fg("dim", input || "Preparing workflow context...")}`, 0, 0);
		}
		const text = [
			header,
			theme.fg("muted", "Preparing workflow context before the main agent responds."),
			"",
			theme.fg("muted", "Request:"),
			theme.fg("toolOutput", input || "(empty input)"),
		].join("\n");
		return new Text(text, 0, 0);
	});

	pi.registerMessageRenderer("workflow-context", (message, { expanded }, theme) => {
		const details = message.details;
		const workflowName = getWorkflowMessageName(details);
		const summary = formatWorkflowContextSummary(details, message.content);
		const duration = getWorkflowDuration(details);
		const header = theme.fg("success", "✓") + " " + theme.fg("accent", "workflow-context") + " " + theme.bold(workflowName);
		if (!expanded) {
			let text = `${header}\n${theme.fg("toolOutput", summary)}`;
			if (duration) {
				text += `\n${theme.fg("dim", duration)}`;
			}
			return new Text(text, 0, 0);
		}

		const input = getWorkflowMessageInput(details);
		const sections = [
			header,
			theme.fg("muted", "Injected into this turn as extension-generated workflow context."),
		];
		if (duration) {
			sections.push(theme.fg("dim", duration));
		}
		if (input) {
			sections.push("", theme.fg("muted", "Request:"), theme.fg("dim", input));
		}
		sections.push("", theme.fg("toolOutput", getMessageTextContent(message.content) || "(empty workflow context)"));
		return new Text(sections.join("\n"), 0, 0);
	});
}

function notifyCommandMessage(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">,
	message: string,
	type: "info" | "warning" | "error" = "warning",
): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
	} else {
		sendCommandMessage(pi, message);
	}
}

async function chooseWorkflow(
	ctx: ExtensionCommandContext,
	registry: WorkflowRegistry,
): Promise<ReturnType<WorkflowRegistry["list"]>[number] | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}
	const workflows = registry.list();
	const labels = workflows.map(workflowSelectionLabel);
	const selected = await ctx.ui.select("Use workflow for next turn", labels);
	if (!selected) {
		return undefined;
	}
	const selectedIndex = labels.indexOf(selected);
	return selectedIndex >= 0 ? workflows[selectedIndex] : undefined;
}

async function resolveWorkflowInvocation(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	registry: WorkflowRegistry,
	args: string,
): Promise<WorkflowInvocation | undefined> {
	const workflows = registry.list();
	if (workflows.length === 0) {
		notifyCommandMessage(pi, ctx, "No workflows are registered.");
		return undefined;
	}

	const parsed = parseCommandArgs(args);
	let workflow = parsed.workflowName ? registry.get(parsed.workflowName) : undefined;
	if (parsed.workflowName && !workflow) {
		notifyCommandMessage(
			pi,
			ctx,
			`Unknown workflow: ${parsed.workflowName}. Available workflows: ${workflows.map((entry) => entry.name).join(", ")}`,
		);
		return undefined;
	}

	if (!workflow) {
		workflow = await chooseWorkflow(ctx, registry);
		if (!workflow) {
			if (!ctx.hasUI) {
				sendCommandMessage(
					pi,
					`Usage: /workflow <name> <input>\nAvailable workflows: ${workflows.map((entry) => entry.name).join(", ")}`,
				);
			}
			return undefined;
		}
	}

	if (parsed.hasInput) {
		return { name: workflow.name, input: parsed.input };
	}

	if (!ctx.hasUI) {
		sendCommandMessage(pi, `Usage: /workflow ${workflow.name} <input>`);
		return undefined;
	}

	const input = await ctx.ui.editor(`Input for workflow "${workflow.name}"`, "");
	if (input === undefined) {
		return undefined;
	}
	return { name: workflow.name, input };
}

async function executeWorkflow(
	workflow: NonNullable<ReturnType<WorkflowRegistry["get"]>>,
	input: string,
	cwd: string,
): Promise<{ instance: Workflow<unknown>; result: unknown }> {
	const instance = workflow.create();
	if (instance.cwd === undefined) {
		instance.cwd = cwd;
	}
	if (instance.feedbackLabel === undefined) {
		instance.feedbackLabel = workflow.name;
	}
	const result = await instance.run(input);
	return { instance, result };
}

function normalizeTurnEnrichment(enrichment: WorkflowTurnEnrichment | undefined) {
	if (!enrichment) {
		return undefined;
	}
	if (!enrichment.message && enrichment.systemPrompt === undefined) {
		return undefined;
	}
	return {
		message: enrichment.message
			? {
				...enrichment.message,
				display: enrichment.message.display ?? false,
			}
			: undefined,
		systemPrompt: enrichment.systemPrompt,
	};
}

function createWorkflowTool(
	registry: WorkflowRegistry,
): ToolDefinition<typeof WORKFLOW_TOOL_PARAMS, WorkflowToolDetails> {
	return {
		name: "workflow",
		label: "Workflow",
		description: "Run a registered workflow by name with a string input and return its result.",
		promptSnippet: "Run a registered workflow by name with a string input.",
		promptGuidelines: ["Use the workflow tool only when the user explicitly asks to run a registered workflow."],
		parameters: WORKFLOW_TOOL_PARAMS,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const workflow = registry.get(params.name);
			const startedAt = Date.now();
			if (!workflow) {
				const available =
					registry
						.list()
						.map((entry) => entry.name)
						.join(", ") || "none";
				return {
					content: [{ type: "text", text: `Unknown workflow: ${params.name}. Available workflows: ${available}` }],
					details: {
						status: "error",
						name: params.name,
						input: params.input,
						durationMs: Date.now() - startedAt,
						errorMessage: `Unknown workflow: ${params.name}`,
					},
				};
			}

			try {
				const { result } = await executeWorkflow(workflow, params.input, ctx.cwd);
				return {
					content: [{ type: "text", text: formatToolContent(workflow.name, result) }],
					details: {
						status: "success",
						name: workflow.name,
						description: workflow.description,
						input: params.input,
						durationMs: Date.now() - startedAt,
						result,
					},
				};
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Workflow "${workflow.name}" failed: ${errorMessage}` }],
					details: {
						status: "error",
						name: workflow.name,
						description: workflow.description,
						input: params.input,
						durationMs: Date.now() - startedAt,
						errorMessage,
					},
				};
			}
		},
		renderCall(args, theme) {
			const preview = formatPreview(args.input, 80) || "(empty input)";
			const header = theme.fg("toolTitle", theme.bold("workflow ")) + theme.fg("accent", args.name);
			return new Text(`${header}\n${theme.fg("dim", preview)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
			}

			if (details.status === "error") {
				let text =
					theme.fg("error", "✗") +
					" " +
					theme.fg("toolTitle", theme.bold("workflow ")) +
					theme.fg("accent", details.name);
				if (details.description) {
					text += `\n${theme.fg("muted", details.description)}`;
				}
				text += `\n${theme.fg("error", details.errorMessage)}`;
				text += `\n${theme.fg("dim", formatDuration(details.durationMs))}`;
				if (expanded) {
					text += `\n\n${theme.fg("muted", "Input:")}\n${theme.fg("dim", details.input || "(empty input)")}`;
				}
				return new Text(text, 0, 0);
			}

			const preview = formatResultPreview(details.result);
			let text =
				theme.fg("success", "✓") +
				" " +
				theme.fg("toolTitle", theme.bold("workflow ")) +
				theme.fg("accent", details.name);
			if (details.description) {
				text += `\n${theme.fg("muted", details.description)}`;
			}
			if (!expanded) {
				text += `\n${theme.fg("toolOutput", preview || "(no result)")}`;
				text += `\n${theme.fg("dim", formatDuration(details.durationMs))}`;
				return new Text(text, 0, 0);
			}

			text += `\n${theme.fg("dim", formatDuration(details.durationMs))}`;
			text += `\n\n${theme.fg("muted", "Input:")}\n${theme.fg("dim", details.input || "(empty input)")}`;
			if (isJsonWorkflowRunResult(details.result)) {
				text += `\n\n${theme.fg("muted", "Response:")}\n${theme.fg("toolOutput", details.result.response || "(empty response)")}`;
				text += `\n\n${theme.fg("muted", "Output:")}\n${theme.fg("toolOutput", safeStringify(details.result.output))}`;
			} else if (isArtifactWorkflowRunResult(details.result)) {
				text += `\n\n${theme.fg("muted", "Response:")}\n${theme.fg("toolOutput", details.result.response || "(empty response)")}`;
				text += `\n\n${theme.fg("muted", "Artifact:")}\n${theme.fg("toolOutput", details.result.outputPath)}`;
			} else {
				text += `\n\n${theme.fg("muted", "Result:")}\n${theme.fg("toolOutput", safeStringify(details.result))}`;
			}
			return new Text(text, 0, 0);
		},
	};
}

export function registerWorkflowExtension(pi: ExtensionAPI, registry: WorkflowRegistry): void {
	let pendingEnrichment: WorkflowInvocation | undefined;

	pi.registerTool(createWorkflowTool(registry));
	registerWorkflowMessageRenderers(pi);

	pi.on("context", async (event) => {
		const filteredMessages = event.messages.filter((message) => !shouldExcludeWorkflowUiMessage(message));
		if (filteredMessages.length === event.messages.length) {
			return undefined;
		}
		return { messages: filteredMessages };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!pendingEnrichment) {
			return undefined;
		}

		const invocation = pendingEnrichment;
		pendingEnrichment = undefined;

		const workflow = registry.get(invocation.name);
		if (!workflow) {
			throw new Error(`Workflow disappeared before enrichment: ${invocation.name}`);
		}

		ctx.ui.setWorkingMessage(`Running workflow "${workflow.name}"...`);
		const startedAt = Date.now();
		const feedbackController = createWorkflowFeedbackController({ ui: ctx.ui });

		try {
			const { instance, result } = await runWithWorkflowFeedback(feedbackController.sink, () =>
				executeWorkflow(workflow, invocation.input, ctx.cwd),
			);
			const enrichment = await instance.buildTurnEnrichment({
				name: workflow.name,
				input: invocation.input,
				result,
				cwd: ctx.cwd,
				currentSystemPrompt: event.systemPrompt,
			});
			if (enrichment?.message) {
				enrichment.message = {
					...enrichment.message,
					details: mergeWorkflowMessageDetails(enrichment.message.details, {
						workflow: workflow.name,
						input: invocation.input,
						durationMs: Date.now() - startedAt,
					}),
				};
			}
			return normalizeTurnEnrichment(enrichment);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Workflow "${workflow.name}" enrichment failed: ${errorMessage}`, "error");
			throw error instanceof Error ? error : new Error(errorMessage);
		} finally {
			feedbackController.dispose();
			ctx.ui.setWorkingMessage();
		}
	});

	pi.registerCommand("workflow", {
		description: "Enrich the next turn with a registered workflow",
		getArgumentCompletions(argumentPrefix) {
			const trimmed = argumentPrefix.trimStart();
			if (trimmed.includes(" ")) {
				return null;
			}
			const workflows = registry.list();
			if (workflows.length === 0) {
				return null;
			}
			const prefix = trimmed.toLowerCase();
			const matches = workflows.filter((workflow) => workflow.name.toLowerCase().startsWith(prefix));
			const items = (matches.length > 0 || prefix.length === 0 ? matches : workflows).map((workflow) => ({
				value: workflow.name,
				label: workflow.name,
				description: workflow.description,
			}));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const invocation = await resolveWorkflowInvocation(pi, ctx, registry, args);
			if (!invocation) {
				return;
			}

			if (!ctx.isIdle() || ctx.hasPendingMessages() || pendingEnrichment) {
				notifyCommandMessage(
					pi,
					ctx,
					'Cannot start workflow enrichment while the agent is busy or another message is queued. Wait for the current turn to finish and try again.',
					"error",
				);
				return;
			}

			sendWorkflowPreviewMessage(pi, invocation);
			pendingEnrichment = invocation;
			try {
				pi.sendUserMessage(invocation.input);
			} catch (error) {
				pendingEnrichment = undefined;
				throw error;
			}
		},
	});
}
