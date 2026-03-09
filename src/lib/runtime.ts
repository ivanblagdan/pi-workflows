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
import { type ArtifactWorkflowContract, isJsonWorkflowContract, type JsonWorkflowContract } from "./contracts.js";
import { createWorkflowRuntimeEnvironment } from "./environment.js";
import type { InferRunResult, WorkflowAgentRuntimeConfig, WorkflowValidationContext } from "./types.js";
import { createWorkflowValidationContext, normalizeWorkflowValidationError } from "./workflow-base.js";

interface WorkflowLoopState {
	lastResponse: string;
}

interface WorkflowAgentRuntime {
	cwd: string;
	session: AgentSession;
	prompt: (input: string) => Promise<void>;
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

			retriesRemaining--;
			attempt++;
			await options.runtime.prompt(buildRepairPrompt(validationError));
		}
	}
}

function subscribeToWorkflowState(session: AgentSession, state: WorkflowLoopState): () => void {
	return session.agent.subscribe((event) => {
		if (event.type === "agent_end") {
			state.lastResponse = extractLastAssistantResponse(event.messages);
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
	schema: ArtifactWorkflowContract["schema"];
	onAccepted: (path: string) => void;
}): ToolDefinition<ArtifactWorkflowContract["schema"]> {
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
	agent: WorkflowAgentRuntimeConfig<JsonWorkflowContract<TSchema>>,
	input: string,
): Promise<InferRunResult<JsonWorkflowContract<TSchema>>> {
	let acceptedOutput: Static<TSchema> | undefined;
	const workflowTool = createJsonResultTool({
		schema: agent.contract.schema,
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
	const unsubscribe = subscribeToWorkflowState(runtime.session, state);

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
				const result: InferRunResult<JsonWorkflowContract<TSchema>> = {
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
	agent: WorkflowAgentRuntimeConfig<ArtifactWorkflowContract>,
	input: string,
): Promise<InferRunResult<ArtifactWorkflowContract>> {
	let acceptedOutputPath: string | undefined;
	const workflowTool = createArtifactResultTool({
		schema: agent.contract.schema,
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
	const unsubscribe = subscribeToWorkflowState(runtime.session, state);

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
				const result: InferRunResult<ArtifactWorkflowContract> = {
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

export async function runWorkflowAgent<TContract extends JsonWorkflowContract<TObject> | ArtifactWorkflowContract>(
	agent: WorkflowAgentRuntimeConfig<TContract>,
	input: string,
): Promise<InferRunResult<TContract>> {
	if (isJsonWorkflowContract(agent.contract)) {
		return runJsonWorkflowAgent(
			agent as unknown as WorkflowAgentRuntimeConfig<JsonWorkflowContract<TObject>>,
			input,
		) as Promise<InferRunResult<TContract>>;
	}
	return runArtifactWorkflowAgent(agent as WorkflowAgentRuntimeConfig<ArtifactWorkflowContract>, input) as Promise<
		InferRunResult<TContract>
	>;
}
