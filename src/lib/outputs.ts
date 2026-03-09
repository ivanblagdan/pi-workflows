import { type Static, type TObject, Type } from "@sinclair/typebox";

export const ARTIFACT_RESULT_SCHEMA = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type ArtifactResultPayload = Static<typeof ARTIFACT_RESULT_SCHEMA>;

export interface JsonWorkflowOutput<TSchema extends TObject = TObject> {
	kind: "json";
	schema: TSchema;
}

export interface ArtifactWorkflowOutput {
	kind: "artifact";
	schema: typeof ARTIFACT_RESULT_SCHEMA;
}

export type WorkflowOutput = JsonWorkflowOutput<TObject> | ArtifactWorkflowOutput;

export function jsonOutput<TSchema extends TObject>(schema: TSchema): JsonWorkflowOutput<TSchema> {
	return {
		kind: "json",
		schema,
	};
}

export function artifactOutput(): ArtifactWorkflowOutput {
	return {
		kind: "artifact",
		schema: ARTIFACT_RESULT_SCHEMA,
	};
}

export function isJsonWorkflowOutput<TSchema extends TObject>(
	output: JsonWorkflowOutput<TSchema> | WorkflowOutput,
): output is JsonWorkflowOutput<TSchema> {
	return output.kind === "json";
}
