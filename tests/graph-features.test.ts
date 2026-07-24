import assert from 'node:assert/strict';
import { analyzeGraph } from '../src/graph/analytics';
import {
	buildBacklinkSuggestions,
	stripManagedRelatedNotes,
	upsertManagedRelatedNotes,
} from '../src/graph/backlinks';
import {
	filterGraphBySourceFolder,
	filterGraphByNodePredicate,
	getGraphSourceFolders,
	notePathMatchesFolder,
} from '../src/graph/scope';
import {
	applyEntityPseudonyms,
	canMergeEntityNames,
	filterJournalMetadataExtraction,
	isLikelyJournalMetadataName,
} from '../src/graph/quality';
import {
	aggregateGraphEdges,
	retainConnectedNodes,
	retainLargestConnectedComponent,
	toTitleCaseLabel,
} from '../src/graph/presentation';
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

function edge(source: string, target: string, index: number, sourceNote?: string): OntologyEdge {
	return {
		id: `edge-${index}`,
		source,
		target,
		relationship: 'relates to',
		properties: {},
		sourceNote,
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

function testCachedFolderScopeFiltersGraphAndBacklinks(): void {
	const graph: GraphData = {
		version: 3,
		nodes: [
			node('n1', 'Recurring feeling', [
				'__main__/Journaling/2025-01-01.md',
				'__main__/Journaling/2025-01-02.md',
				'__main__/Work-Related/Plan.md',
			]),
			node('n2', 'Important decision', [
				'__main__/Journaling/2025-01-01.md',
				'__main__/Journaling/2025-01-02.md',
				'__main__/Work-Related/Plan.md',
			]),
			node('n3', 'Work-only topic', ['__main__/Work-Related/Plan.md']),
		],
		edges: [
			edge('n1', 'n2', 1, '__main__/Journaling/2025-01-01.md'),
			edge('n1', 'n2', 2, '__main__/Work-Related/Plan.md'),
			edge('n2', 'n3', 3, '__main__/Work-Related/Plan.md'),
		],
	};

	assert.equal(notePathMatchesFolder(
		'__main__/Journaling/2025-01-01.md',
		'__main__/Journaling/'
	), true);
	assert.equal(notePathMatchesFolder(
		'__main__/Journaling-old/2025-01-01.md',
		'__main__/Journaling'
	), false);

	const folders = getGraphSourceFolders(graph);
	assert.ok(folders.includes('__main__'));
	assert.ok(folders.includes('__main__/Journaling'));
	assert.ok(folders.includes('__main__/Work-Related'));

	const scoped = filterGraphBySourceFolder(graph, '__main__/Journaling');
	assert.deepEqual(scoped.nodes.map(item => item.id), ['n1', 'n2']);
	assert.ok(scoped.nodes.every(item =>
		item.sourceNotes.every(path => path.startsWith('__main__/Journaling/'))
	));
	assert.deepEqual(scoped.edges.map(item => item.id), ['edge-1']);

	const suggestions = buildBacklinkSuggestions(scoped, {
		minSharedEntities: 2,
		maxLinksPerNote: 3,
		maxEntityDocumentFrequency: 1,
		limit: 20,
	});
	assert.equal(suggestions.length, 1);
	assert.equal(suggestions[0].sourcePath, '__main__/Journaling/2025-01-01.md');
	assert.equal(suggestions[0].targetPath, '__main__/Journaling/2025-01-02.md');
}

function testJournalMeaningQualityRules(): void {
	assert.equal(isLikelyJournalMetadataName('29 August 2025'), true);
	assert.equal(isLikelyJournalMetadataName('25-09-25'), true);
	assert.equal(isLikelyJournalMetadataName('14:48:39 CEST'), true);
	assert.equal(isLikelyJournalMetadataName('Weather: 21°C Cloudy'), true);
	assert.equal(isLikelyJournalMetadataName('Journal entry'), true);
	assert.equal(isLikelyJournalMetadataName('Date: 27 September 2025'), true);
	assert.equal(isLikelyJournalMetadataName('Journaling - notes'), true);
	assert.equal(isLikelyJournalMetadataName('gratitude'), false);
	assert.equal(isLikelyJournalMetadataName('family'), false);

	assert.equal(canMergeEntityNames({
		entityType: 'EVENT',
		properties: { name: '25 September 2025' },
	}, '29 August 2025'), false);
	assert.equal(canMergeEntityNames({
		entityType: 'CONCEPT',
		properties: { name: 'gratitude' },
	}, 'Gratitude'), true);

	const extraction = filterJournalMetadataExtraction({
		nodes: [
			{ id: 'date', entityType: 'EVENT', properties: { name: '29 August 2025' } },
			{ id: 'theme', entityType: 'CONCEPT', properties: { name: 'gratitude' } },
		],
		relationships: [
			{ source: 'date', target: 'theme', relationship: 'records', properties: {} },
		],
	});
	assert.deepEqual(extraction.nodes.map(item => item.id), ['theme']);
	assert.equal(extraction.relationships.length, 0);

	const graph: GraphData = {
		version: 3,
		nodes: [
			node('date', '29 August 2025', ['Journal/A.md']),
			node('theme', 'gratitude', ['Journal/A.md', 'Journal/B.md']),
		],
		edges: [edge('date', 'theme', 1, 'Journal/A.md')],
	};
	const meaningful = filterGraphByNodePredicate(
		graph,
		item => !isLikelyJournalMetadataName(item.properties.name)
	);
	assert.deepEqual(meaningful.nodes.map(item => item.id), ['theme']);
	assert.equal(meaningful.edges.length, 0);
}

function testPrivateNamesAndGraphPresentation(): void {
	const extraction = applyEntityPseudonyms({
		nodes: [
			{
				id: 'person',
				entityType: 'PERSON',
				properties: {
					name: 'Original Person',
					description: 'Original Person is referenced in this private note.',
				},
			},
			{
				id: 'theme',
				entityType: 'CONCEPT',
				properties: { name: 'being alive' },
			},
		],
		relationships: [{
			source: 'person',
			target: 'theme',
			relationship: 'reflects on',
			properties: { detail: 'Original Person discusses this theme.' },
		}],
	}, {
		'Original Person': 'Private Alias',
	});
	assert.equal(extraction.nodes[0].properties.name, 'Private Alias');
	assert.equal(
		extraction.nodes[0].properties.description,
		'Private Alias is referenced in this private note.'
	);
	assert.equal(
		extraction.relationships[0].properties.detail,
		'Private Alias discusses this theme.'
	);
	assert.equal(toTitleCaseLabel('being alive'), 'Being Alive');
	assert.equal(toTitleCaseLabel('zero-sum game'), 'Zero-Sum Game');

	const nodes = [
		node('a', 'alpha', ['Journal/A.md']),
		node('b', 'beta', ['Journal/B.md']),
		node('c', 'isolated', ['Journal/C.md']),
	];
	const aggregated = aggregateGraphEdges([
		edge('a', 'b', 1, 'Journal/A.md'),
		{ ...edge('b', 'a', 2, 'Journal/B.md'), relationship: 'supports' },
	]);
	assert.equal(aggregated.length, 1);
	assert.equal(aggregated[0].weight, 2);
	assert.equal(aggregated[0].sourceNoteCount, 2);
	assert.deepEqual(retainConnectedNodes(nodes, aggregated).map(item => item.id), ['a', 'b']);

	const clusteredNodes = [
		...nodes,
		node('d', 'delta', ['Journal/D.md']),
		node('e', 'epsilon', ['Journal/E.md']),
		node('f', 'zeta', ['Journal/F.md']),
	];
	const mainCluster = retainLargestConnectedComponent(clusteredNodes, [
		...aggregated,
		{ source: 'd', target: 'e' },
		{ source: 'e', target: 'f' },
	]);
	assert.deepEqual(mainCluster.map(item => item.id), ['d', 'e', 'f']);
}

testChunkingKeepsLongNotes();
testBacklinkRankingAndManagedSection();
testHubAndBridgeMetrics();
testCachedFolderScopeFiltersGraphAndBacklinks();
testJournalMeaningQualityRules();
testPrivateNamesAndGraphPresentation();
console.log('graph feature tests passed');
