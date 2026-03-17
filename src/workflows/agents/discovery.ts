import { readOnlyTools, type CreateAgentSessionOptions } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { jsonOutput } from "../../lib/outputs.js";
import { WorkflowAgent } from "../../lib/workflow-agent.js";
import { getModel } from "@mariozechner/pi-ai";

export const DiscroveryOutput = jsonOutput(
	Type.Object(
		{
			questions: Type.Array(Type.Object({
				title: Type.String({ minLength: 1 }),
				task: Type.String({ minLength: 1 }),
				deliverable: Type.String({ minLength: 1 }),
				references: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			}), { minItems: 1 }),
		},
		{ additionalProperties: false },
	),
);

export class DiscoveryAgent extends WorkflowAgent<typeof DiscroveryOutput> {
	model = getModel("openai-codex", "gpt-5.4");
	thinkingLevel = "xhigh" as const;
	instructions = (input: string) =>
	`
Given the task provided by the user, what would you need to understand about the current code base to acomplish this task? Come up with a list of concrete research questions that can be answered by independent researchers working in isolation and no knowledge of the entire task.

Types of questions to ask:

- Which key concepts you should know more about?
- Are there any external dependencies involved?
- Which modules are involved?
- Which data flows exist around this area?
- What are the current side effects of the areas you might be modifying?
- What seams or public APIs already exist?
- What data or state transitions change?
- What are the preventable failure modes and edge cases?
- Does any unwanted coupling or fragility exist?
- Are there existing patterns that should be reused?
- What tests and observability already exist?

Write each question so that they can be passed to different researchers without needing to share the full list or context.
Question format:

## [Question title here]
Task:
[Detailed question here, with any necessary context or examples to clarify what is being asked.]

Deliverable:
[What the researcher should produce as an answer, such as a document, diagram, code snippet, or list of resources.]

References:
[Links to relevant code, documentation, or resources that would help answer the question.]
	`
	output = DiscroveryOutput;
	tools: CreateAgentSessionOptions["tools"] = readOnlyTools;
}
