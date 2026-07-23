import { GraphData } from '../types';

export const RELATED_NOTES_START = '<!-- simple-graph-builder:related-notes:start -->';
export const RELATED_NOTES_END = '<!-- simple-graph-builder:related-notes:end -->';

export interface BacklinkSuggestionOptions {
	minSharedEntities: number;
	maxLinksPerNote: number;
	maxEntityDocumentFrequency: number;
	limit: number;
}

export interface BacklinkSuggestion {
	sourcePath: string;
	targetPath: string;
	score: number;
	sharedEntities: string[];
}

export interface RelatedNoteLink {
	targetPath: string;
	sharedEntities: string[];
}

interface PairAccumulator {
	sourcePath: string;
	targetPath: string;
	score: number;
	sharedEntities: Set<string>;
}

/**
 * Suggest note pairs from shared extracted entities. IDF weighting makes a rare,
 * specific shared entity count more than a generic entity found across the vault.
 */
export function buildBacklinkSuggestions(
	graph: GraphData,
	options: BacklinkSuggestionOptions
): BacklinkSuggestion[] {
	const notePaths = new Set<string>();
	for (const node of graph.nodes) {
		for (const path of node.sourceNotes) notePaths.add(path);
	}

	const noteCount = notePaths.size;
	if (noteCount < 2) return [];

	const pairAccumulators = new Map<string, PairAccumulator>();
	const maxDocumentCount = Math.max(2, Math.floor(noteCount * options.maxEntityDocumentFrequency));

	for (const node of graph.nodes) {
		const sources = [...new Set(node.sourceNotes)].sort();
		if (sources.length < 2 || sources.length > maxDocumentCount) continue;

		const weight = 1 + Math.log((noteCount + 1) / (sources.length + 1));
		for (let i = 0; i < sources.length; i++) {
			for (let j = i + 1; j < sources.length; j++) {
				const sourcePath = sources[i];
				const targetPath = sources[j];
				const key = `${sourcePath}\u0000${targetPath}`;
				const accumulator = pairAccumulators.get(key) ?? {
					sourcePath,
					targetPath,
					score: 0,
					sharedEntities: new Set<string>(),
				};
				accumulator.score += weight;
				accumulator.sharedEntities.add(node.properties.name);
				pairAccumulators.set(key, accumulator);
			}
		}
	}

	const ranked = [...pairAccumulators.values()]
		.filter(pair => pair.sharedEntities.size >= options.minSharedEntities)
		.map(pair => ({
			sourcePath: pair.sourcePath,
			targetPath: pair.targetPath,
			score: pair.score,
			sharedEntities: [...pair.sharedEntities].sort(),
		}))
		.sort((a, b) => b.score - a.score
			|| b.sharedEntities.length - a.sharedEntities.length
			|| a.sourcePath.localeCompare(b.sourcePath)
			|| a.targetPath.localeCompare(b.targetPath));

	// Greedily keep the strongest pairs while preventing a handful of journal
	// entries from receiving an overwhelming number of generated links.
	const linksPerNote = new Map<string, number>();
	const selected: BacklinkSuggestion[] = [];
	for (const suggestion of ranked) {
		if (selected.length >= options.limit) break;
		const sourceCount = linksPerNote.get(suggestion.sourcePath) ?? 0;
		const targetCount = linksPerNote.get(suggestion.targetPath) ?? 0;
		if (sourceCount >= options.maxLinksPerNote || targetCount >= options.maxLinksPerNote) continue;

		selected.push(suggestion);
		linksPerNote.set(suggestion.sourcePath, sourceCount + 1);
		linksPerNote.set(suggestion.targetPath, targetCount + 1);
	}

	return selected;
}

/** Remove generated links before hashing or sending a note to an LLM. */
export function stripManagedRelatedNotes(content: string): string {
	return content.replace(getManagedSectionPattern(), '').trimEnd();
}

/** Add or replace the plugin-owned section while leaving all other prose intact. */
export function upsertManagedRelatedNotes(
	content: string,
	links: RelatedNoteLink[]
): string {
	const withoutManagedSection = stripManagedRelatedNotes(content);
	if (links.length === 0) return withoutManagedSection;

	const uniqueLinks = new Map<string, RelatedNoteLink>();
	for (const link of links) {
		const existing = uniqueLinks.get(link.targetPath);
		if (existing) {
			existing.sharedEntities = [...new Set([...existing.sharedEntities, ...link.sharedEntities])].sort();
		} else {
			uniqueLinks.set(link.targetPath, {
				targetPath: link.targetPath,
				sharedEntities: [...new Set(link.sharedEntities)].sort(),
			});
		}
	}

	const lines = [...uniqueLinks.values()]
		.sort((a, b) => a.targetPath.localeCompare(b.targetPath))
		.map(link => {
			const wikilinkTarget = link.targetPath.replace(/\.md$/i, '');
			const displayName = getNoteDisplayName(link.targetPath);
			const shared = link.sharedEntities.slice(0, 5).map(escapeMarkdownText).join(', ');
			return `- [[${wikilinkTarget}|${displayName}]] — shared themes: ${shared}`;
		});

	const section = [
		RELATED_NOTES_START,
		'## Related notes',
		'',
		'> [!info] Suggested connections',
		'> Generated locally from shared graph entities. Review these links as prompts, not conclusions.',
		'',
		...lines,
		RELATED_NOTES_END,
	].join('\n');

	return withoutManagedSection.length > 0
		? `${withoutManagedSection}\n\n${section}\n`
		: `${section}\n`;
}

export function getNoteDisplayName(path: string): string {
	const filename = path.split('/').pop() ?? path;
	return filename.replace(/\.md$/i, '');
}

function getManagedSectionPattern(): RegExp {
	return new RegExp(
		`\\n?${escapeRegExp(RELATED_NOTES_START)}[\\s\\S]*?${escapeRegExp(RELATED_NOTES_END)}\\n?`,
		'g'
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeMarkdownText(value: string): string {
	return value.replace(/([\\`*_{}\[\]<>])/g, '\\$1');
}
