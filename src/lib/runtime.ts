import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
	type AgentSession,
	createAgentSession,
	SessionManager,
	type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Static, TObject, TSchema } from "@sinclair/typebox";
import { emitWorkflowFeedback, getCurrentWorkflowFeedbackScopeId } from "./feedback.js";
import { type ArtifactWorkflowOutput, isJsonWorkflowOutput, type JsonWorkflowOutput } from "./outputs.js";
import { createWorkflowRuntimeEnvironment } from "./environment.js";
import type { InferWorkflowResult, WorkflowAgentRuntimeConfig, WorkflowValidationContext } from "./types.js";
import { createWorkflowValidationContext, normalizeWorkflowValidationError } from "./workflow-base.js";

interface WorkflowLoopState {
	lastResponse: string;
}

interface ToolExecutionState {
	scopeId: string;
	startedAt: number;
}

interface WorkflowAgentRuntime {
	cwd: string;
	session: AgentSession;
	prompt: (input: string) => Promise<void>;
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}
	try {
		const serialized = JSON.stringify(value);
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

function formatToolArgsPreview(args: unknown): string | undefined {
	if (args === undefined) {
		return undefined;
	}
	if (typeof args === "string") {
		const trimmed = args.trim();
		return trimmed.length > 0 ? formatPreview(trimmed, 48) : undefined;
	}
	if (typeof args === "number" || typeof args === "boolean") {
		return String(args);
	}
	if (Array.isArray(args)) {
		return formatPreview(safeStringify(args), 48);
	}
	if (typeof args !== "object" || args === null) {
		return undefined;
	}
	const record = args as Record<string, unknown>;
	for (const key of ["path", "command", "name", "label", "input"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return `${key}=${formatPreview(value, 40)}`;
		}
	}
	const keys = Object.keys(record);
	if (keys.length === 0) {
		return undefined;
	}
	return formatPreview(safeStringify(record), 48);
}

function formatToolLabel(toolName: string, args: unknown): string {
	const preview = formatToolArgsPreview(args);
	return preview ? `${toolName} ${preview}` : toolName;
}

function summarizeToolResult(result: unknown): string | undefined {
	if (result === undefined || result === null) {
		return undefined;
	}
	if (typeof result === "string") {
		const trimmed = result.trim();
		return trimmed.length > 0 ? formatPreview(trimmed, 64) : undefined;
	}
	if (typeof result !== "object") {
		return formatPreview(String(result), 64);
	}
	const record = result as Record<string, unknown>;
	const textContent = Array.isArray(record.content)
		? record.content
				.map((item) => {
					if (typeof item !== "object" || item === null) {
						return "";
					}
					const contentItem = item as { type?: unknown; text?: unknown };
					return contentItem.type === "text" && typeof contentItem.text === "string" ? contentItem.text : "";
				})
				.filter((text) => text.length > 0)
				.join("\n")
		: undefined;
	if (textContent && textContent.trim().length > 0) {
		return formatPreview(textContent, 64);
	}
	if (typeof record.details === "string" && record.details.trim().length > 0) {
		return formatPreview(record.details, 64);
	}
	return formatPreview(safeStringify(record), 64);
}

function extractLastAssistantResponse(messages: AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") {
			continue;
		}

		const text = message.content
			.filter((item): item is Extract<(typeof message.content)[number], { type: "text" }> => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text.length > 0) {
			return text;
		}
	}
	return "";
}

function buildRepairPrompt(error: Error): string {
	return [
		"The task is not complete yet.",
		"",
		"Validation failed:",
		`- ${error.message}`,
		"",
		"Fix the issue and end only after the output is valid.",
	].join("\n");
}

async function runWorkflowLoop<TResult>(options: {
	cwd: string;
	runtime: WorkflowAgentRuntime;
	input: string;
	retries: number;
	validate: (context: WorkflowValidationContext, response: string) => Promise<TResult>;
	state: WorkflowLoopState;
}): Promise<TResult> {
	let attempt = 1;
	let retriesRemaining = options.retries;

	await options.runtime.prompt(options.input);

	while (true) {
		const context = createWorkflowValidationContext(options.cwd, options.input, attempt, retriesRemaining);
		try {
			return await options.validate(context, options.state.lastResponse);
		} catch (error) {
			const validationError = normalizeWorkflowValidationError(error, attempt, options.retries);
			if (retriesRemaining <= 0) {
				throw validationError;
			}

			emitWorkflowFeedback({
				type: "note",
				scopeId: getCurrentWorkflowFeedbackScopeId(),
				level: "warning",
				message: `Validation failed for attempt ${attempt}: ${validationError.message}. Retrying (${retriesRemaining} ${retriesRemaining === 1 ? "retry" : "retries"} remaining).`,
				timestamp: Date.now(),
			});
			retriesRemaining--;
			attempt++;
			await options.runtime.prompt(buildRepairPrompt(validationError));
		}
	}
}

