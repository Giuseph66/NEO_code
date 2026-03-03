/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import './media/neocodeSwarmBranchModal.css';

const $ = dom.$;

export interface IBranchInfo {
	name: string;
	isCurrent: boolean;
	isRemote: boolean;
}

export interface IStashInfo {
	id: string;
	message: string;
}

export interface IBranchModalOptions {
	currentBranch: string;
	localBranches: string[];
	remoteBranches: string[];
	stashes: IStashInfo[];
	onCheckout: (branch: string) => Promise<void>;
	onCreate: (name: string) => Promise<void>;
	onMerge: (branch: string) => Promise<void>;
	onDelete: (branch: string) => Promise<void>;
	onStashPop: (id: string) => Promise<void>;
	onStashDrop: (id: string) => Promise<void>;
	onRefresh: () => Promise<void>;
	isLoading?: boolean;
}

export class NeocodeSwarmBranchModal extends Disposable {
	private overlay: HTMLElement | undefined;
	private container: HTMLElement | undefined;
	private bodyEl: HTMLElement | undefined;
	private activeTab: 'local' | 'remote' | 'stash' = 'local';
	private filterText: string = '';
	private createInputContainer: HTMLElement | undefined;
	private readonly uiDisposables = this._register(new DisposableStore());

	constructor(private options: IBranchModalOptions) {
		super();
	}

	async show(): Promise<void> {
		this.create();
		this.render();
	}

