import { Modal, Notice, TFile, normalizePath } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import {
	BacklinkSuggestion,
	RelatedNoteLink,
	buildBacklinkSuggestions,
	getNoteDisplayName,
	upsertManagedRelatedNotes,
} from '../graph/backlinks';
import { filterGraphBySourceFolder, getGraphSourceFolders } from '../graph/scope';
import { GraphData } from '../types';
import { ConfirmModal } from '../ui/confirm-modal';

const BACKUP_ROOT = '.simple-graph-builder-backups';

export function openBacklinkSuggestions(plugin: SimpleGraphBuilderPlugin): void {
	const graph = plugin.graphCache.getGraphData();
	if (graph.nodes.length === 0) {
		new Notice('Analyze your vault before generating backlink suggestions.');
		return;
	}

	new BacklinkReviewModal(plugin, graph).open();
}

class BacklinkReviewModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private graph: GraphData;
	private suggestions: BacklinkSuggestion[] = [];
	private selected = new Set<number>();
	private selectionLabel: HTMLElement | null = null;
	private scopeSummary: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;

	constructor(plugin: SimpleGraphBuilderPlugin, graph: GraphData) {
		super(plugin.app);
		this.plugin = plugin;
		this.graph = graph;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('sgb-backlink-modal');
		contentEl.createEl('h2', { text: 'Review related-note backlinks' });
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Suggestions are ranked locally from shared extracted entities. Applying a pair adds a reciprocal Obsidian link to both notes.',
		});

		const scopeControl = contentEl.createDiv({ cls: 'sgb-backlink-scope' });
		scopeControl.createEl('label', { text: 'Source folder' });
		const scopeSelect = scopeControl.createEl('select');
		scopeSelect.createEl('option', { value: '', text: 'All analyzed notes' });
		const sourceFolders = getGraphSourceFolders(this.graph);
		for (const folder of sourceFolders) {
			scopeSelect.createEl('option', { value: folder, text: folder });
		}
		const savedSourceFolder = this.plugin.settings.backlinkSourceFolder;
		if (savedSourceFolder && !sourceFolders.includes(savedSourceFolder)) {
			scopeSelect.createEl('option', { value: savedSourceFolder, text: savedSourceFolder });
		}
		scopeSelect.value = savedSourceFolder;
		scopeSelect.title = 'Both notes in every suggestion must be inside this folder. Uses cached analysis only.';
		this.scopeSummary = scopeControl.createSpan();
		scopeSelect.addEventListener('change', () => {
			this.plugin.settings.backlinkSourceFolder = scopeSelect.value;
			void this.plugin.saveSettings();
			this.rebuildSuggestions();
		});

		const warning = contentEl.createDiv({ cls: 'sgb-backlink-warning' });
		warning.createEl('strong', { text: 'Safe write: ' });
		warning.appendText(`Every changed note is copied to ${BACKUP_ROOT} before editing. Generated sections can be regenerated without duplicating content.`);

		const controls = contentEl.createDiv({ cls: 'sgb-backlink-controls' });
		controls.createEl('button', { text: 'Select all' }).addEventListener('click', () => {
			this.selected = new Set(this.suggestions.map((_, index) => index));
			this.renderSuggestionList();
		});
		controls.createEl('button', { text: 'Select none' }).addEventListener('click', () => {
			this.selected.clear();
			this.renderSuggestionList();
		});
		this.selectionLabel = controls.createSpan();

		this.listEl = contentEl.createDiv({ cls: 'sgb-backlink-list' });
		this.rebuildSuggestions();

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		buttons.createEl('button', { text: 'Apply selected', cls: 'mod-cta' }).addEventListener('click', () => {
			if (this.selected.size === 0) {
				new Notice('Select at least one suggestion.');
				return;
			}

			const noteCount = new Set(
				[...this.selected].flatMap(index => {
					const suggestion = this.suggestions[index];
					return [suggestion.sourcePath, suggestion.targetPath];
				})
			).size;
			const message = `Write ${this.selected.size} reciprocal connections across ${noteCount} notes?\n\nA timestamped backup will be created first.`;
			new ConfirmModal(this.app, message, async () => {
				const chosen = [...this.selected].map(index => this.suggestions[index]);
				this.close();
				await applyBacklinkSuggestions(this.plugin, chosen);
			}).open();
		});
	}

	private rebuildSuggestions(): void {
		const scopedGraph = filterGraphBySourceFolder(
			this.graph,
			this.plugin.settings.backlinkSourceFolder
		);
		this.suggestions = buildBacklinkSuggestions(scopedGraph, {
			minSharedEntities: this.plugin.settings.backlinkMinSharedEntities,
			maxLinksPerNote: this.plugin.settings.backlinkMaxLinksPerNote,
			maxEntityDocumentFrequency: this.plugin.settings.backlinkMaxEntityDocumentFrequency,
			limit: 250,
		});
		this.selected = new Set(this.suggestions.map((_, index) => index));

		const noteCount = new Set(
			scopedGraph.nodes.flatMap(node => node.sourceNotes)
		).size;
		this.scopeSummary?.setText(
			`${noteCount} analyzed note${noteCount === 1 ? '' : 's'} · ${this.suggestions.length} suggestion${this.suggestions.length === 1 ? '' : 's'}`
		);
		this.renderSuggestionList();
	}

	private renderSuggestionList(): void {
		if (!this.listEl) return;
		this.listEl.empty();
		this.updateSelectionLabel();

		if (this.suggestions.length === 0) {
			this.listEl.createDiv({
				cls: 'sgb-backlink-empty',
				text: 'No note pairs in this folder meet the current shared-entity thresholds.',
			});
			return;
		}

		this.suggestions.forEach((suggestion, index) => {
			const row = this.listEl!.createEl('label', { cls: 'sgb-backlink-row' });
			const checkbox = row.createEl('input');
			checkbox.type = 'checkbox';
			checkbox.checked = this.selected.has(index);
			checkbox.addEventListener('change', () => {
				if (checkbox.checked) this.selected.add(index);
				else this.selected.delete(index);
				this.updateSelectionLabel();
			});

			const details = row.createDiv({ cls: 'sgb-backlink-details' });
			details.createDiv({
				cls: 'sgb-backlink-pair',
				text: `${getNoteDisplayName(suggestion.sourcePath)} ↔ ${getNoteDisplayName(suggestion.targetPath)}`,
			});
			details.createDiv({
				cls: 'sgb-backlink-paths',
				text: `${suggestion.sourcePath}  ·  ${suggestion.targetPath}`,
			});
			details.createDiv({
				cls: 'sgb-backlink-themes',
				text: `${suggestion.sharedEntities.length} shared: ${suggestion.sharedEntities.slice(0, 8).join(', ')}`,
			});
		});
	}

	private updateSelectionLabel(): void {
		this.selectionLabel?.setText(`${this.selected.size} of ${this.suggestions.length} selected`);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

async function applyBacklinkSuggestions(
	plugin: SimpleGraphBuilderPlugin,
	suggestions: BacklinkSuggestion[]
): Promise<void> {
	const linksBySourcePath = new Map<string, RelatedNoteLink[]>();
	for (const suggestion of suggestions) {
		addRelatedNote(linksBySourcePath, suggestion.sourcePath, {
			targetPath: suggestion.targetPath,
			sharedEntities: suggestion.sharedEntities,
		});
		addRelatedNote(linksBySourcePath, suggestion.targetPath, {
			targetPath: suggestion.sourcePath,
			sharedEntities: suggestion.sharedEntities,
		});
	}

	const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
	const backupFolder = normalizePath(`${BACKUP_ROOT}/${timestamp}`);
	let changed = 0;

	try {
		for (const [sourcePath, links] of linksBySourcePath) {
			const abstractFile = plugin.app.vault.getAbstractFileByPath(sourcePath);
			if (!(abstractFile instanceof TFile)) continue;

			const content = await plugin.app.vault.read(abstractFile);
			const updated = upsertManagedRelatedNotes(content, links);
			if (updated === content) continue;

			const backupPath = normalizePath(`${backupFolder}/${sourcePath}`);
			await ensureParentFolder(plugin, backupPath);
			await plugin.app.vault.adapter.write(backupPath, content);

			plugin.markManagedWrite(sourcePath);
			await plugin.app.vault.modify(abstractFile, updated);
			changed++;
		}

		new Notice(`Added ${suggestions.length} reciprocal connections to ${changed} notes. Backup: ${backupFolder}`, 8000);
	} catch (error) {
		console.error('Failed to apply backlink suggestions:', error);
		new Notice(`Backlink update stopped after ${changed} notes. Existing changes can be restored from ${backupFolder}.`, 10000);
	}
}

function addRelatedNote(
	linksBySourcePath: Map<string, RelatedNoteLink[]>,
	sourcePath: string,
	link: RelatedNoteLink
): void {
	const links = linksBySourcePath.get(sourcePath) ?? [];
	links.push(link);
	linksBySourcePath.set(sourcePath, links);
}

async function ensureParentFolder(plugin: SimpleGraphBuilderPlugin, filePath: string): Promise<void> {
	const segments = filePath.split('/').slice(0, -1);
	let currentPath = '';
	for (const segment of segments) {
		currentPath = currentPath ? `${currentPath}/${segment}` : segment;
		if (!await plugin.app.vault.adapter.exists(currentPath)) {
			await plugin.app.vault.adapter.mkdir(currentPath);
		}
	}
}