function subscribeToWorkflowState(
	session: AgentSession,
	state: WorkflowLoopState,
	parentScopeId: string | undefined,
): () => void {
	const toolExecutions = new Map<string, ToolExecutionState>();

	return session.agent.subscribe((event) => {
		if (event.type === "agent_end") {
			state.lastResponse = extractLastAssistantResponse(event.messages);
			return;
		}

		if (!parentScopeId) {
			return;
		}

		if (event.type === "tool_execution_start") {
			const scopeId = `tool:${event.toolCallId}`;
			toolExecutions.set(event.toolCallId, {
				scopeId,
				startedAt: Date.now(),
			});
			emitWorkflowFeedback({
				type: "start",
				scope: {
					id: scopeId,
					parentId: parentScopeId,
					kind: "tool",
					label: formatToolLabel(event.toolName, event.args),
				},
				timestamp: Date.now(),
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			const execution = toolExecutions.get(event.toolCallId);
			toolExecutions.delete(event.toolCallId);
			emitWorkflowFeedback({
				type: "finish",
				scopeId: execution?.scopeId ?? `tool:${event.toolCallId}`,
				status: event.isError ? "error" : "success",
				durationMs: execution ? Date.now() - execution.startedAt : 0,
				summary: summarizeToolResult(event.result),
				error: event.isError ? summarizeToolResult(event.result) : undefined,
				timestamp: Date.now(),
			});
		}
	});
}

function eraseToolDefinition<TParams extends TSchema, TDetails>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition {
	return tool as unknown as ToolDefinition;
}

function resolveAgentInstructions(agent: Pick<WorkflowAgentRuntimeConfig<any>, "instructions">, input: string): string {
	const instructions = agent.instructions(input);
	if (typeof instructions !== "string") {
		throw new Error("Workflow agent instructions(input) must return a string.");
	}
	return instructions;
}

function createJsonResultTool<TSchema extends TObject>(options: {
	schema: TSchema;
	onAccepted: (output: Static<TSchema>) => void;
}): ToolDefinition<TSchema> {
	return {
		name: "workflow_result",
		label: "Workflow Result",
		description: "Submit the final JSON output for this workflow.",
		promptSnippet: "Submit the final typed JSON result for this workflow run.",
		promptGuidelines: ["Call workflow_result with the final result before ending the task."],
		parameters: options.schema,
		async execute(_toolCallId, params) {
			options.onAccepted(params);
			return {
				content: [{ type: "text", text: "Workflow result recorded." }],
				details: {},
			};
		},
	};
}

function createArtifactResultTool(options: {
	schema: ArtifactWorkflowOutput["schema"];
	onAccepted: (path: string) => void;
}): ToolDefinition<ArtifactWorkflowOutput["schema"]> {
	return {
		name: "workflow_result",
		label: "Workflow Result",
		description: "Submit the final artifact path for this workflow as { path: string }.",
		promptSnippet: "Submit the final artifact path for this workflow run as { path }.",
		promptGuidelines: [
			"Call workflow_result with the final artifact path before ending the task.",
			'For artifact workflows, workflow_result expects an object like { "path": "relative/or/absolute/path" }.',
		],
		parameters: options.schema,
		async execute(_toolCallId, params) {
			options.onAccepted(params.path);
			return {
				content: [{ type: "text", text: "Workflow artifact path recorded." }],
				details: {},
			};
		},
	};
}

async function createWorkflowRuntime<TParams extends TSchema>(options: {
	cwd: string;
	instructions: string;
	outputKind: "json" | "artifact";
	model?: WorkflowAgentRuntimeConfig<any>["model"];
	thinkingLevel?: WorkflowAgentRuntimeConfig<any>["thinkingLevel"];
	tools?: WorkflowAgentRuntimeConfig<any>["tools"];
	workflowTool: ToolDefinition<TParams>;
	environment: WorkflowAgentRuntimeConfig<any>["environment"];
}): Promise<WorkflowAgentRuntime> {
	const runtimeEnvironment = await createWorkflowRuntimeEnvironment({
		cwd: options.cwd,
		instructions: options.instructions,
		outputKind: options.outputKind,
		environment: options.environment,
	});
	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: runtimeEnvironment.cwd,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		tools: options.tools,
		customTools: [eraseToolDefinition(options.workflowTool)],
		resourceLoader: runtimeEnvironment.resourceLoader,
		settingsManager: runtimeEnvironment.settingsManager,
		sessionManager: SessionManager.inMemory(runtimeEnvironment.cwd),
	});

	if (!session.model) {
		throw new Error(modelFallbackMessage ?? "No model selected for workflow execution.");
	}

	return {
		cwd: runtimeEnvironment.cwd,
		session,
		prompt: async (input: string) => {
			await session.prompt(input, { expandPromptTemplates: false });
		},
	};
}

