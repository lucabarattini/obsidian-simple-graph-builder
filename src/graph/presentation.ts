import { OntologyEdge, OntologyNode } from '../types';

export interface AggregatedGraphEdge {
	id: string;
	source: string;
	target: string;
	relationship: string;
	detail: string;
	weight: number;
	sourceNoteCount: number;
}

interface EdgeAccumulator {
	source: string;
	target: string;
	relationships: Set<string>;
	details: Set<string>;
	sourceNotes: Set<string>;
	weight: number;
}

/**
 * Capitalize every word boundary for display without changing the stored entity
 * name used by search and entity resolution.
 */
export function toTitleCaseLabel(label: string): string {
	return label.replace(
		/(^|[\s/–—-])(\p{L})/gu,
		(_match, prefix: string, letter: string) => `${prefix}${letter.toLocaleUpperCase()}`
	);
}

/**
 * The meaning graph is an association map, so render parallel and reciprocal
 * extracted relationships as one weighted visual edge. The original edges remain
 * untouched in the cache and are summarized in the tooltip.
 */
export function aggregateGraphEdges(edges: OntologyEdge[]): AggregatedGraphEdge[] {
	const grouped = new Map<string, EdgeAccumulator>();

	for (const edge of edges) {
		if (edge.source === edge.target) continue;

		const [source, target] = [edge.source, edge.target].sort((a, b) => a.localeCompare(b));
		const key = `${source}\u0000${target}`;
		let accumulator = grouped.get(key);
		if (!accumulator) {
			accumulator = {
				source,
				target,
				relationships: new Set(),
				details: new Set(),
				sourceNotes: new Set(),
				weight: 0,
			};
			grouped.set(key, accumulator);
		}

		accumulator.weight += 1;
		accumulator.relationships.add(edge.relationship || edge.type || 'relates to');
		const detail = edge.properties?.detail;
		if (typeof detail === 'string' && detail.trim()) {
			accumulator.details.add(detail.trim());
		}
		if (edge.sourceNote) accumulator.sourceNotes.add(edge.sourceNote);
	}

	return [...grouped.values()].map(accumulator => {
		const relationships = [...accumulator.relationships];
		const visibleRelationships = relationships.slice(0, 3);
		const relationship = visibleRelationships.join(' · ')
			+ (relationships.length > visibleRelationships.length
				? ` · +${relationships.length - visibleRelationships.length} more`
				: '');
		const support = accumulator.sourceNotes.size > 0
			? `${accumulator.sourceNotes.size} source note${accumulator.sourceNotes.size === 1 ? '' : 's'}`
			: `${accumulator.weight} extracted relationship${accumulator.weight === 1 ? '' : 's'}`;
		const examples = [...accumulator.details].slice(0, 2);

		return {
			id: `render:${encodeURIComponent(accumulator.source)}::${encodeURIComponent(accumulator.target)}`,
			source: accumulator.source,
			target: accumulator.target,
			relationship,
			detail: examples.length > 0 ? `${support} · ${examples.join(' · ')}` : support,
			weight: accumulator.weight,
			sourceNoteCount: accumulator.sourceNotes.size,
		};
	});
}

export function retainConnectedNodes(
	nodes: OntologyNode[],
	edges: Array<Pick<OntologyEdge, 'source' | 'target'>>
): OntologyNode[] {
	const connectedNodeIds = new Set<string>();
	for (const edge of edges) {
		connectedNodeIds.add(edge.source);
		connectedNodeIds.add(edge.target);
	}
	return nodes.filter(node => connectedNodeIds.has(node.id));
}

/**
 * Keep the largest connected component in the currently filtered view. This is
 * useful for a centered "meaning map" while preserving the other components in
 * cache so the user can reveal them with one toggle.
 */
export function retainLargestConnectedComponent(
	nodes: OntologyNode[],
	edges: Array<Pick<OntologyEdge, 'source' | 'target'>>
): OntologyNode[] {
	if (nodes.length === 0) return [];

	const visibleNodeIds = new Set(nodes.map(node => node.id));
	const adjacency = new Map<string, Set<string>>(
		nodes.map(node => [node.id, new Set<string>()])
	);
	for (const edge of edges) {
		if (!visibleNodeIds.has(edge.source) || !visibleNodeIds.has(edge.target)) continue;
		adjacency.get(edge.source)?.add(edge.target);
		adjacency.get(edge.target)?.add(edge.source);
	}

	const visited = new Set<string>();
	let largest = new Set<string>();
	for (const node of nodes) {
		if (visited.has(node.id)) continue;

		const component = new Set<string>();
		const pending = [node.id];
		visited.add(node.id);
		while (pending.length > 0) {
			const current = pending.pop();
			if (!current) continue;
			component.add(current);
			for (const neighbor of adjacency.get(current) ?? []) {
				if (visited.has(neighbor)) continue;
				visited.add(neighbor);
				pending.push(neighbor);
			}
		}

		if (component.size > largest.size) largest = component;
	}

	return nodes.filter(node => largest.has(node.id));
}
