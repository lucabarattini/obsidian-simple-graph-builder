import { OntologyExtractionResult, OntologyNode, RawExtractionNode } from '../types';

const MONTH_NAMES = [
	'january', 'february', 'march', 'april', 'may', 'june',
	'july', 'august', 'september', 'october', 'november', 'december',
	'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno',
	'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre',
];

const JOURNAL_SCAFFOLD_NAMES = new Set([
	'i',
	'me',
	'myself',
	'narrator',
	'author',
	'the author',
	'journal',
	'journaling',
	'journal entry',
	'diary entry',
	'daily note',
	'entry timestamp',
	'timestamp',
	'date',
	'time',
	'location',
	'weather',
]);

function normalizeQualityName(name: string): string {
	return name
		.toLowerCase()
		.trim()
		.replace(/[–—]/g, '-')
		.replace(/\s+/g, ' ');
}

export function isCalendarDateName(name: string): boolean {
	const normalized = normalizeQualityName(name);
	const monthPattern = MONTH_NAMES.join('|');

	if (new RegExp(`^(?:\\d{1,2}\\s+)?(?:${monthPattern})(?:\\s+\\d{2,4})?(?:\\s+at\\s+.+)?$`, 'i').test(normalized)) {
		return true;
	}

	return /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}(?:[_\s].*)?$/.test(normalized);
}

export function isTimeMetadataName(name: string): boolean {
	const normalized = normalizeQualityName(name);
	return /^\d{1,2}:\d{2}(?::\d{2})?(?:\s*[a-z]{2,5}(?:[+-]\d{1,2})?)?$/.test(normalized);
}

export function isWeatherMetadataName(name: string): boolean {
	const normalized = normalizeQualityName(name);
	return normalized.startsWith('weather')
		|| /-?\d{1,3}\s*°\s*[cf]\b/.test(normalized);
}

export function isJournalScaffoldName(name: string): boolean {
	const normalized = normalizeQualityName(name);
	return JOURNAL_SCAFFOLD_NAMES.has(normalized)
		|| /^(?:personal\s+)?journal entry\b/.test(normalized)
		|| /^journaling\s*[-:]/.test(normalized);
}

export function isLikelyJournalMetadataName(name: string): boolean {
	const normalized = normalizeQualityName(name);
	return /^(?:date|time)\s*:/.test(normalized)
		|| isCalendarDateName(name)
		|| isTimeMetadataName(name)
		|| isWeatherMetadataName(name)
		|| isJournalScaffoldName(name);
}

export function isLikelyJournalMetadataNode(node: OntologyNode): boolean {
	return isLikelyJournalMetadataName(node.properties.name);
}

/**
 * Remove deterministic journal scaffolding after extraction so even an LLM that
 * ignores the prompt cannot promote dates, weather, or "Journal entry" into the
 * semantic graph.
 */
export function filterJournalMetadataExtraction(
	extraction: OntologyExtractionResult
): OntologyExtractionResult {
	const retainedNodes = extraction.nodes.filter(node =>
		!isLikelyJournalMetadataName(node.properties.name)
	);
	const retainedIds = new Set(retainedNodes.map(node => node.id));
	const retainedNames = new Set(retainedNodes.map(node =>
		normalizeQualityName(node.properties.name)
	));

	return {
		nodes: retainedNodes,
		relationships: extraction.relationships.filter(relationship => {
			const source = normalizeQualityName(relationship.source);
			const target = normalizeQualityName(relationship.target);
			return (retainedIds.has(relationship.source) || retainedNames.has(source))
				&& (retainedIds.has(relationship.target) || retainedNames.has(target));
		}),
	};
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replacePseudonymsInText(
	value: string,
	pseudonyms: Record<string, string>
): string {
	let result = value;
	for (const [privateName, replacement] of Object.entries(pseudonyms)) {
		const source = privateName.trim();
		const target = replacement.trim();
		if (!source || !target) continue;
		result = result.replace(new RegExp(`\\b${escapeRegExp(source)}\\b`, 'giu'), target);
	}
	return result;
}

/**
 * Apply private display-name substitutions before cache resolution. This keeps
 * future analysis attached to the pseudonym without rewriting the Markdown note.
 */
export function applyEntityPseudonyms(
	extraction: OntologyExtractionResult,
	pseudonyms: Record<string, string>
): OntologyExtractionResult {
	if (Object.keys(pseudonyms).length === 0) return extraction;

	const replacementByName = new Map(
		Object.entries(pseudonyms)
			.map(([source, target]) => [normalizeQualityName(source), target.trim()] as const)
			.filter(([, target]) => target.length > 0)
	);

	return {
		nodes: extraction.nodes.map(node => {
			const originalName = node.properties.name;
			const replacement = replacementByName.get(normalizeQualityName(originalName));
			const description = node.properties.description;
			return {
				...node,
				properties: {
					...node.properties,
					name: replacement || originalName,
					...(typeof description === 'string'
						? { description: replacePseudonymsInText(description, pseudonyms) }
						: {}),
				},
			};
		}),
		relationships: extraction.relationships.map(relationship => {
			const detail = relationship.properties.detail;
			return {
				...relationship,
				properties: {
					...relationship.properties,
					...(typeof detail === 'string'
						? { detail: replacePseudonymsInText(detail, pseudonyms) }
						: {}),
				},
			};
		}),
	};
}

/**
 * Structured metadata values can be semantically similar while representing
 * different facts. Never merge distinct dates, times, or weather readings.
 */
export function canMergeEntityNames(
	incoming: Pick<RawExtractionNode, 'entityType' | 'properties'>,
	existingName: string
): boolean {
	const incomingName = incoming.properties.name;
	const incomingStructured = isCalendarDateName(incomingName)
		|| isTimeMetadataName(incomingName)
		|| isWeatherMetadataName(incomingName);
	const existingStructured = isCalendarDateName(existingName)
		|| isTimeMetadataName(existingName)
		|| isWeatherMetadataName(existingName);

	if (!incomingStructured && !existingStructured) return true;
	return normalizeQualityName(incomingName) === normalizeQualityName(existingName);
}
