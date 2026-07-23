import assert from 'node:assert/strict';
import { analyzeGraph } from '../src/graph/analytics';
import {
	buildBacklinkSuggestions,
	stripManagedRelatedNotes,
	upsertManagedRelatedNotes,
} from '../src/graph/backlinks';
import { chunkContent } from '../src/extraction/prompts';
import { GraphData, OntologyEdge, OntologyNode } from '../src/types';

function node(id: string, name: string, sourceNotes: string[]): OntologyNode {
	return {
		id,
		entityType: 'CONCEPT',
		properties: { name },
		sourceNotes,
	};
}

function edge(source: string, target: string, index: number): OntologyEdge {
	return {
		id: `edge-${index}`,
		source,
		target,
		relationship: 'relates to',
		properties: {},
	};
}

function testChunkingKeepsLongNotes(): void {
	const content = `${'a'.repeat(2200)}\n\n${'b'.repeat(2200)} END`;
	const chunks = chunkContent(content, 500);
	assert.ok(chunks.length >= 3);
	assert.ok(chunks.every(chunk => chunk.length <= 1500));
	assert.equal(chunks[0][0], 'a');
	assert.ok(chunks.at(-1)?.endsWith('END'));
}

function testBacklinkRankingAndManagedSection(): void {
	const graph: GraphData = {
		version: 3,
		nodes: [
			node('n1', 'Topic Alpha', ['Area-One/A.md', 'Area-Two/B.md']),
			node('n2', 'Topic Beta', ['Area-One/A.md', 'Area-Two/B.md']),
			node('n3', 'Topic Gamma', ['Area-Three/C.md', 'Area-Two/B.md']),
		],
		edges: [],
	};

	const suggestions = buildBacklinkSuggestions(graph, {
		minSharedEntities: 2,
		maxLinksPerNote: 3,
		maxEntityDocumentFrequency: 1,
		limit: 20,
	});
	assert.equal(suggestions.length, 1);
	assert.deepEqual(suggestions[0].sharedEntities, ['Topic Alpha', 'Topic Beta']);

	const original = '# Entry\n\nPrivate prose.\n';
	const linked = upsertManagedRelatedNotes(original, [{
		targetPath: 'Area-One/A.md',
		sharedEntities: suggestions[0].sharedEntities,
	}]);
	assert.match(linked, /\[\[Area-One\/A\|A\]\]/);
	assert.equal(upsertManagedRelatedNotes(linked, [{
		targetPath: 'Area-One/A.md',
		sharedEntities: suggestions[0].sharedEntities,
	}]), linked);
	assert.equal(stripManagedRelatedNotes(linked), original.trimEnd());
}

function testHubAndBridgeMetrics(): void {
	const nodes = [
		node('a', 'A', ['A.md']),
		node('b', 'B', ['B.md']),
		node('c', 'Bridge', ['C.md']),
		node('d', 'D', ['D.md']),
		node('e', 'E', ['E.md']),
	];
	const pairs: Array<[string, string]> = [
		['a', 'b'], ['a', 'c'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['c', 'e'],
	];
	const graph: GraphData = {
		version: 3,
		nodes,
		edges: pairs.map(([source, target], index) => edge(source, target, index)),
	};

	const analytics = analyzeGraph(graph);
	assert.equal(analytics.rankedNodes[0].node.properties.name, 'Bridge');
	assert.equal(analytics.rankedNodes[0].degree, 4);
	assert.equal(analytics.metricsByNodeId.size, nodes.length);
	assert.ok(analytics.communities.length >= 1);
}

testChunkingKeepsLongNotes();
testBacklinkRankingAndManagedSection();
testHubAndBridgeMetrics();
console.log('graph feature tests passed');
