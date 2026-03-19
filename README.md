# @ivanblagdan/pi-workflows

Typed workflow primitives for pi, plus a loadable pi extension that exposes registered workflows through a `workflow` tool and a one-shot `/workflow` enrichment command.

## What this package is

`@ivanblagdan/pi-workflows` has two roles:

- **Pi extension**: install or load it in pi to get a `workflow` tool, one-shot `/workflow` turn enrichment, autocomplete, selection UI, and built-in workflows.
- **TypeScript library**: import `WorkflowAgent`, `Workflow`, output helpers, and registry helpers to build your own workflows.

## Installation

### As a pi extension

```bash
pi install npm:@ivanblagdan/pi-workflows
```

For local development from the repo root:

```bash
pi -e .
```

### As a TypeScript library

```bash
npm install @ivanblagdan/pi-workflows @sinclair/typebox
```

## Use as a pi extension

The package's default pi extension entry is `src/index.ts`.

When loaded, it registers:

- a `workflow` tool callable by the main agent
- a `/workflow <name> <input>` command
- workflow-name autocomplete for `/workflow`
- workflow selection UI when `/workflow` is run without a name

The `/workflow` command is a one-shot enrichment command. It preserves the user's original request, then runs the selected workflow during `before_agent_start` and injects the workflow's `buildTurnEnrichment(...)` output as extension-provided context before the main agent responds.

Example:

```text
/workflow discovery refactor auth flow to support SSO
```

## Built-in workflows

### `discovery`

The package currently ships with one built-in workflow:

- **discovery** — gather codebase context relevant to the current task

The built-in `discovery` workflow decomposes the task into research questions, runs bounded parallel read-only research, and injects concise observations, open questions, and references into the next turn.

Example:

```text
/workflow discovery add a workflow command for release notes
```

## Registering workflows in your own extension

`WorkflowRegistry` is intentionally small. It only stores named workflow registrations. Extension-specific tool, command, autocomplete, and UI wiring lives in `registerWorkflowExtension(...)`.

```ts
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  Workflow,
  WorkflowAgent,
  WorkflowRegistry,
  registerWorkflowExtension,
  type InferWorkflowResult,
  jsonOutput,
} from "@ivanblagdan/pi-workflows";
import { Type } from "@sinclair/typebox";

const PlanOutput = jsonOutput(
  Type.Object(
    {
      plan: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
);

class PlanAgent extends WorkflowAgent<typeof PlanOutput> {
  instructions = (input: string) => `Create a concise implementation plan for: ${input}`;
  output = PlanOutput;
}

class PlanWorkflow extends Workflow<InferWorkflowResult<typeof PlanOutput>> {
  protected async runWorkflow(input: string) {
    return new PlanAgent().run(input);
  }
}

export default function workflowExtension(pi: ExtensionAPI): void {
  const registry = new WorkflowRegistry();
  registry.register({
    name: "plan",
    description: "Create an implementation plan",
    create: () => new PlanWorkflow(),
  });

  registerWorkflowExtension(pi, registry);
}
```

## Library primitives

### Quick start: `WorkflowAgent`

```ts
import { Type } from "@sinclair/typebox";
import { WorkflowAgent, jsonOutput } from "@ivanblagdan/pi-workflows";

const ContextOutput = jsonOutput(
  Type.Object(
    {
      questions: Type.Array(
        Type.Object(
          {
            id: Type.String({ minLength: 1 }),
            question: Type.String({ minLength: 1 }),
          },
          { additionalProperties: false },
        ),
        { minItems: 1 },
      ),
    },
    { additionalProperties: false },
  ),
);

class ContextAgent extends WorkflowAgent<typeof ContextOutput> {
  instructions = (input: string) => `Break this task into concrete research questions: ${input}`;
  output = ContextOutput;
  retries = 1;
}

const result = await new ContextAgent().run("How should workflows handle typed outputs?");
console.log(result.output.questions);
console.log(result.response);
```

### Outputs

#### JSON output

```ts
const SummaryOutput = jsonOutput(
  Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
);
```

The `workflow_result` tool uses the exact TypeBox schema as its parameters. Native pi tool validation is authoritative. If the model submits invalid arguments, the tool call fails before the workflow stores the output.

#### Artifact output

```ts
import { artifactOutput } from "@ivanblagdan/pi-workflows";

const DraftOutput = artifactOutput();

class DraftAgent extends WorkflowAgent<typeof DraftOutput> {
  instructions = (input: string) => `Write the final draft for this task to disk and return its path: ${input}`;
  output = DraftOutput;
}

const draft = await new DraftAgent().run("Write the report");
console.log(draft.outputPath); // absolute path
```

Artifact workflows use the fixed output schema:

```ts
{ path: string }
```

After a successful `workflow_result` call, the runtime checks that the file exists before resolving the promise.

### Composition with `Workflow`

Sequence and parallelism use plain promises. For bounded parallelism, combine `Promise.all()` with `p-limit`.

