import { GraphData, OntologyNode } from '../types';

/**
 * Normalize a vault-relative source folder without depending on the Obsidian
 * runtime. Keeping this helper pure also makes cached-graph filtering testable.
 */
export function normalizeSourceFolder(folder: string): string {
	return folder
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '')
		.replace(/\/{2,}/g, '/');
}

export function notePathMatchesFolder(notePath: string, folder: string): boolean {
	const normalizedFolder = normalizeSourceFolder(folder);
	if (!normalizedFolder) return true;

	const normalizedPath = notePath.replace(/\\/g, '/').replace(/^\/+/, '');
	return normalizedPath.startsWith(`${normalizedFolder}/`);
}

/**
 * Build a scoped graph entirely from persisted provenance. No extraction or API
 * call is needed: node source-note lists are narrowed to the folder and edges
 * are retained only when their creating note is inside it.
 */
export function filterGraphBySourceFolder(graph: GraphData, folder: string): GraphData {
	const normalizedFolder = normalizeSourceFolder(folder);
	if (!normalizedFolder) return graph;

	const nodes = graph.nodes
		.map(node => ({
			...node,
			sourceNotes: node.sourceNotes.filter(path => notePathMatchesFolder(path, normalizedFolder)),
		}))
		.filter(node => node.sourceNotes.length > 0);

	const nodeIds = new Set(nodes.map(node => node.id));
	const edges = graph.edges.filter(edge => {
		if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) return false;
		// Current graph data always records sourceNote. Keep legacy edges only
		// when both endpoint nodes survive the folder scope.
		return !edge.sourceNote || notePathMatchesFolder(edge.sourceNote, normalizedFolder);
	});

	return {
		nodes,
		edges,
		version: graph.version,
	};
}

export function filterGraphByNodePredicate(
	graph: GraphData,
	predicate: (node: OntologyNode) => boolean
): GraphData {
	const nodes = graph.nodes.filter(predicate);
	const nodeIds = new Set(nodes.map(node => node.id));
	return {
		nodes,
		edges: graph.edges.filter(edge =>
			nodeIds.has(edge.source) && nodeIds.has(edge.target)
		),
		version: graph.version,
	};
}

/**
 * Return every folder represented in the cached graph, including useful parent
 * scopes such as "__main__" and "__main__/Journaling".
 */
export function getGraphSourceFolders(graph: GraphData): string[] {
	const folders = new Set<string>();

	for (const node of graph.nodes) {
		for (const notePath of node.sourceNotes) {
			const parts = notePath.replace(/\\/g, '/').split('/').filter(Boolean);
			parts.pop();
			for (let depth = 1; depth <= parts.length; depth++) {
				folders.add(parts.slice(0, depth).join('/'));
			}
		}
	}

	return [...folders].sort((a, b) => a.localeCompare(b));
}