async function runJsonWorkflowAgent<TSchema extends TObject>(
	agent: WorkflowAgentRuntimeConfig<JsonWorkflowOutput<TSchema>>,
	input: string,
): Promise<InferWorkflowResult<JsonWorkflowOutput<TSchema>>> {
	let acceptedOutput: Static<TSchema> | undefined;
	const workflowTool = createJsonResultTool({
		schema: agent.output.schema,
		onAccepted: (output) => {
			acceptedOutput = output;
		},
	});
	const runtime = await createWorkflowRuntime({
		cwd: agent.cwd ?? process.cwd(),
		instructions: resolveAgentInstructions(agent, input),
		outputKind: "json",
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
		tools: agent.tools,
		workflowTool,
		environment: agent.environment,
	});
	const state: WorkflowLoopState = { lastResponse: "" };
	const unsubscribe = subscribeToWorkflowState(runtime.session, state, getCurrentWorkflowFeedbackScopeId());

	try {
		return await runWorkflowLoop({
			cwd: runtime.cwd,
			runtime,
			input,
			retries: agent.retries,
			state,
			validate: async (context, response) => {
				if (acceptedOutput === undefined) {
					throw new Error("workflow_result was not called successfully before the agent stopped.");
				}
				const result: InferWorkflowResult<JsonWorkflowOutput<TSchema>> = {
					output: acceptedOutput,
					response,
				};
				for (const validator of agent.getValidators()) {
					await validator(result, context);
				}
				return result;
			},
		});
	} finally {
		unsubscribe();
	}
}

async function runArtifactWorkflowAgent(
	agent: WorkflowAgentRuntimeConfig<ArtifactWorkflowOutput>,
	input: string,
): Promise<InferWorkflowResult<ArtifactWorkflowOutput>> {
	let acceptedOutputPath: string | undefined;
	const workflowTool = createArtifactResultTool({
		schema: agent.output.schema,
		onAccepted: (path) => {
			acceptedOutputPath = path;
		},
	});
	const runtime = await createWorkflowRuntime({
		cwd: agent.cwd ?? process.cwd(),
		instructions: resolveAgentInstructions(agent, input),
		outputKind: "artifact",
		model: agent.model,
		thinkingLevel: agent.thinkingLevel,
		tools: agent.tools,
		workflowTool,
		environment: agent.environment,
	});
	const state: WorkflowLoopState = { lastResponse: "" };
	const unsubscribe = subscribeToWorkflowState(runtime.session, state, getCurrentWorkflowFeedbackScopeId());

	try {
		return await runWorkflowLoop({
			cwd: runtime.cwd,
			runtime,
			input,
			retries: agent.retries,
			state,
			validate: async (context, response) => {
				if (!acceptedOutputPath) {
					throw new Error("workflow_result was not called successfully before the agent stopped.");
				}
				const absoluteOutputPath = resolvePath(runtime.cwd, acceptedOutputPath);
				if (!existsSync(absoluteOutputPath)) {
					throw new Error(`Artifact does not exist: ${absoluteOutputPath}`);
				}
				if (!statSync(absoluteOutputPath).isFile()) {
					throw new Error(`Artifact path is not a file: ${absoluteOutputPath}`);
				}
				const result: InferWorkflowResult<ArtifactWorkflowOutput> = {
					outputPath: absoluteOutputPath,
					response,
				};
				for (const validator of agent.getValidators()) {
					await validator(result, context);
				}
				return result;
			},
		});
	} finally {
		unsubscribe();
	}
}

export async function runWorkflowAgent<TOutput extends JsonWorkflowOutput<TObject> | ArtifactWorkflowOutput>(
	agent: WorkflowAgentRuntimeConfig<TOutput>,
	input: string,
): Promise<InferWorkflowResult<TOutput>> {
	if (isJsonWorkflowOutput(agent.output)) {
		return runJsonWorkflowAgent(
			agent as unknown as WorkflowAgentRuntimeConfig<JsonWorkflowOutput<TObject>>,
			input,
		) as Promise<InferWorkflowResult<TOutput>>;
	}
	return runArtifactWorkflowAgent(agent as WorkflowAgentRuntimeConfig<ArtifactWorkflowOutput>, input) as Promise<
		InferWorkflowResult<TOutput>
	>;
}