```ts
import pLimit from "p-limit";

const limit = pLimit(3);
const context = await new ContextAgent().run(task);

const answers = await Promise.all(
  context.output.questions.map((question) =>
    limit(() => new ResearchAgent().run(question.question)),
  ),
);

const summary = await new SummaryAgent().run(
  JSON.stringify({
    task,
    answers: answers.map((answer) => answer.output),
  }),
);
```

Use `Workflow` to package that composition into a reusable higher-level workflow.

`Workflow` also exposes `buildTurnEnrichment(...)`, which the `/workflow` command uses to turn a workflow result into an extension-generated custom message and optional per-turn system prompt adjustment. Override it when a workflow needs custom enrichment formatting; otherwise the default implementation injects a generic `workflow-context` message.

```ts
import pLimit from "p-limit";
import {
  Workflow,
  WorkflowAgent,
  type InferWorkflowResult,
  jsonOutput,
} from "@ivanblagdan/pi-workflows";
import { Type } from "@sinclair/typebox";

const SummaryOutput = jsonOutput(
  Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
);

class SummaryAgent extends WorkflowAgent<typeof SummaryOutput> {
  instructions = (_input: string) => "Summarize the research findings.";
  output = SummaryOutput;
}

class ResearchWorkflow extends Workflow<InferWorkflowResult<typeof SummaryOutput>> {
  protected async runWorkflow(input: string): Promise<InferWorkflowResult<typeof SummaryOutput>> {
    const limit = pLimit(3);
    const context = await new ContextAgent().run(input);
    const answers = await Promise.all(
      context.output.questions.map((question) =>
        limit(() => new ResearchAgent().run(question.question)),
      ),
    );

    return new SummaryAgent().run(
      JSON.stringify({
        task: input,
        answers: answers.map((answer) => answer.output),
      }),
    );
  }
}
```

### Feedback primitives

Workflow feedback is separate from turn enrichment. Use `runWithWorkflowFeedback(...)` to capture structured workflow events, and use `step(...)`, `update(...)`, `note(...)`, and `artifact(...)` inside workflows or agents to emit semantic progress without wiring UI logic into the workflow itself. Workflow and agent runs emit lifecycle events automatically, and nested `WorkflowAgent` runs also emit tool execution scopes automatically.

```ts
import {
  Workflow,
  WorkflowFeedbackSink,
  runWithWorkflowFeedback,
} from "@ivanblagdan/pi-workflows";

const sink: WorkflowFeedbackSink = {
  emit(event) {
    console.log(event.type, event);
  },
};

await runWithWorkflowFeedback(sink, () =>
  new ResearchWorkflow().run("Investigate the auth refactor"),
);
```

```ts
class ResearchWorkflow extends Workflow<InferWorkflowResult<typeof SummaryOutput>> {
  protected async runWorkflow(input: string) {
    const context = await this.step("Derive research questions", () =>
      new ContextAgent().run(input),
    );

    this.note("Research fan-out started.");
    this.update("Research in progress", { completed: 1, total: 3 });
    this.artifact("questions", context.output.questions);

    return new SummaryAgent().run(input);
  }
}
```

### Validation and retries

`workflow_result` is the completion signal. A `WorkflowAgent` run is complete only when:

1. the agent successfully calls `workflow_result`
2. built-in validation passes
3. custom validators pass

For JSON outputs, built-in validation is simply successful tool submission.
For artifact outputs, built-in validation also checks that the file exists.

Add semantic validators with `.validate()`:

```ts
const agent = new DraftAgent()
  .validate(({ outputPath }) => {
    if (!outputPath.endsWith(".md")) {
      throw new Error("Artifact must be a markdown file");
    }
  })
  .retry(2);
```

Retry behavior differs by primitive:

- **`WorkflowAgent.retry(n)`** — additional repair cycles after validation failure
- **`Workflow.retry(n)`** — reruns the entire workflow from the start after child failures or workflow-level validation failures

### Environment defaults

By default, agent runs are deterministic:

- settings: isolated in-memory settings
- context files: inherit project `AGENTS.md` / `CLAUDE.md`
- extensions: disabled
- skills: disabled
- prompt templates: disabled
- themes: disabled

Override per category via the `environment` property:

```ts
class RepoAwareAgent extends ContextAgent {
  environment = {
    settings: { isolated: true },
    contextFiles: { inherit: "project" },
    extensions: { inherit: false },
    skills: { inherit: "project" },
    promptTemplates: { inherit: false },
    themes: { inherit: false },
  };
}
```

### Custom models and built-in tools

```ts
import { getModel } from "@mariozechner/pi-ai";
import { grepTool, readTool } from "@mariozechner/pi-coding-agent";

class ReadOnlyAgent extends ContextAgent {
  model = getModel("anthropic", "claude-sonnet-4-20250514");
  cwd = "/path/to/project";
  tools = [readTool, grepTool];
}
```

`tools` selects which built-in `@mariozechner/pi-coding-agent` tools are active for the workflow run. Tool execution still uses the workflow agent's `cwd`.

## Package structure

```text
src/
  index.ts                 Default pi extension entry
  extension.ts             Tool/command/autocomplete/UI wiring
  lib/                     Reusable workflow primitives
  workflows/               Built-in workflows shipped by the extension
```

## License

MIT
