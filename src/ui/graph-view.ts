import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { getEntityTypeColor } from '../types';
import { analyzeGraph, getCommunityColor, GraphAnalytics, GraphNodeMetrics } from '../graph/analytics';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds
const LARGE_GRAPH_THRESHOLD = 500; // nodes + edges
const MAX_RENDER_ELEMENTS = 2000; // maximum elements to render

// ============================================
// Graph Styles
// ============================================

const GRAPH_STYLES: cytoscape.StylesheetStyle[] = [
	// Base node style
	{
		selector: 'node',
		style: {
			'label': 'data(name)',
			'text-valign': 'bottom',
			'text-halign': 'center',
			'text-margin-y': 5,
			'font-size': '10px',
			'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
			'color': '#a8a8a8',
			'text-wrap': 'ellipsis',
			'text-max-width': '80px',
			'width': 'mapData(degree, 0, 20, 10, 34)',
			'height': 'mapData(degree, 0, 20, 10, 34)',
			'border-width': 0,
			'background-opacity': 0.9,
			'background-color': 'data(color)',
		},
	},
	// Base edge style (unified for free-form relationships)
	{
		selector: 'edge',
		style: {
			'width': 1,
			'line-color': '#cbd5e1',
			'curve-style': 'bezier',
			'opacity': 0.4,
			'line-style': 'solid',
			'target-arrow-shape': 'triangle',
			'target-arrow-color': '#cbd5e1',
			'arrow-scale': 0.5,
		},
	},
	// Highlighted state (selected node and neighbors)
	{
		selector: '.highlighted',
		style: {
			'opacity': 1,
		},
	},
	{
		selector: 'node.highlighted',
		style: {
			'border-width': 2,
			'border-color': '#ffffff',
			'width': 16,
			'height': 16,
		},
	},
	{
		selector: 'edge.highlighted',
		style: {
			'width': 2,
			'opacity': 1,
		},
	},
	// Faded state (non-selected elements)
	{
		selector: '.faded',
		style: {
			'opacity': 0.15,
		},
	},
	// Hover state
	{
		selector: 'node.hover',
		style: {
			'width': 16,
			'height': 16,
			'z-index': 999,
		},
	},
];

// ============================================
// Graph View
// ============================================

