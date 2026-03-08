# Changelog

## [Unreleased]

### Added

- Added typed workflow primitives on top of `createAgentSession()` with TypeBox contracts, explicit `workflow_result` completion, deterministic runtime defaults, and validation-repair retries.
- Added a reusable `Workflow` composition primitive with workflow-level validators and retries that rerun the entire workflow after child workflow/agent failures or workflow-level validation failures.
- Added `WorkflowRegistry` and `registerWorkflowExtension(pi, registry)` for coding-agent extensions, including a `workflow` tool, `/workflow` command, workflow-name autocomplete, and selection UI.
- Added a loadable package extension entry in `src/index.ts` with a built-in read-only `plan` workflow for quick testing.

### Changed

- Moved workflow primitives under `src/lib`, keeping `src/index.ts` as the extension entry and exporting the library API from `src/lib/index.ts`.
