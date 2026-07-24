import { GraphData, OntologyNode } from '../types';

export interface GraphNodeMetrics {
	node: OntologyNode;
	degree: number;
	inDegree: number;
	outDegree: number;
	externalDegree: number;
	bridgeScore: number;
	community: number;
}

export interface GraphCommunity {
	id: number;
	nodeIds: string[];
	edgeCount: number;
	topNodes: GraphNodeMetrics[];
}

export interface GraphAnalytics {
	metricsByNodeId: Map<string, GraphNodeMetrics>;
	rankedNodes: GraphNodeMetrics[];
	communities: GraphCommunity[];
}

interface MutableMetrics {
	degree: number;
	inDegree: number;
	outDegree: number;
}

/**
 * Calculate graph hubs and deterministic, local communities without sending any
 * graph data to an external service. Communities use the first phase of the
 * Louvain modularity algorithm, which is a useful exploratory signal for a
 * personal graph while remaining fast enough to run inside Obsidian.
 */
export function analyzeGraph(graph: GraphData): GraphAnalytics {
	const nodesById = new Map(graph.nodes.map(node => [node.id, node]));
	const adjacency = new Map<string, Map<string, number>>();
	const mutableMetrics = new Map<string, MutableMetrics>();

	for (const node of graph.nodes) {
		adjacency.set(node.id, new Map());
		mutableMetrics.set(node.id, { degree: 0, inDegree: 0, outDegree: 0 });
	}

	for (const edge of graph.edges) {
		if (!nodesById.has(edge.source) || !nodesById.has(edge.target)) continue;

		const sourceMetrics = mutableMetrics.get(edge.source);
		const targetMetrics = mutableMetrics.get(edge.target);
		if (!sourceMetrics || !targetMetrics) continue;

		sourceMetrics.outDegree++;
		targetMetrics.inDegree++;
		sourceMetrics.degree++;
		targetMetrics.degree++;

		if (edge.source === edge.target) continue;
		incrementWeight(adjacency.get(edge.source), edge.target);
		incrementWeight(adjacency.get(edge.target), edge.source);
	}

	const communityLabels = detectCommunities(graph.nodes, adjacency, mutableMetrics);
	const labelGroups = new Map<string, string[]>();
	for (const node of graph.nodes) {
		const label = communityLabels.get(node.id) ?? node.id;
		const group = labelGroups.get(label) ?? [];
		group.push(node.id);
		labelGroups.set(label, group);
	}

	const orderedGroups = [...labelGroups.values()]
		.map(nodeIds => [...nodeIds].sort())
		.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
	const communityByNodeId = new Map<string, number>();
	orderedGroups.forEach((nodeIds, index) => {
		for (const nodeId of nodeIds) communityByNodeId.set(nodeId, index + 1);
	});

	const metricsByNodeId = new Map<string, GraphNodeMetrics>();
	for (const node of graph.nodes) {
		const base = mutableMetrics.get(node.id) ?? { degree: 0, inDegree: 0, outDegree: 0 };
		const community = communityByNodeId.get(node.id) ?? 0;
		let externalDegree = 0;

		for (const [neighborId, weight] of adjacency.get(node.id) ?? []) {
			if (communityByNodeId.get(neighborId) !== community) externalDegree += weight;
		}

		const bridgeScore = base.degree === 0
			? 0
			: (externalDegree / base.degree) * Math.log2(base.degree + 1);

		metricsByNodeId.set(node.id, {
			node,
			...base,
			externalDegree,
			bridgeScore,
			community,
		});
	}

	const rankedNodes = [...metricsByNodeId.values()].sort(compareNodeMetrics);
	const communities = orderedGroups.map((nodeIds, index) => {
		const id = index + 1;
		const nodeIdSet = new Set(nodeIds);
		const edgeCount = graph.edges.reduce((count, edge) =>
			count + (nodeIdSet.has(edge.source) && nodeIdSet.has(edge.target) ? 1 : 0), 0);
		const topNodes = nodeIds
			.map(nodeId => metricsByNodeId.get(nodeId))
			.filter((metric): metric is GraphNodeMetrics => metric !== undefined)
			.sort(compareNodeMetrics)
			.slice(0, 5);

		return { id, nodeIds, edgeCount, topNodes };
	});

	return { metricsByNodeId, rankedNodes, communities };
}

