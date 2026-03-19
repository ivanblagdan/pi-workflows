import pLimit from "p-limit";
import { bullets, doc, docList, lines, section } from "../lib/document.js";
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

		return {
			...baseEnrichment,
			message: {
				customType: "workflow-context",
				content: doc(
					`[WORKFLOW CONTEXT: ${context.name}]`,
					lines(
						"This is extension-generated preparatory context for the current user request.",
						"It supplements the user's request and does not replace it.",
					),
					section("Observations", bullets(context.result.output.observations)),
					section("Open questions", bullets(context.result.output.openQuestions, { empty: "(none)" })),
					section("References", bullets(context.result.output.references)),
				),
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
						const task = doc(
							section("Task", question.task),
							section("Deliverable", question.deliverable),
							section("References", bullets(question.references)),
						);

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

		const flatAnswers = docList(
			answers,
			(answer) =>
				doc(
					section("Research Result", answer.deliverable),
					section("Open Questions", bullets(answer.openQuestions, { empty: "(none)" })),
					section("References", bullets(answer.references)),
				),
			{ separator: "\n\n---\n\n" },
		);

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
