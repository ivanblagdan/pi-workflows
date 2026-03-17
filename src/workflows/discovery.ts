import pLimit from "p-limit";
import type { WorkflowRegistration } from "../lib/registry.js";
import type { InferWorkflowResult } from "../lib/types.js";
import { Workflow } from "../lib/workflow.js";
import { DiscoveryAgent } from "./agents/discovery.js";
import { ResearchReducerOutput } from "./agents/research-reducer.js";
import { ResearchReducerAgent } from "./agents/research-reducer.js";
import { ResearchAgent } from "./agents/research.js";

const DISCOVERY_RESEARCH_CONCURRENCY = 3;

export class DiscroveryWorkflow extends Workflow<InferWorkflowResult<typeof ResearchReducerOutput>> {
	protected async runWorkflow(input: string): Promise<InferWorkflowResult<typeof ResearchReducerOutput>> {
		const topics = (await new DiscoveryAgent().run(input)).output;
		const limit = pLimit(DISCOVERY_RESEARCH_CONCURRENCY);
		const answers = await Promise.all(
			topics.questions.map((question) =>
				limit(async () => {
					const task = [
						"Task: \n" + question.task,
						"Deliverable: \n" + question.deliverable,
						"References: \n" + question.references.map((ref) => `- ${ref}`).join("\n"),
					].join("\n\n");

					return (await new ResearchAgent().run(task)).output;
				}),
			),
		);

		const flatAnswers = answers.map((answer) => [
			"Research Result: \n" + answer.deliverable,
			"Open Questions: \n" + answer.openQuestions.map((q) => `- ${q}`).join("\n"),
			"References: \n" + answer.references.map((ref) => `- ${ref}`).join("\n"),
		].join("\n\n").trim()).join("\n\n---\n\n");

		return new ResearchReducerAgent().run(flatAnswers);
	}
}

export const discoveryWorkflow: WorkflowRegistration<InferWorkflowResult<typeof ResearchReducerOutput>> = {
	name: "discovery",
	description: "Gather information about the codebase relevant to a task.",
	create: () => new DiscroveryWorkflow(),
};