export class GraphView extends ItemView {
	plugin: SimpleGraphBuilderPlugin;
	cy: cytoscape.Core | null = null;
	private graphContainer: HTMLElement | null = null;
	private tooltipEl: HTMLElement | null = null;
	private insightsEl: HTMLElement | null = null;
	private insightsVisible = false;
	private analytics: GraphAnalytics | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: SimpleGraphBuilderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return GRAPH_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Knowledge graph';
	}

	getIcon(): string {
		return 'git-fork';
	}

	async onOpen() {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('simple-graph-container');
		container.addClass('sgb-graph-container-relative');

		this.createGraphControls(container);

		this.insightsEl = container.createDiv({ cls: 'sgb-graph-insights' });
		this.insightsEl.toggleClass('is-visible', this.insightsVisible);

		// Graph canvas fills the remaining height.
		this.graphContainer = container.createDiv({ cls: 'cytoscape-container' });

		// Create tooltip element (positioned absolutely, won't affect layout)
		// Styles defined in styles.css via .graph-tooltip class
		this.tooltipEl = container.createDiv({ cls: 'graph-tooltip' });

		await this.renderGraph();
	}

	private createGraphControls(container: HTMLElement): void {
		const controls = container.createDiv({ cls: 'sgb-graph-controls' });

		const topControl = controls.createEl('label');
		topControl.createSpan({ text: 'Show hubs' });
		const topSelect = topControl.createEl('select');
		for (const [value, label] of [['0', 'All'], ['25', 'Top 25'], ['50', 'Top 50'], ['100', 'Top 100'], ['200', 'Top 200']]) {
			topSelect.createEl('option', { value, text: label });
		}
		topSelect.value = String(this.plugin.settings.graphTopNodeLimit);
		topSelect.addEventListener('change', () => {
			this.plugin.settings.graphTopNodeLimit = Number(topSelect.value);
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const degreeControl = controls.createEl('label');
		degreeControl.createSpan({ text: 'Min. edges' });
		const degreeInput = degreeControl.createEl('input');
		degreeInput.type = 'number';
		degreeInput.min = '0';
		degreeInput.max = '100';
		degreeInput.value = String(this.plugin.settings.graphMinDegree);
		degreeInput.addEventListener('change', () => {
			const value = Number.parseInt(degreeInput.value, 10);
			this.plugin.settings.graphMinDegree = Number.isFinite(value) ? Math.max(0, value) : 0;
			degreeInput.value = String(this.plugin.settings.graphMinDegree);
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const colorControl = controls.createEl('label');
		colorControl.createSpan({ text: 'Color' });
		const colorSelect = colorControl.createEl('select');
		colorSelect.createEl('option', { value: 'entityType', text: 'Entity type' });
		colorSelect.createEl('option', { value: 'community', text: 'Community' });
		colorSelect.value = this.plugin.settings.graphColorMode;
		colorSelect.addEventListener('change', () => {
			this.plugin.settings.graphColorMode = colorSelect.value === 'community' ? 'community' : 'entityType';
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const insightsButton = controls.createEl('button', { text: 'Insights' });
		insightsButton.addEventListener('click', () => {
			this.insightsVisible = !this.insightsVisible;
			this.insightsEl?.toggleClass('is-visible', this.insightsVisible);
			insightsButton.toggleClass('is-active', this.insightsVisible);
		});
	}

	/**
	 * Refresh the graph view with latest data.
	 */
	async refresh(): Promise<void> {
		if (this.graphContainer) {
			await this.renderGraph();
		}
	}

	async renderGraph(): Promise<void> {
		if (!this.graphContainer) return;

		// Destroy existing graph if any
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}

		this.graphContainer.empty();

		const graph = this.plugin.graphCache.getGraphData();

		// Show empty state if no data
		if (graph.nodes.length === 0) {
			this.graphContainer.createEl('div', {
				cls: 'graph-empty-state',
				text: 'No graph data yet. Analyze some notes to build your knowledge graph.',
			});
			return;
		}

		const totalElements = graph.nodes.length + graph.edges.length;
		const isLargeGraph = totalElements > LARGE_GRAPH_THRESHOLD;

		// Show loading indicator for large graphs
		if (isLargeGraph) {
			const loadingEl = this.graphContainer.createEl('div', {
				cls: 'graph-loading',
				text: `Loading graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)...`,
			});

			// Allow UI to update before heavy computation
			await new Promise(resolve => activeWindow.setTimeout(resolve, 50));
			loadingEl.remove();
		}

		this.analytics = analyzeGraph(graph);
		this.renderInsights(this.analytics);
		const connectionCount = new Map(
			[...this.analytics.metricsByNodeId].map(([nodeId, metric]) => [nodeId, metric.degree])
		);

		let nodesToRender = [...graph.nodes];

		// Apply minimum degree filter from settings
		const minDegree = this.plugin.settings.graphMinDegree;
		if (minDegree > 0) {
			nodesToRender = nodesToRender.filter(node =>
				(connectionCount.get(node.id) || 0) >= minDegree
			);
		}

		// Explicitly show only the strongest hubs when requested.
		const topNodeLimit = this.plugin.settings.graphTopNodeLimit;
		if (topNodeLimit > 0 && nodesToRender.length > topNodeLimit) {
			nodesToRender.sort((a, b) =>
				(connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0)
				|| a.properties.name.localeCompare(b.properties.name)
			);
			nodesToRender = nodesToRender.slice(0, topNodeLimit);
		}

		// Retain a defensive rendering ceiling even if the user selects "All".
		if (totalElements > MAX_RENDER_ELEMENTS && nodesToRender.length > MAX_RENDER_ELEMENTS / 2) {
			nodesToRender.sort((a, b) =>
				(connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0)
			);
			nodesToRender = nodesToRender.slice(0, MAX_RENDER_ELEMENTS / 2);
			new Notice(`Large graph: showing ${nodesToRender.length} most connected nodes`);
		}

		const filteredNodeIds = new Set(nodesToRender.map(node => node.id));
		const edgesToRender = graph.edges.filter(
			edge => filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
		);

		if (nodesToRender.length === 0) {
			this.graphContainer.createEl('div', {
				cls: 'graph-empty-state',
				text: 'No nodes match the current hub filters.',
			});
			return;
		}

		const elements: cytoscape.ElementDefinition[] = [];

		// Add nodes with size proportional to degree and the selected color lens.
		for (const node of nodesToRender) {
			const metric = this.analytics.metricsByNodeId.get(node.id);
			const community = metric?.community ?? 0;
			elements.push({
				data: {
					id: node.id,
					name: node.properties.name,
					entityType: node.entityType,
					label: node.label || node.entityType, // fallback for legacy
					color: this.plugin.settings.graphColorMode === 'community'
						? getCommunityColor(community)
						: getEntityTypeColor(node.entityType || node.label),
					sourceNotes: node.sourceNotes,
					degree: metric?.degree ?? 0,
					community,
				},
			});
		}

		// Add edges with unified styling (free-form relationships)
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						relationship: edge.relationship || edge.type || 'relates to',
						detail: edge.properties?.detail,
					},
				});
			}
		}

		// Choose layout based on graph size
		const layoutConfig = this.getLayoutConfig(elements.length, isLargeGraph);

		this.cy = cytoscape({
			container: this.graphContainer,
			elements: elements,
			style: GRAPH_STYLES,
			layout: layoutConfig,
			minZoom: 0.1,
			maxZoom: 3,
			// Performance optimizations
			textureOnViewport: isLargeGraph,
			hideEdgesOnViewport: isLargeGraph,
			hideLabelsOnViewport: isLargeGraph,
		});

		// Click handler: highlight connected nodes
		this.cy.on('tap', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target;
			this.highlightConnected(node);
		});

		// Double-click on node to search
		this.cy.on('dbltap', 'node', (evt: cytoscape.EventObject) => {
			const name = evt.target.data('name');
			if (name) {
				openSearchModal(this.plugin, name);
			}
		});

		// Click on background to reset highlights
		this.cy.on('tap', (evt: cytoscape.EventObject) => {
			if (evt.target === this.cy) {
				this.resetHighlights();
				this.hideTooltip();
			}
		});

		// Hover effects for nodes
		this.cy.on('mouseover', 'node', (evt: cytoscape.EventObject) => {
			const node = evt.target;
			node.addClass('hover');
			this.showNodeTooltip(node, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'node', (evt: cytoscape.EventObject) => {
			evt.target.removeClass('hover');
			this.hideTooltip();
		});

		// Hover effects for edges - show relationship type and detail
		this.cy.on('mouseover', 'edge', (evt: cytoscape.EventObject) => {
			const edge = evt.target;
			this.showEdgeTooltip(edge, evt.renderedPosition);
		});

		this.cy.on('mouseout', 'edge', () => {
			this.hideTooltip();
		});
	}

	private renderInsights(analytics: GraphAnalytics): void {
		if (!this.insightsEl) return;
		this.insightsEl.empty();

		const connectedCommunities = analytics.communities.filter(community => community.nodeIds.length > 1);
		const header = this.insightsEl.createDiv({ cls: 'sgb-insights-header' });
		header.createEl('strong', { text: 'Graph insights' });
		header.createSpan({
			text: `${analytics.rankedNodes.length} entities · ${connectedCommunities.length} connected communities`,
		});

		const columns = this.insightsEl.createDiv({ cls: 'sgb-insights-columns' });
		this.renderMetricList(
			columns,
			'Top hubs',
			analytics.rankedNodes.filter(metric => metric.degree > 0).slice(0, 10),
			metric => `${metric.degree} edges · ${metric.node.sourceNotes.length} notes`
		);

		const bridges = [...analytics.rankedNodes]
			.filter(metric => metric.externalDegree > 0)
			.sort((a, b) => b.bridgeScore - a.bridgeScore || b.degree - a.degree)
			.slice(0, 10);
		this.renderMetricList(
			columns,
			'Bridge concepts',
			bridges,
			metric => `${metric.externalDegree} cross-community edges`
		);

		const communityColumn = columns.createDiv({ cls: 'sgb-insights-column' });
		communityColumn.createEl('h4', { text: 'Communities' });
		for (const community of connectedCommunities.slice(0, 10)) {
			const item = communityColumn.createDiv({ cls: 'sgb-community-item' });
			const color = item.createSpan({ cls: 'sgb-community-color' });
			color.style.backgroundColor = getCommunityColor(community.id);
			item.createEl('strong', { text: `Community ${community.id}` });
			item.createSpan({ text: `${community.nodeIds.length} entities · ${community.edgeCount} internal edges` });
			item.createDiv({
				cls: 'sgb-community-names',
				text: community.topNodes.map(metric => metric.node.properties.name).join(', '),
			});
		}

		this.insightsEl.createDiv({
			cls: 'sgb-insights-disclaimer',
			text: 'Communities and bridge scores are exploratory graph structure, not psychological or clinical conclusions. Open the source notes before interpreting a pattern.',
		});
	}

	private renderMetricList(
		container: HTMLElement,
		title: string,
		metrics: GraphNodeMetrics[],
		detail: (metric: GraphNodeMetrics) => string
	): void {
		const column = container.createDiv({ cls: 'sgb-insights-column' });
		column.createEl('h4', { text: title });
		for (const metric of metrics) {
			const item = column.createDiv({ cls: 'sgb-insight-metric' });
			const button = item.createEl('button', { text: metric.node.properties.name });
			button.addEventListener('click', () => this.focusNode(metric.node.id));
			item.createSpan({ text: detail(metric) });
		}
	}

	private focusNode(nodeId: string): void {
		if (!this.cy) return;
		const node = this.cy.getElementById(nodeId);
		if (node.empty()) {
			new Notice('That entity is hidden by the current hub filters.');
			return;
		}
		this.highlightConnected(node);
		this.cy.animate({ center: { eles: node }, zoom: Math.max(this.cy.zoom(), 1.2) }, { duration: 250 });
	}

	private showNodeTooltip(node: cytoscape.NodeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const name = node.data('name');
		const entityType = node.data('entityType') || node.data('label');
		const sourceNotes = node.data('sourceNotes') || [];
		const degree = node.data('degree') || 0;
		const community = node.data('community') || 0;

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-label', text: entityType });
		this.tooltipEl.createDiv({ cls: 'tooltip-name', text: name });
		this.tooltipEl.createDiv({ cls: 'tooltip-sources', text: `${degree} edges · community ${community}` });
		if (sourceNotes.length > 0) {
			this.tooltipEl.createDiv({ cls: 'tooltip-sources', text: `Found in ${sourceNotes.length} note${sourceNotes.length > 1 ? 's' : ''}` });
		}

		this.positionTooltip(position);
		this.tooltipEl.addClass('visible');
	}

	private showEdgeTooltip(edge: cytoscape.EdgeSingular, position: { x: number; y: number }): void {
		if (!this.tooltipEl) return;

		const relationship = edge.data('relationship');
		const detail = edge.data('detail');

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-type', text: relationship });
		if (detail) {
			this.tooltipEl.createDiv({ cls: 'tooltip-detail', text: detail });
		}

		this.positionTooltip(position);
		this.tooltipEl.addClass('visible');
	}

	private positionTooltip(position: { x: number; y: number }): void {
		if (!this.tooltipEl || !this.graphContainer) return;
		this.tooltipEl.style.left = `${position.x + this.graphContainer.offsetLeft + 15}px`;
		this.tooltipEl.style.top = `${position.y + this.graphContainer.offsetTop + 15}px`;
	}

	private hideTooltip(): void {
		if (this.tooltipEl) {
			this.tooltipEl.removeClass('visible');
		}
	}

	/**
	 * Get layout configuration based on graph size.
	 */
	private getLayoutConfig(elementCount: number, isLarge: boolean): cytoscape.LayoutOptions {
		// Base config shared across all sizes
		const baseConfig = {
			name: 'fcose',
			animate: false,
			randomize: true,
			edgeElasticity: () => 0.45,
			nestingFactor: 0.1,
			numIter: 2500,
			tile: true,
		};

		// Large graph (1000+ elements or flagged as large)
		if (isLarge || elementCount > 1000) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: false,
				nodeRepulsion: () => 20000,
				idealEdgeLength: () => 120,
				gravity: 0.1,
				tilingPaddingVertical: 30,
				tilingPaddingHorizontal: 30,
			} as cytoscape.LayoutOptions;
		}

		// Medium graph (300-1000 elements)
		if (elementCount > 300) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 25000,
				idealEdgeLength: () => 150,
				gravity: 0.15,
				tilingPaddingVertical: 40,
				tilingPaddingHorizontal: 40,
			} as cytoscape.LayoutOptions;
		}

		// Small graph (<300 elements)
		return {
			...baseConfig,
			quality: 'proof',
			nodeDimensionsIncludeLabels: true,
			nodeRepulsion: () => 30000,
			idealEdgeLength: () => 200,
			gravity: 0.1,
			tilingPaddingVertical: 50,
			tilingPaddingHorizontal: 50,
		} as cytoscape.LayoutOptions;
	}

	private highlightConnected(node: cytoscape.NodeSingular): void {
		if (!this.cy) return;

		this.cy.elements().removeClass('highlighted faded');

		const neighborhood = node.neighborhood().add(node);
		const others = this.cy.elements().difference(neighborhood);

		neighborhood.addClass('highlighted');
		others.addClass('faded');
	}

	private resetHighlights(): void {
		if (!this.cy) return;
		this.cy.elements().removeClass('highlighted faded');
	}

	async onClose(): Promise<void> {
		if (this.cy) {
			this.cy.destroy();
			this.cy = null;
		}
	}
}
