import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { WorkflowRegistry } from "./lib/registry.js";
import type { WorkflowInvocation } from "./lib/types.js";

const WORKFLOW_TOOL_PARAMS = Type.Object(
	{
		name: Type.String({ description: "Registered workflow name" }),
		input: Type.String({ description: "String input passed verbatim to workflow.run(input)" }),
	},
	{ additionalProperties: false },
);

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

async function chooseWorkflow(
	ctx: ExtensionCommandContext,
	registry: WorkflowRegistry,
): Promise<ReturnType<WorkflowRegistry["list"]>[number] | undefined> {
	if (!ctx.hasUI) {
		return undefined;
	}
	const workflows = registry.list();
	const labels = workflows.map(workflowSelectionLabel);
	const selected = await ctx.ui.select("Run workflow", labels);
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
		const message = "No workflows are registered.";
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
		} else {
			sendCommandMessage(pi, message);
		}
		return undefined;
	}

	const parsed = parseCommandArgs(args);
	let workflow = parsed.workflowName ? registry.get(parsed.workflowName) : undefined;
	if (parsed.workflowName && !workflow) {
		const message = `Unknown workflow: ${parsed.workflowName}. Available workflows: ${workflows.map((entry) => entry.name).join(", ")}`;
		if (ctx.hasUI) {
			ctx.ui.notify(message, "warning");
		} else {
			sendCommandMessage(pi, message);
		}
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
				const instance = workflow.create();
				if (instance.cwd === undefined) {
					instance.cwd = ctx.cwd;
				}
				const result = await instance.run(params.input);
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
	pi.registerTool(createWorkflowTool(registry));
	pi.registerCommand("workflow", {
		description: "Run a registered workflow",
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

			const workflow = registry.get(invocation.name);
			if (!workflow) {
				throw new Error(`Workflow disappeared before invocation: ${invocation.name}`);
			}

			const instance = workflow.create();
			if (instance.cwd === undefined) {
				instance.cwd = ctx.cwd;
			}

			pi.sendUserMessage(instance.invoke({ name: invocation.name, input: invocation.input }), {
				deliverAs: "followUp",
			});
		},
	});
}