function incrementWeight(weights: Map<string, number> | undefined, key: string): void {
	if (!weights) return;
	weights.set(key, (weights.get(key) ?? 0) + 1);
}

function compareNodeMetrics(a: GraphNodeMetrics, b: GraphNodeMetrics): number {
	return b.degree - a.degree
		|| b.node.sourceNotes.length - a.node.sourceNotes.length
		|| a.node.properties.name.localeCompare(b.node.properties.name);
}

function detectCommunities(
	nodes: OntologyNode[],
	adjacency: Map<string, Map<string, number>>,
	metrics: Map<string, MutableMetrics>
): Map<string, string> {
	const communityByNodeId = new Map<string, string>();
	const totalDegreeByCommunity = new Map<string, number>();
	let totalDegree = 0;

	for (const node of nodes) {
		const degree = metrics.get(node.id)?.degree ?? 0;
		communityByNodeId.set(node.id, node.id);
		totalDegreeByCommunity.set(node.id, degree);
		totalDegree += degree;
	}

	if (totalDegree === 0) return communityByNodeId;

	const orderedNodeIds = nodes
		.map(node => node.id)
		.sort((a, b) => (metrics.get(b)?.degree ?? 0) - (metrics.get(a)?.degree ?? 0) || a.localeCompare(b));

	for (let iteration = 0; iteration < 25; iteration++) {
		let moved = false;

		for (const nodeId of orderedNodeIds) {
			const nodeDegree = metrics.get(nodeId)?.degree ?? 0;
			if (nodeDegree === 0) continue;

			const currentCommunity = communityByNodeId.get(nodeId) ?? nodeId;
			totalDegreeByCommunity.set(
				currentCommunity,
				(totalDegreeByCommunity.get(currentCommunity) ?? 0) - nodeDegree
			);

			const weightByCommunity = new Map<string, number>();
			for (const [neighborId, weight] of adjacency.get(nodeId) ?? []) {
				const neighborCommunity = communityByNodeId.get(neighborId) ?? neighborId;
				weightByCommunity.set(
					neighborCommunity,
					(weightByCommunity.get(neighborCommunity) ?? 0) + weight
				);
			}

			let bestCommunity = currentCommunity;
			let bestGain = 0;
			for (const [candidateCommunity, internalWeight] of weightByCommunity) {
				const gain = internalWeight
					- ((totalDegreeByCommunity.get(candidateCommunity) ?? 0) * nodeDegree / totalDegree);
				if (gain > bestGain + Number.EPSILON
					|| (Math.abs(gain - bestGain) <= Number.EPSILON && candidateCommunity < bestCommunity)) {
					bestGain = gain;
					bestCommunity = candidateCommunity;
				}
			}

			communityByNodeId.set(nodeId, bestCommunity);
			totalDegreeByCommunity.set(
				bestCommunity,
				(totalDegreeByCommunity.get(bestCommunity) ?? 0) + nodeDegree
			);
			if (bestCommunity !== currentCommunity) moved = true;
		}

		if (!moved) break;
	}

	return communityByNodeId;
}

export function getCommunityColor(community: number): string {
	const palette = [
		'#5b8ff9',
		'#61ddaa',
		'#9661bc',
		'#f6bd16',
		'#65789b',
		'#f6903d',
		'#6dc8ec',
		'#e86452',
		'#7262fd',
		'#78d3f8',
		'#945fb9',
		'#ff99c3',
	];
	return palette[Math.max(0, community - 1) % palette.length];
}
