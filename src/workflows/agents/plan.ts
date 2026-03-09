import { readOnlyTools, type CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { jsonOutput } from "../../lib/outputs.js";
import { WorkflowAgent } from "../../lib/workflow-agent.js";

export const PlanOutput = jsonOutput(
	Type.Object(
		{
			summary: Type.String({ minLength: 1 }),
			steps: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
);

export class PlanAgent extends WorkflowAgent<typeof PlanOutput> {
	instructions = (input: string) =>
		[
			"Inspect the current project and produce a concise implementation plan.",
			"Do not modify files.",
			"Focus on concrete actionable steps grounded in the codebase.",
		].join(" ");
	output = PlanOutput;
	tools: CreateAgentSessionOptions["tools"] = readOnlyTools;
}