	private create(): void {
		this.overlay = dom.append(document.body, $('.neo-branch-modal-overlay'));
		this._register(dom.addDisposableListener(this.overlay, dom.EventType.CLICK, event => {
			if (event.target === this.overlay) {
				this.dispose();
			}
		}));

		this.container = dom.append(this.overlay, $('.neo-branch-modal-container'));

		const header = dom.append(this.container, $('.neo-branch-modal-header'));
		const titleBlock = dom.append(header, $('.neo-branch-modal-title-block'));
		dom.append(titleBlock, $('h2', undefined, localize('neoBranch.title', 'Gerenciador de Branches (NeoCode)')));
		dom.append(titleBlock, $('p', undefined, localize('neoBranch.subtitle', 'Gerencie suas ramificações e stashes com facilidade.')));

		const tabs = dom.append(this.container, $('.neo-branch-modal-tabs'));
		this.createTab(tabs, 'local', localize('neoBranch.local', 'Locais'));
		this.createTab(tabs, 'remote', localize('neoBranch.remote', 'Remotas'));
		this.createTab(tabs, 'stash', localize('neoBranch.stash', 'Stashes'));

		const searchContainer = dom.append(this.container, $('.neo-branch-search-container'));
		const searchInput = dom.append(searchContainer, $('input.neo-branch-search-input', {
			type: 'text',
			placeholder: localize('neoBranch.searchPlaceholder', 'Filtrar ramificações...')
		})) as HTMLInputElement;

		this._register(dom.addDisposableListener(searchInput, dom.EventType.INPUT, () => {
			this.filterText = searchInput.value.toLowerCase();
			this.render();
		}));

		this._register(dom.addDisposableListener(searchInput, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (searchInput.value) {
					searchInput.value = '';
					this.filterText = '';
					this.render();
				} else {
					this.dispose();
				}
				e.stopPropagation();
			}
		}));

		this.bodyEl = dom.append(this.container, $('.neo-branch-modal-body'));

		const footer = dom.append(this.container, $('.neo-branch-modal-footer'));

		// Inline create input (inicialmente escondido)
		this.createInputContainer = dom.append(footer, $('.neo-branch-create-input-container'));
		this.createInputContainer.style.display = 'none';
		const createInput = dom.append(this.createInputContainer, $('input.neo-branch-search-input', {
			type: 'text',
			placeholder: localize('neoBranch.prompt.name', 'Nome da nova branch...')
		})) as HTMLInputElement;
		const confirmBtn = dom.append(this.createInputContainer, $('button.neo-branch-btn.primary', { type: 'button' }, localize('neoBranch.confirmCreate', 'Criar')));

		this._register(dom.addDisposableListener(confirmBtn, dom.EventType.CLICK, () => {
			const name = createInput.value.trim();
			if (name) {
				void this.options.onCreate(name);
				createInput.value = '';
				this.createInputContainer!.style.display = 'none';
			}
		}));

		this._register(dom.addDisposableListener(createInput, dom.EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Enter') {
				const name = createInput.value.trim();
				if (name) {
					void this.options.onCreate(name);
					createInput.value = '';
					this.createInputContainer!.style.display = 'none';
				}
			} else if (e.key === 'Escape') {
				createInput.value = '';
				this.createInputContainer!.style.display = 'none';
			}
			e.stopPropagation();
		}));

		const footerButtons = dom.append(footer, $('.neo-branch-footer-buttons'));
		const createBtn = dom.append(footerButtons, $('button.neo-branch-btn.primary', { type: 'button' }, localize('neoBranch.createBtn', 'Nova Branch')));
		this._register(dom.addDisposableListener(createBtn, dom.EventType.CLICK, () => {
			this.createInputContainer!.style.display = 'flex';
			createInput.focus();
		}));

		const closeBtn = dom.append(footerButtons, $('button.neo-branch-btn', { type: 'button' }, localize('neoBranch.close', 'Fechar')));
		this._register(dom.addDisposableListener(closeBtn, dom.EventType.CLICK, () => this.dispose()));
	}

	private createTab(parent: HTMLElement, id: 'local' | 'remote' | 'stash', label: string): void {
		const tab = dom.append(parent, $(`.neo-branch-tab${this.activeTab === id ? '.active' : ''}`, undefined, label));
		this._register(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
			this.activeTab = id;
			this.updateTabStyles(parent);
			this.render();
		}));
	}

	private updateTabStyles(parent: HTMLElement): void {
		const tabs = parent.querySelectorAll('.neo-branch-tab');
		tabs.forEach((t, i) => {
			const id = i === 0 ? 'local' : i === 1 ? 'remote' : 'stash';
			if (id === this.activeTab) {
				t.classList.add('active');
			} else {
				t.classList.remove('active');
			}
		});
	}

	private render(): void {
		if (!this.bodyEl) { return; }
		this.uiDisposables.clear();
		dom.clearNode(this.bodyEl);

		if (this.options.isLoading) {
			const loading = dom.append(this.bodyEl, $('.neo-branch-loading-container'));
			dom.append(loading, $('.neo-branch-spinner'));
			dom.append(loading, $('span', undefined, localize('neoBranch.loading', 'Verificando ramificações...')));
			return;
		}

		const list = dom.append(this.bodyEl, $('.neo-branch-list'));

		if (this.activeTab === 'local') {
			this.renderLocalBranches(list);
		} else if (this.activeTab === 'remote') {
			this.renderRemoteBranches(list);
		} else {
			this.renderStashes(list);
		}
	}

	private renderLocalBranches(parent: HTMLElement): void {
		const branches = this.options.localBranches.filter(b => b.toLowerCase().includes(this.filterText));

		if (branches.length === 0) {
			dom.append(parent, $('.neo-branch-empty', undefined, localize('neoBranch.noLocal', 'Nenhuma branch local encontrada.')));
			return;
		}

		for (const branch of branches) {
			const isCurrent = branch === this.options.currentBranch;
			const item = dom.append(parent, $(`.neo-branch-item${isCurrent ? '.current' : ''}`));

			const info = dom.append(item, $('.neo-branch-info'));
			dom.append(info, $(`.codicon.codicon-${isCurrent ? 'check' : 'git-branch'}`, {
				style: isCurrent ? 'color: var(--vscode-button-background);' : ''
			}));
			dom.append(info, $(`.neo-branch-name`, undefined, branch));

			const actions = dom.append(item, $('.neo-branch-actions'));

			if (!isCurrent) {
				const checkout = dom.append(actions, $('button.neo-branch-btn.primary', { title: 'Checkout' }, 'Checkout'));
				this.uiDisposables.add(dom.addDisposableListener(checkout, dom.EventType.CLICK, (e) => {
					e.stopPropagation();
					void this.options.onCheckout(branch);
				}));

				const merge = dom.append(actions, $('button.neo-branch-btn', { title: 'Merge' }, 'Merge'));
				this.uiDisposables.add(dom.addDisposableListener(merge, dom.EventType.CLICK, (e) => {
					e.stopPropagation();
					void this.options.onMerge(branch);
				}));

				const del = dom.append(actions, $('button.neo-branch-btn', { title: 'Delete' }, 'Delete'));
				this.uiDisposables.add(dom.addDisposableListener(del, dom.EventType.CLICK, (e) => {
					e.stopPropagation();
					void this.options.onDelete(branch);
				}));
			} else {
				dom.append(actions, $('span', { style: 'font-size: 11px; font-weight: 600; color: var(--vscode-button-background);' }, localize('neoBranch.currentLabel', 'ATIVE')));
			}
		}
	}

	private renderRemoteBranches(parent: HTMLElement): void {
		const branches = this.options.remoteBranches.filter(b => b.toLowerCase().includes(this.filterText));

		if (branches.length === 0) {
			dom.append(parent, $('.neo-branch-empty', undefined, localize('neoBranch.noRemote', 'Nenhuma branch remota encontrada.')));
			return;
		}

		for (const branch of branches) {
			const item = dom.append(parent, $('.neo-branch-item'));

			const info = dom.append(item, $('.neo-branch-info'));
			dom.append(info, $('.codicon.codicon-cloud-download'));
			dom.append(info, $(`.neo-branch-name`, undefined, branch));

			const actions = dom.append(item, $('.neo-branch-actions'));
			const checkout = dom.append(actions, $('button.neo-branch-btn.primary', { title: 'Checkout' }, 'Checkout (local)'));
			this.uiDisposables.add(dom.addDisposableListener(checkout, dom.EventType.CLICK, (e) => {
				e.stopPropagation();
				void this.options.onCheckout(branch);
			}));
		}
	}

	private renderStashes(parent: HTMLElement): void {
		if (this.options.stashes.length === 0) {
			dom.append(parent, $('.neo-branch-empty', undefined, localize('neoBranch.noStash', 'Nenhum stash encontrado.')));
			return;
		}

		for (const stash of this.options.stashes) {
			const item = dom.append(parent, $('.neo-branch-item'));

			const info = dom.append(item, $('.neo-branch-info'));
			dom.append(info, $('.codicon.codicon-archive'));
			const name = dom.append(info, $('.neo-branch-name'));
			dom.append(name, $('span', { style: 'font-weight: 600; margin-right: 8px;' }, stash.id));
			dom.append(name, $('span', undefined, stash.message));

			const actions = dom.append(item, $('.neo-branch-actions'));
			const apply = dom.append(actions, $('button.neo-branch-btn.primary', { title: 'Pop' }, 'Pop / Apply'));
			this.uiDisposables.add(dom.addDisposableListener(apply, dom.EventType.CLICK, () => void this.options.onStashPop(stash.id)));

			const del = dom.append(actions, $('button.neo-branch-btn', { title: 'Drop' }, 'Drop'));
			this.uiDisposables.add(dom.addDisposableListener(del, dom.EventType.CLICK, () => void this.options.onStashDrop(stash.id)));
		}
	}

	public updateOptions(newOptions: Partial<IBranchModalOptions>): void {
		this.options = { ...this.options, ...newOptions };
		this.render();
	}

	override dispose(): void {
		super.dispose();
		this.overlay?.remove();
	}
}
