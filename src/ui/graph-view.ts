import { ItemView, WorkspaceLeaf, Notice, Menu } from 'obsidian';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import SimpleGraphBuilderPlugin from '../main';
import { openSearchModal } from '../commands/search';
import { getEntityTypeColor } from '../types';
import { analyzeGraph, getCommunityColor, GraphAnalytics, GraphNodeMetrics } from '../graph/analytics';
import { filterGraphByNodePredicate, filterGraphBySourceFolder, getGraphSourceFolders } from '../graph/scope';
import { isLikelyJournalMetadataNode } from '../graph/quality';
import {
	aggregateGraphEdges,
	retainConnectedNodes,
	retainLargestConnectedComponent,
	toTitleCaseLabel,
} from '../graph/presentation';
import { EntityEditModal } from './entity-edit-modal';

// Register fCoSE layout extension
cytoscape.use(fcose);

export const GRAPH_VIEW_TYPE = 'simple-graph-view';

// Performance thresholds
const LARGE_GRAPH_THRESHOLD = 500; // nodes + edges
const MAX_RENDER_ELEMENTS = 2000; // maximum elements to render

// ============================================
// Graph Styles
// ============================================

function getGraphStyles(container: HTMLElement): cytoscape.StylesheetStyle[] {
	const computedStyle = activeWindow.getComputedStyle(container);
	const themeColor = (variable: string, fallback: string): string =>
		computedStyle.getPropertyValue(variable).trim() || fallback;
	const textColor = themeColor('--text-normal', '#e5e7eb');
	const backgroundColor = themeColor('--background-primary', '#1e2228');
	const edgeColor = themeColor('--text-muted', '#94a3b8');

	return [
		{
			selector: 'node',
			style: {
				'label': 'data(displayName)',
				'text-valign': 'bottom',
				'text-halign': 'center',
				'text-margin-y': 7,
				'font-size': '12.5px',
				'font-weight': 600,
				'font-family': '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
				'color': textColor,
				'text-wrap': 'wrap',
				'text-max-width': '132px',
				'text-outline-color': backgroundColor,
				'text-outline-width': 3,
				'text-outline-opacity': 0.94,
				'width': 'mapData(importance, 0, 20, 22, 58)',
				'height': 'mapData(importance, 0, 20, 22, 58)',
				'border-width': 2.5,
				'border-color': textColor,
				'border-opacity': 0.34,
				'background-opacity': 0.96,
				'background-color': 'data(color)',
			},
		},
		{
			selector: 'edge',
			style: {
				'width': 'mapData(weight, 1, 10, 1.2, 5.5)',
				'line-color': edgeColor,
				'curve-style': 'straight',
				'opacity': 0.38,
				'line-style': 'solid',
				'target-arrow-shape': 'none',
				'source-arrow-shape': 'none',
				'line-cap': 'round',
			},
		},
		{
			selector: 'node[importance >= 8]',
			style: {
				'underlay-color': 'data(color)',
				'underlay-opacity': 0.14,
				'underlay-padding': 7,
			},
		},
		{
			selector: '.highlighted',
			style: {
				'opacity': 1,
			},
		},
		{
			selector: 'node.highlighted',
			style: {
				'border-width': 4,
				'border-color': textColor,
				'border-opacity': 0.95,
			},
		},
		{
			selector: 'edge.highlighted',
			style: {
				'width': 'mapData(weight, 1, 10, 2.5, 7)',
				'opacity': 0.95,
			},
		},
		{
			selector: '.faded',
			style: {
				'opacity': 0.08,
			},
		},
		{
			selector: 'node.hover',
			style: {
				'border-width': 4,
				'border-opacity': 1,
				'z-index': 999,
			},
		},
	];
}

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
	private restoreHiddenButton: HTMLButtonElement | null = null;

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

		const sourceControl = controls.createEl('label');
		sourceControl.createSpan({ text: 'Source notes' });
		const sourceSelect = sourceControl.createEl('select');
		sourceSelect.createEl('option', { value: '', text: 'All analyzed notes' });
		const graph = this.plugin.graphCache.getGraphData();
		const sourceFolders = getGraphSourceFolders(graph);
		for (const folder of sourceFolders) {
			sourceSelect.createEl('option', { value: folder, text: folder });
		}
		const savedSourceFolder = this.plugin.settings.graphSourceFolder;
		if (savedSourceFolder && !sourceFolders.includes(savedSourceFolder)) {
			sourceSelect.createEl('option', { value: savedSourceFolder, text: savedSourceFolder });
		}
		sourceSelect.value = savedSourceFolder;
		sourceSelect.title = 'Filter the cached graph by the folder containing its source notes. This does not rerun analysis.';
		sourceSelect.addEventListener('change', () => {
			this.plugin.settings.graphSourceFolder = sourceSelect.value;
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const rankControl = controls.createEl('label');
		rankControl.createSpan({ text: 'Rank' });
		const rankSelect = rankControl.createEl('select');
		rankSelect.createEl('option', { value: 'recurrence', text: 'Across notes' });
		rankSelect.createEl('option', { value: 'degree', text: 'By edges' });
		rankSelect.value = this.plugin.settings.graphRankMode;
		rankSelect.title = 'Across notes prioritizes themes repeated in distinct journal entries.';
		rankSelect.addEventListener('change', () => {
			this.plugin.settings.graphRankMode = rankSelect.value === 'degree'
				? 'degree'
				: 'recurrence';
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const notesControl = controls.createEl('label');
		notesControl.createSpan({ text: 'Min. notes' });
		const notesInput = notesControl.createEl('input');
		notesInput.type = 'number';
		notesInput.min = '1';
		notesInput.max = '100';
		notesInput.value = String(this.plugin.settings.graphMinSourceNotes);
		notesInput.title = 'Require an entity to occur in this many distinct notes.';
		notesInput.addEventListener('change', () => {
			const value = Number.parseInt(notesInput.value, 10);
			this.plugin.settings.graphMinSourceNotes = Number.isFinite(value)
				? Math.max(1, value)
				: 1;
			notesInput.value = String(this.plugin.settings.graphMinSourceNotes);
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const metadataControl = controls.createEl('label', { cls: 'sgb-checkbox-control' });
		const metadataCheckbox = metadataControl.createEl('input');
		metadataCheckbox.type = 'checkbox';
		metadataCheckbox.checked = this.plugin.settings.graphHideJournalMetadata;
		metadataControl.createSpan({ text: 'Hide journal metadata' });
		metadataCheckbox.title = 'Hide dates, times, weather, narrator pronouns, and generic journal scaffolding.';
		metadataCheckbox.addEventListener('change', () => {
			this.plugin.settings.graphHideJournalMetadata = metadataCheckbox.checked;
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const connectedControl = controls.createEl('label', { cls: 'sgb-checkbox-control' });
		const connectedCheckbox = connectedControl.createEl('input');
		connectedCheckbox.type = 'checkbox';
		connectedCheckbox.checked = this.plugin.settings.graphConnectedOnly;
		connectedControl.createSpan({ text: 'Connected only' });
		connectedCheckbox.title = 'Hide isolated entities left behind by the current hub filters.';
		connectedCheckbox.addEventListener('change', () => {
			this.plugin.settings.graphConnectedOnly = connectedCheckbox.checked;
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

		const mainClusterControl = controls.createEl('label', { cls: 'sgb-checkbox-control' });
		const mainClusterCheckbox = mainClusterControl.createEl('input');
		mainClusterCheckbox.type = 'checkbox';
		mainClusterCheckbox.checked = this.plugin.settings.graphMainClusterOnly;
		mainClusterControl.createSpan({ text: 'Main cluster' });
		mainClusterCheckbox.title = 'Center the largest connected meaning cluster and temporarily hide smaller components.';
		mainClusterCheckbox.addEventListener('change', () => {
			this.plugin.settings.graphMainClusterOnly = mainClusterCheckbox.checked;
			void this.plugin.saveSettings();
			void this.renderGraph();
		});

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

		this.restoreHiddenButton = controls.createEl('button');
		this.updateRestoreHiddenButton();
		this.restoreHiddenButton.addEventListener('click', () => {
			if (this.plugin.settings.graphHiddenNodeIds.length === 0) return;
			this.plugin.settings.graphHiddenNodeIds = [];
			void this.plugin.saveSettings();
			this.updateRestoreHiddenButton();
			void this.renderGraph();
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

		const fullGraph = this.plugin.graphCache.getGraphData();
		const sourceFolder = this.plugin.settings.graphSourceFolder;
		const sourceScopedGraph = filterGraphBySourceFolder(fullGraph, sourceFolder);
		let graph = sourceScopedGraph;
		const hiddenNodeIds = new Set(this.plugin.settings.graphHiddenNodeIds);
		const minimumSourceNotes = this.plugin.settings.graphMinSourceNotes;
		graph = filterGraphByNodePredicate(graph, node => {
			if (hiddenNodeIds.has(node.id)) return false;
			if (node.properties.excludeFromMeaningView === true) return false;
			if (this.plugin.settings.graphHideJournalMetadata && isLikelyJournalMetadataNode(node)) {
				return false;
			}
			return this.getSourceNoteCount(node.sourceNotes) >= minimumSourceNotes;
		});

		// Show empty state if no data
		if (graph.nodes.length === 0) {
			this.graphContainer.createEl('div', {
				cls: 'graph-empty-state',
				text: sourceScopedGraph.nodes.length > 0
					? 'No entities match the current meaning filters. Lower Min. notes or restore hidden entities.'
					: sourceFolder
						? `No cached graph data was found under ${sourceFolder}.`
						: 'No graph data yet. Analyze some notes to build your knowledge graph.',
			});
			return;
		}

		const totalElements = graph.nodes.length + graph.edges.length;
		const sourceGraphIsLarge = totalElements > LARGE_GRAPH_THRESHOLD;

		// Show loading indicator for large graphs
		if (sourceGraphIsLarge) {
			const loadingEl = this.graphContainer.createEl('div', {
				cls: 'graph-loading',
				text: `Loading graph (${graph.nodes.length} nodes, ${graph.edges.length} edges)...`,
			});

			// Allow UI to update before heavy computation
			await new Promise(resolve => activeWindow.setTimeout(resolve, 50));
			loadingEl.remove();
		}

		this.analytics = analyzeGraph(graph);
		this.renderInsights(this.analytics, sourceFolder);
		const connectionCount = new Map(
			[...this.analytics.metricsByNodeId].map(([nodeId, metric]) => [nodeId, metric.degree])
		);
		const rankValue = (nodeId: string, sourceNotes: string[]): number =>
			this.plugin.settings.graphRankMode === 'recurrence'
				? this.getSourceNoteCount(sourceNotes)
				: (connectionCount.get(nodeId) || 0);

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
				rankValue(b.id, b.sourceNotes) - rankValue(a.id, a.sourceNotes)
				|| (connectionCount.get(b.id) || 0) - (connectionCount.get(a.id) || 0)
				|| a.properties.name.localeCompare(b.properties.name)
			);
			nodesToRender = nodesToRender.slice(0, topNodeLimit);
		}

		// Retain a defensive rendering ceiling even if the user selects "All".
		if (totalElements > MAX_RENDER_ELEMENTS && nodesToRender.length > MAX_RENDER_ELEMENTS / 2) {
			nodesToRender.sort((a, b) =>
				rankValue(b.id, b.sourceNotes) - rankValue(a.id, a.sourceNotes)
			);
			nodesToRender = nodesToRender.slice(0, MAX_RENDER_ELEMENTS / 2);
			new Notice(`Large graph: showing ${nodesToRender.length} highest-ranked nodes`);
		}

		const filteredNodeIds = new Set(nodesToRender.map(node => node.id));
		const matchingEdges = graph.edges.filter(
			edge => filteredNodeIds.has(edge.source) && filteredNodeIds.has(edge.target)
		);
		const edgesToRender = aggregateGraphEdges(matchingEdges);

		if (this.plugin.settings.graphConnectedOnly) {
			nodesToRender = retainConnectedNodes(nodesToRender, edgesToRender);
		}
		if (this.plugin.settings.graphMainClusterOnly) {
			nodesToRender = retainLargestConnectedComponent(nodesToRender, edgesToRender);
		}

		if (nodesToRender.length === 0) {
			this.graphContainer.createEl('div', {
				cls: 'graph-empty-state',
				text: this.plugin.settings.graphMainClusterOnly
					? 'No main meaning cluster matches the current filters. Turn off Main cluster or lower the thresholds.'
					: this.plugin.settings.graphConnectedOnly
					? 'No connected entities match the current filters. Turn off Connected only or lower the thresholds.'
					: 'No nodes match the current hub filters.',
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
					displayName: toTitleCaseLabel(node.properties.name),
					entityType: node.entityType,
					label: node.label || node.entityType, // fallback for legacy
					color: this.plugin.settings.graphColorMode === 'community'
						? getCommunityColor(community)
						: getEntityTypeColor(node.entityType || node.label),
					sourceNotes: node.sourceNotes,
					description: typeof node.properties.description === 'string'
						? node.properties.description
						: '',
					degree: metric?.degree ?? 0,
					noteCount: this.getSourceNoteCount(node.sourceNotes),
					importance: rankValue(node.id, node.sourceNotes),
					community,
				},
			});
		}

		// Add one weighted visual edge per entity pair. Raw relationships stay in cache.
		const nodeIds = new Set(nodesToRender.map(n => n.id));
		for (const edge of edgesToRender) {
			if (nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
				elements.push({
					data: {
						id: edge.id,
						source: edge.source,
						target: edge.target,
						relationship: edge.relationship,
						detail: edge.detail,
						weight: edge.weight,
						sourceNoteCount: edge.sourceNoteCount,
					},
				});
			}
		}

		// Choose layout based on graph size
		const renderIsLarge = elements.length > LARGE_GRAPH_THRESHOLD;
		const layoutConfig = this.getLayoutConfig(elements.length, renderIsLarge);

		this.cy = cytoscape({
			container: this.graphContainer,
			elements: elements,
			style: getGraphStyles(this.graphContainer),
			layout: layoutConfig,
			minZoom: 0.1,
			maxZoom: 3,
			// Performance optimizations
			textureOnViewport: renderIsLarge,
			hideEdgesOnViewport: renderIsLarge,
			hideLabelsOnViewport: renderIsLarge,
		});
		this.cy.ready(() => {
			activeWindow.requestAnimationFrame(() => {
				if (!this.cy || this.cy.destroyed()) return;
				const shorterSide = Math.min(
					this.graphContainer?.clientWidth || 0,
					this.graphContainer?.clientHeight || 0
				);
				const padding = Math.max(56, Math.round(shorterSide * 0.08));
				this.cy.fit(this.cy.elements(), padding);
				this.cy.center(this.cy.elements());
			});
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

		// Right-click/long-press: correct or hide a misleading cached entity.
		this.cy.on('cxttap', 'node', (evt: cytoscape.EventObject) => {
			const nodeId = String(evt.target.data('id') || '');
			const node = this.plugin.graphCache.getNodeById(nodeId);
			if (!node) return;

			const menu = new Menu();
			menu.addItem(item => item
				.setTitle('Correct entity details')
				.setIcon('pencil')
				.onClick(() => {
					new EntityEditModal(this.plugin, node, () => {
						void this.renderGraph();
					}).open();
				}));
			menu.addItem(item => item
				.setTitle('Search source notes')
				.setIcon('search')
				.onClick(() => openSearchModal(this.plugin, node.properties.name)));
			menu.addItem(item => item
				.setTitle('Hide from meaning view')
				.setIcon('eye-off')
				.onClick(() => {
					const hiddenIds = new Set(this.plugin.settings.graphHiddenNodeIds);
					hiddenIds.add(node.id);
					this.plugin.settings.graphHiddenNodeIds = [...hiddenIds];
					void this.plugin.saveSettings();
					this.updateRestoreHiddenButton();
					void this.renderGraph();
				}));

			const originalEvent = evt.originalEvent;
			if (originalEvent instanceof MouseEvent) {
				menu.showAtMouseEvent(originalEvent);
			} else {
				menu.showAtPosition({
					x: evt.renderedPosition.x,
					y: evt.renderedPosition.y,
				});
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

	private getSourceNoteCount(sourceNotes: string[]): number {
		return new Set(sourceNotes).size;
	}

	private updateRestoreHiddenButton(): void {
		if (!this.restoreHiddenButton) return;
		const count = this.plugin.settings.graphHiddenNodeIds.length;
		this.restoreHiddenButton.setText(`Restore hidden (${count})`);
		this.restoreHiddenButton.disabled = count === 0;
		this.restoreHiddenButton.title = count === 0
			? 'No manually hidden entities'
			: 'Restore every entity manually hidden from the meaning view';
	}

	private renderInsights(analytics: GraphAnalytics, sourceFolder: string): void {
		if (!this.insightsEl) return;
		this.insightsEl.empty();

		const connectedCommunities = analytics.communities.filter(community => community.nodeIds.length > 1);
		const header = this.insightsEl.createDiv({ cls: 'sgb-insights-header' });
		header.createEl('strong', { text: 'Graph insights' });
		header.createSpan({
			text: `${analytics.rankedNodes.length} entities · ${connectedCommunities.length} connected communities`
				+ (sourceFolder ? ` · ${sourceFolder}` : ''),
		});

		const columns = this.insightsEl.createDiv({ cls: 'sgb-insights-columns' });
		const rankedHubs = [...analytics.rankedNodes]
			.filter(metric => metric.degree > 0)
			.sort((a, b) => {
				if (this.plugin.settings.graphRankMode === 'recurrence') {
					const noteDifference = this.getSourceNoteCount(b.node.sourceNotes)
						- this.getSourceNoteCount(a.node.sourceNotes);
					if (noteDifference !== 0) return noteDifference;
				}
				return b.degree - a.degree;
			})
			.slice(0, 10);
		this.renderMetricList(
			columns,
			this.plugin.settings.graphRankMode === 'recurrence' ? 'Recurring themes' : 'Top hubs',
			rankedHubs,
			metric => `${this.getSourceNoteCount(metric.node.sourceNotes)} notes · ${metric.degree} edges`
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
				text: community.topNodes
					.map(metric => toTitleCaseLabel(metric.node.properties.name))
					.join(', '),
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
			const button = item.createEl('button', {
				text: toTitleCaseLabel(metric.node.properties.name),
			});
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

		const name = node.data('displayName') || toTitleCaseLabel(node.data('name'));
		const entityType = node.data('entityType') || node.data('label');
		const sourceNotes = node.data('sourceNotes') || [];
		const description = node.data('description') || '';
		const degree = node.data('degree') || 0;
		const community = node.data('community') || 0;

		this.tooltipEl.empty();
		this.tooltipEl.createDiv({ cls: 'tooltip-label', text: toTitleCaseLabel(entityType) });
		this.tooltipEl.createDiv({ cls: 'tooltip-name', text: name });
		if (description) {
			this.tooltipEl.createDiv({ cls: 'tooltip-detail', text: description });
		}
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
			fit: true,
			padding: 48,
			edgeElasticity: () => 0.5,
			nestingFactor: 0.1,
			numIter: 2200,
			tile: true,
		};

		// Large graph (1000+ elements or flagged as large)
		if (isLarge || elementCount > 1000) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: false,
				nodeRepulsion: () => 16000,
				idealEdgeLength: () => 105,
				gravity: 0.25,
				componentSpacing: 90,
				tilingPaddingVertical: 24,
				tilingPaddingHorizontal: 24,
			} as cytoscape.LayoutOptions;
		}

		// Medium graph (300-1000 elements)
		if (elementCount > 300) {
			return {
				...baseConfig,
				quality: 'default',
				nodeDimensionsIncludeLabels: true,
				nodeRepulsion: () => 13000,
				idealEdgeLength: () => 115,
				gravity: 0.3,
				componentSpacing: 80,
				tilingPaddingVertical: 22,
				tilingPaddingHorizontal: 22,
			} as cytoscape.LayoutOptions;
		}

		// Small graph (<300 elements)
		return {
			...baseConfig,
			quality: 'default',
			nodeDimensionsIncludeLabels: true,
			nodeRepulsion: () => 9000,
			idealEdgeLength: () => 105,
			gravity: 0.38,
			componentSpacing: 70,
			tilingPaddingVertical: 18,
			tilingPaddingHorizontal: 18,
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
