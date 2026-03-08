import { type Static, type TObject, Type } from "@sinclair/typebox";

export const ARTIFACT_RESULT_SCHEMA = Type.Object(
	{
		path: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

export type ArtifactResultPayload = Static<typeof ARTIFACT_RESULT_SCHEMA>;

export interface JsonWorkflowContract<TSchema extends TObject = TObject> {
	kind: "json";
	schema: TSchema;
}

export interface ArtifactWorkflowContract {
	kind: "artifact";
	schema: typeof ARTIFACT_RESULT_SCHEMA;
}

export type WorkflowContract = JsonWorkflowContract<TObject> | ArtifactWorkflowContract;

export function jsonResult<TSchema extends TObject>(schema: TSchema): JsonWorkflowContract<TSchema> {
	return {
		kind: "json",
		schema,
	};
}

export function artifactResult(): ArtifactWorkflowContract {
	return {
		kind: "artifact",
		schema: ARTIFACT_RESULT_SCHEMA,
	};
}

export function isJsonWorkflowContract<TSchema extends TObject>(
	contract: JsonWorkflowContract<TSchema> | WorkflowContract,
): contract is JsonWorkflowContract<TSchema> {
	return contract.kind === "json";
}
