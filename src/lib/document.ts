export type DocPart = string | null | undefined | false;

function normalizeDocPart(part: DocPart): string {
	if (typeof part !== "string") {
		return "";
	}
	return part.trim();
}

export function lines(...parts: DocPart[]): string {
	return parts.map(normalizeDocPart).filter((part) => part.length > 0).join("\n");
}

export function doc(...blocks: DocPart[]): string {
	return blocks.map(normalizeDocPart).filter((block) => block.length > 0).join("\n\n");
}

export function section(title: string, body: DocPart): string {
	const normalizedTitle = title.trim();
	const normalizedBody = normalizeDocPart(body);
	if (normalizedTitle.length === 0 || normalizedBody.length === 0) {
		return "";
	}
	return `${normalizedTitle}:\n${normalizedBody}`;
}

export function bullets(
	items: Iterable<string>,
	options?: {
		bullet?: string;
		empty?: string;
	},
): string {
	const bulletPrefix = options?.bullet ?? "- ";
	const normalizedItems = [...items]
		.map((item) => item.trim())
		.filter((item) => item.length > 0)
		.map((item) => `${bulletPrefix}${item}`);

	if (normalizedItems.length > 0) {
		return normalizedItems.join("\n");
	}

	const emptyValue = options?.empty?.trim();
	if (!emptyValue) {
		return "";
	}
	return `${bulletPrefix}${emptyValue}`;
}

export function docList<T>(
	items: Iterable<T>,
	render: (item: T, index: number) => DocPart,
	options?: {
		separator?: string;
		empty?: DocPart;
	},
): string {
	const renderedItems = [...items]
		.map((item, index) => normalizeDocPart(render(item, index)))
		.filter((item) => item.length > 0);

	if (renderedItems.length > 0) {
		return renderedItems.join(options?.separator ?? "\n\n");
	}

	return normalizeDocPart(options?.empty ?? "");
}
