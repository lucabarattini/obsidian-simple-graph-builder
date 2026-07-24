import { Modal, Notice, Setting } from 'obsidian';
import SimpleGraphBuilderPlugin from '../main';
import { EntityType, OntologyNode, VALID_ENTITY_TYPES } from '../types';

export class EntityEditModal extends Modal {
	private plugin: SimpleGraphBuilderPlugin;
	private node: OntologyNode;
	private onSaved: () => void;

	constructor(
		plugin: SimpleGraphBuilderPlugin,
		node: OntologyNode,
		onSaved: () => void
	) {
		super(plugin.app);
		this.plugin = plugin;
		this.node = node;
		this.onSaved = onSaved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('sgb-entity-edit-modal');
		contentEl.createEl('h2', { text: 'Correct entity details' });
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'This edits the local graph cache only. It does not modify your Markdown notes or call an AI provider.',
		});

		let name = this.node.properties.name;
		let entityType: EntityType = this.node.entityType;
		let description = typeof this.node.properties.description === 'string'
			? this.node.properties.description
			: '';

		new Setting(contentEl)
			.setName('Name')
			.addText(text => text
				.setValue(name)
				.onChange(value => {
					name = value.trim();
				}));

		new Setting(contentEl)
			.setName('Entity type')
			.addDropdown(dropdown => {
				for (const type of VALID_ENTITY_TYPES) {
					dropdown.addOption(type, type);
				}
				dropdown
					.setValue(entityType)
					.onChange(value => {
						entityType = value as EntityType;
					});
			});

		const descriptionSetting = new Setting(contentEl)
			.setName('Description')
			.setDesc('Add the context that makes this entity accurate and useful.');
		const textarea = descriptionSetting.controlEl.createEl('textarea');
		textarea.value = description;
		textarea.rows = 5;
		textarea.addClass('sgb-entity-description-input');
		textarea.addEventListener('input', () => {
			description = textarea.value.trim();
		});

		const sourceSummary = contentEl.createDiv({ cls: 'sgb-entity-source-summary' });
		sourceSummary.createEl('strong', {
			text: `${this.node.sourceNotes.length} source note${this.node.sourceNotes.length === 1 ? '' : 's'}`,
		});
		for (const sourcePath of this.node.sourceNotes.slice(0, 8)) {
			sourceSummary.createDiv({ text: sourcePath });
		}
		if (this.node.sourceNotes.length > 8) {
			sourceSummary.createDiv({ text: `…and ${this.node.sourceNotes.length - 8} more` });
		}

		const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
		buttons.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => this.close());
		buttons.createEl('button', { text: 'Save correction', cls: 'mod-cta' })
			.addEventListener('click', () => {
				if (!name) {
					new Notice('Entity name cannot be empty.');
					return;
				}
				void this.save(name, entityType, description);
			});
	}

	private async save(
		name: string,
		entityType: EntityType,
		description: string
	): Promise<void> {
		const oldName = this.node.properties.name;
		const updated: OntologyNode = {
			...this.node,
			entityType,
			properties: {
				...this.node.properties,
				name,
				description,
			},
			updatedAt: Date.now(),
		};
		this.plugin.graphCache.updateNode(updated);
		if (name.toLowerCase() !== oldName.toLowerCase()) {
			this.plugin.graphCache.addAliasToNode(updated.id, oldName);
		}
		await this.plugin.graphCache.flush();
		new Notice(`Updated entity: ${name}`);
		this.close();
		this.onSaved();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
