# @ivanblagdan/pi-workflows

Typed workflow primitives for pi, plus a loadable pi extension that exposes registered workflows through a `workflow` tool and `/workflow` command.

## What this package is

`@ivanblagdan/pi-workflows` has two roles:

- **Pi extension**: install or load it in pi to get a `workflow` tool, `/workflow` command, autocomplete, selection UI, and built-in workflows.
- **TypeScript library**: import `WorkflowAgent`, `Workflow`, contracts, and registry helpers to build your own workflows.

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

The command does not run the workflow directly. Instead, it sends a user message telling the main agent to call the `workflow` tool with exact `{ name, input }` parameters. That means the workflow result is returned to the main agent as tool context.

Example:

```text
/workflow plan refactor auth
```

## Built-in workflows

### `plan`

The package currently ships with one built-in workflow:

- **plan** — create a read-only implementation plan for the current project

The built-in `plan` workflow uses a single `WorkflowAgent` with read-only tools:

- `read`
- `bash`
- `grep`
- `find`
- `ls`

Example:

```text
/workflow plan add a workflow command for release notes
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
  type InferRunResult,
  jsonResult,
} from "@ivanblagdan/pi-workflows";
import { Type } from "@sinclair/typebox";

const PlanContract = jsonResult(
  Type.Object(
    {
      plan: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
);

class PlanAgent extends WorkflowAgent<typeof PlanContract> {
  instructions = (input: string) => `Create a concise implementation plan for: ${input}`;
  contract = PlanContract;
}

class PlanWorkflow extends Workflow<InferRunResult<typeof PlanContract>> {
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
import { WorkflowAgent, jsonResult } from "@ivanblagdan/pi-workflows";

const ContextContract = jsonResult(
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

class ContextAgent extends WorkflowAgent<typeof ContextContract> {
  instructions = (input: string) => `Break this task into concrete research questions: ${input}`;
  contract = ContextContract;
  retries = 1;
}

const result = await new ContextAgent().run("How should workflows handle typed contracts?");
console.log(result.output.questions);
console.log(result.response);
```

### Contracts

#### JSON output

```ts
const SummaryContract = jsonResult(
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
import { artifactResult } from "@ivanblagdan/pi-workflows";

const DraftContract = artifactResult();

class DraftAgent extends WorkflowAgent<typeof DraftContract> {
  instructions = (input: string) => `Write the final draft for this task to disk and return its path: ${input}`;
  contract = DraftContract;
}

const draft = await new DraftAgent().run("Write the report");
console.log(draft.outputPath); // absolute path
```

Artifact workflows use the fixed contract:

```ts
{ path: string }
```

After a successful `workflow_result` call, the runtime checks that the file exists before resolving the promise.

### Composition with `Workflow`

Sequence and parallelism use plain promises.

```ts
const context = await new ContextAgent().run(task);

const answers = await Promise.all(
  context.output.questions.map((question) => new ResearchAgent().run(question.question)),
);

const summary = await new SummaryAgent().run(
  JSON.stringify({
    task,
    answers: answers.map((answer) => answer.output),
  }),
);
```

Use `Workflow` to package that composition into a reusable higher-level workflow.

```ts
import {
  Workflow,
  WorkflowAgent,
  type InferRunResult,
  jsonResult,
} from "@ivanblagdan/pi-workflows";
import { Type } from "@sinclair/typebox";

const SummaryContract = jsonResult(
  Type.Object(
    {
      summary: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
);

class SummaryAgent extends WorkflowAgent<typeof SummaryContract> {
  instructions = (_input: string) => "Summarize the research findings.";
  contract = SummaryContract;
}

class ResearchWorkflow extends Workflow<InferRunResult<typeof SummaryContract>> {
  protected async runWorkflow(input: string): Promise<InferRunResult<typeof SummaryContract>> {
    const context = await new ContextAgent().run(input);
    const answers = await Promise.all(
      context.output.questions.map((question) => new ResearchAgent().run(question.question)),
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

### Validation and retries

`workflow_result` is the completion signal. A `WorkflowAgent` run is complete only when:

1. the agent successfully calls `workflow_result`
2. built-in validation passes
3. custom validators pass

For JSON contracts, built-in validation is simply successful tool submission.
For artifact contracts, built-in validation also checks that the file exists.

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
