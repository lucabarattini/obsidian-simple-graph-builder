import { Modal, Notice, TFile, normalizePath } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import {
	BacklinkSuggestion,
	RelatedNoteLink,
	buildBacklinkSuggestions,
	getNoteDisplayName,
	upsertManagedRelatedNotes,
} from '../graph/backlinks';
import { ConfirmModal } from '../ui/confirm-modal';

const BACKUP_ROOT = '.simple-graph-builder-backups';

export function openBacklinkSuggestions(plugin: SimpleGraphBuilderPlugin): void {
	const graph = plugin.graphCache.getGraphData();
	if (graph.nodes.length === 0) {
		new Notice('Analyze your vault before generating backlink suggestions.');
		return;
	}

	const suggestions = buildBacklinkSuggestions(graph, {
		minSharedEntities: plugin.settings.backlinkMinSharedEntities,
		maxLinksPerNote: plugin.settings.backlinkMaxLinksPerNote,
		maxEntityDocumentFrequency: plugin.settings.backlinkMaxEntityDocumentFrequency,
		limit: 250,
	});

	if (suggestions.length === 0) {
		new Notice('No note pairs meet the current backlink thresholds.');
		return;
	}

	new BacklinkReviewModal(plugin, suggestions).open();
}

class BacklinkReviewModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private suggestions: BacklinkSuggestion[];
	private selected = new Set<number>();
	private selectionLabel: HTMLElement | null = null;

	constructor(plugin: SimpleGraphBuilderPlugin, suggestions: BacklinkSuggestion[]) {
		super(plugin.app);
		this.plugin = plugin;
		this.suggestions = suggestions;
		suggestions.forEach((_, index) => this.selected.add(index));
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('sgb-backlink-modal');
		contentEl.createEl('h2', { text: 'Review related-note backlinks' });
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Suggestions are ranked locally from shared extracted entities. Applying a pair adds a reciprocal Obsidian link to both notes.',
		});

		const warning = contentEl.createDiv({ cls: 'sgb-backlink-warning' });
		warning.createEl('strong', { text: 'Safe write: ' });
		warning.appendText(`Every changed note is copied to ${BACKUP_ROOT} before editing. Generated sections can be regenerated without duplicating content.`);

		const controls = contentEl.createDiv({ cls: 'sgb-backlink-controls' });
		controls.createEl('button', { text: 'Select all' }).addEventListener('click', () => {
			this.selected = new Set(this.suggestions.map((_, index) => index));
			this.renderSuggestionList(list);
		});
		controls.createEl('button', { text: 'Select none' }).addEventListener('click', () => {
			this.selected.clear();
			this.renderSuggestionList(list);
		});
		this.selectionLabel = controls.createSpan();

		const list = contentEl.createDiv({ cls: 'sgb-backlink-list' });
		this.renderSuggestionList(list);

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

	private renderSuggestionList(container: HTMLElement): void {
		container.empty();
		this.updateSelectionLabel();

		this.suggestions.forEach((suggestion, index) => {
			const row = container.createEl('label', { cls: 'sgb-backlink-row' });
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
