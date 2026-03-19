import pLimit from "p-limit";
import type { WorkflowRegistration } from "../lib/registry.js";
import type { InferWorkflowResult, WorkflowTurnEnrichment, WorkflowTurnEnrichmentContext } from "../lib/types.js";
import { Workflow } from "../lib/workflow.js";
import { DiscoveryAgent } from "./agents/discovery.js";
import { ResearchReducerOutput } from "./agents/research-reducer.js";
import { ResearchReducerAgent } from "./agents/research-reducer.js";
import { ResearchAgent } from "./agents/research.js";

const DISCOVERY_RESEARCH_CONCURRENCY = 3;

export class DiscroveryWorkflow extends Workflow<InferWorkflowResult<typeof ResearchReducerOutput>> {
	async buildTurnEnrichment(
		context: WorkflowTurnEnrichmentContext<InferWorkflowResult<typeof ResearchReducerOutput>>,
	): Promise<WorkflowTurnEnrichment> {
		const baseEnrichment = await super.buildTurnEnrichment(context);
		const openQuestions =
			context.result.output.openQuestions.length > 0
				? context.result.output.openQuestions.map((question) => `- ${question}`)
				: ["- (none)"];

		return {
			...baseEnrichment,
			message: {
				customType: "workflow-context",
				content: [
					`[WORKFLOW CONTEXT: ${context.name}]`,
					"",
					"This is extension-generated preparatory context for the current user request.",
					"It supplements the user's request and does not replace it.",
					"",
					"Observations:",
					...context.result.output.observations.map((observation) => `- ${observation}`),
					"",
					"Open questions:",
					...openQuestions,
					"",
					"References:",
					...context.result.output.references.map((reference) => `- ${reference}`),
				].join("\n"),
				display: true,
				details: {
					workflow: context.name,
					input: context.input,
					output: context.result.output,
					response: context.result.response,
					summary: {
						observations: context.result.output.observations.length,
						openQuestions: context.result.output.openQuestions.length,
						references: context.result.output.references.length,
					},
				},
			},
		};
	}

	protected async runWorkflow(input: string): Promise<InferWorkflowResult<typeof ResearchReducerOutput>> {
		const topics = (
			await this.step("Generate research questions", () => new DiscoveryAgent().run(input))
		).output;
		const limit = pLimit(DISCOVERY_RESEARCH_CONCURRENCY);
		const totalQuestions = topics.questions.length;
		let completedQuestions = 0;
		const answers = await this.step(`Research ${totalQuestions} questions`, () =>
			Promise.all(
				topics.questions.map((question) =>
					limit(async () => {
						const task = [
							"Task: \n" + question.task,
							"Deliverable: \n" + question.deliverable,
							"References: \n" + question.references.map((ref) => `- ${ref}`).join("\n"),
						].join("\n\n");

						const answer = (await new ResearchAgent().run(task)).output;
						completedQuestions++;
						this.update("Research in progress", {
							completed: completedQuestions,
							total: totalQuestions,
						});
						return answer;
					}),
				),
			),
		);

		const flatAnswers = answers
			.map((answer) =>
				[
					"Research Result: \n" + answer.deliverable,
					"Open Questions: \n" + answer.openQuestions.map((q) => `- ${q}`).join("\n"),
					"References: \n" + answer.references.map((ref) => `- ${ref}`).join("\n"),
				]
					.join("\n\n")
					.trim(),
			)
			.join("\n\n---\n\n");

		const result = await this.step("Reduce research findings", () => new ResearchReducerAgent().run(flatAnswers));
		this.artifact("discovery-summary", result.output);
		return result;
	}
}

export const discoveryWorkflow: WorkflowRegistration<InferWorkflowResult<typeof ResearchReducerOutput>> = {
	name: "discovery",
	description: "Gather information about the codebase relevant to a task.",
	create: () => new DiscroveryWorkflow(),
};
