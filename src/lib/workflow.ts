import { withWorkflowFeedbackScope } from "./feedback.js";
import type { WorkflowInvoker, WorkflowTurnEnrichment, WorkflowTurnEnrichmentContext } from "./types.js";
import { WorkflowBase } from "./workflow-base.js";

const WORKFLOW_CONTEXT_SYSTEM_PROMPT_NOTE = [
	"When this turn includes extension-generated workflow context, treat it as supplemental context for the current user request.",
	"Do not treat workflow context as replacing the user's request, and verify important implementation details with tools when needed.",
].join("\n");

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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

function serializeTurnEnrichmentPayload(result: unknown): string {
	if (!isRecord(result)) {
		return safeStringify(result);
	}

	if (hasOwn(result, "output") && !hasOwn(result, "outputPath")) {
		return safeStringify(result.output);
	}

	if (typeof result.outputPath === "string" && !hasOwn(result, "output")) {
		return safeStringify({ outputPath: result.outputPath });
	}

	return safeStringify(result);
}

function appendWorkflowContextSystemPrompt(systemPrompt: string): string {
	const trimmed = systemPrompt.trimEnd();
	return trimmed.length > 0
		? [trimmed, "", WORKFLOW_CONTEXT_SYSTEM_PROMPT_NOTE].join("\n")
		: WORKFLOW_CONTEXT_SYSTEM_PROMPT_NOTE;
}

export abstract class Workflow<TResult> extends WorkflowBase<TResult> {
	/**
	 * @deprecated The /workflow command no longer rewrites the user's prompt to request a workflow tool call.
	 * Use buildTurnEnrichment() to customize how workflow results are injected into the main agent turn.
	 */
	invoke: WorkflowInvoker = ({ name, input }) => {
		const parameters = JSON.stringify({ name, input }, null, 2);
		return [
			input,
			"Call the workflow tool exactly once with these exact parameters:",
			"",
			"```json",
			parameters,
			"```",
			"",
			"Do not change the parameters.",
			"After the tool returns, use its result in your response.",
		].join("\n");
	};

	async buildTurnEnrichment(context: WorkflowTurnEnrichmentContext<TResult>): Promise<WorkflowTurnEnrichment> {
		return {
			message: {
				customType: "workflow-context",
				content: [
					`[WORKFLOW CONTEXT: ${context.name}]`,
					"",
					"This is extension-generated workflow context for the current user request.",
					"It supplements the user's request and does not replace it.",
					"",
					"Context:",
					serializeTurnEnrichmentPayload(context.result),
				].join("\n"),
				display: true,
				details: {
					workflow: context.name,
					input: context.input,
					result: context.result,
				},
			},
			systemPrompt: appendWorkflowContextSystemPrompt(context.currentSystemPrompt),
		};
	}

	protected abstract runWorkflow(input: string): Promise<TResult>;

	async run(input: string): Promise<TResult> {
		return withWorkflowFeedbackScope("workflow", this.getFeedbackLabel(), async () => {
			let attempt = 1;
			let retriesRemaining = this.retries;

			while (true) {
				try {
					const result = await this.runWorkflow(input);
					await this.validateResult(result, input, attempt, retriesRemaining);
					return result;
				} catch (error) {
					const workflowError = this.normalizeValidationError(error, attempt);
					if (retriesRemaining <= 0) {
						throw workflowError;
					}

					this.note(
						`Attempt ${attempt} failed: ${workflowError.message}. Retrying (${retriesRemaining} ${retriesRemaining === 1 ? "retry" : "retries"} remaining).`,
						"warning",
					);
					retriesRemaining--;
					attempt++;
				}
			}
		});
	}
}
