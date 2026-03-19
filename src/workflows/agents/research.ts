import { getModel } from "@mariozechner/pi-ai";
import { readOnlyTools, type CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { jsonOutput } from "../../lib/outputs.js";
import { WorkflowAgent } from "../../lib/workflow-agent.js";

export const ResearchOutput = jsonOutput(
	Type.Object(
		{
			deliverable: Type.String({ minLength: 1 }),
			openQuestions: Type.Array(Type.String({ minLength: 1 }), { minItems: 0 }),
			references: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
);

export class ResearchAgent extends WorkflowAgent<typeof ResearchOutput> {
	feedbackLabel = "question research";
	model = getModel("openai-codex", "gpt-5.4");
	thinkingLevel = "medium" as const;
	instructions = (input: string) =>
	`
Research the task provided using available tools and produce a concrete deliverable as specified.

- The deliverable should be concise and to the point
- Use official documentation first when necessary
- Use code search to find relevant code snippets and examples
- Use the compiler or REPL to test hypotheses and verify your understanding of the code
- Pass on any open questions that you cannot answer youself
	`
	output = ResearchOutput;
	tools: CreateAgentSessionOptions["tools"] = readOnlyTools;
}
