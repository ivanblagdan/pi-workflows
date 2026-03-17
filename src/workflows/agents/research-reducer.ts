import { readOnlyTools, type CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { jsonOutput } from "../../lib/outputs.js";
import { WorkflowAgent } from "../../lib/workflow-agent.js";
import { getModel } from "@mariozechner/pi-ai";

export const ResearchReducerOutput = jsonOutput(
	Type.Object(
		{
			observations: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			openQuestions: Type.Array(Type.String({ minLength: 1 }), { minItems: 0 }),
			references: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
);

export class ResearchReducerAgent extends WorkflowAgent<typeof ResearchReducerOutput> {
	model = getModel("openai-codex", "gpt-5.4");
	thinkingLevel = "medium" as const;
	instructions = (input: string) =>
	`
You're provided with research results from multiple independent researchers about a specific task.
Consolidate the results into observations that can be used for implementation planning.
Remove any redundant or overlapping information and group related observations together.
	`
	output = ResearchReducerOutput;
	tools: CreateAgentSessionOptions["tools"] = readOnlyTools;
}
