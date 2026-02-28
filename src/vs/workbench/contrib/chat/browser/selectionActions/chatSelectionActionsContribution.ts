/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/chatSelectionActionsWidget.css';
import { $, addDisposableListener, append, EventType, h } from '../../../../../base/browser/dom.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../../base/common/network.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from '../../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../../editor/browser/editorExtensions.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../../platform/keybinding/common/keybinding.js';
import { ChatContextKeys } from '../../common/actions/chatContextKeys.js';
import { ACTION_START as INLINE_CHAT_START } from '../../../inlineChat/common/inlineChat.js';
import { InlineChatController } from '../../../inlineChat/browser/inlineChatController.js';

const ADD_TO_CHAT_COMMAND_ID = 'workbench.action.chat.attachSelection';
const ADD_FILE_TO_CHAT_COMMAND_ID = 'workbench.action.chat.attachFile';
type QuickEditScope = 'selection' | 'file';

class ChatSelectionActionsWidget extends Disposable implements IContentWidget {

	private static _idPool = 0;

	private readonly _id = `chat-selection-actions-content-widget-${ChatSelectionActionsWidget._idPool++}`;
	private readonly _domNode: HTMLElement;
	private readonly _selectionScopeButton: HTMLButtonElement;
	private readonly _fileScopeButton: HTMLButtonElement;
	private readonly _addToChatButton: HTMLButtonElement;
	private readonly _quickEditButton: HTMLButtonElement;
	private _position: IContentWidgetPosition | null = null;
	private _isVisible = false;
	private _scope: QuickEditScope = 'selection';

	readonly allowEditorOverflow = true;
	readonly suppressMouseDown = false;

	constructor(
		private readonly _editor: ICodeEditor,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IKeybindingService private readonly _keybindingService: IKeybindingService,
	) {
		super();

		const root = h('.chat-selection-actions-widget');
		const scopeSwitch = append(root.root, $('.chat-selection-scope-switch'));
		const selectionScopeButton = append(scopeSwitch, $('button.chat-selection-scope-button.selection', { type: 'button' })) as HTMLButtonElement;
		const fileScopeButton = append(scopeSwitch, $('button.chat-selection-scope-button.file', { type: 'button' })) as HTMLButtonElement;
		const addToChatButton = append(root.root, $('button.chat-selection-action-button.add-to-chat', { type: 'button' })) as HTMLButtonElement;
		const quickEditButton = append(root.root, $('button.chat-selection-action-button.quick-edit', { type: 'button' })) as HTMLButtonElement;

		this._domNode = root.root;
		this._selectionScopeButton = selectionScopeButton;
		this._fileScopeButton = fileScopeButton;
		this._addToChatButton = addToChatButton;
		this._quickEditButton = quickEditButton;
		this._addToChatButton.title = localize('chatSelectionActions.addToChat.tooltip', 'Attach the selected code to chat');
		this._quickEditButton.title = localize('chatSelectionActions.quickEdit.tooltip', 'Quick edit the selected code or entire file');

		this._renderButtonLabels();
		this._renderScopeLabels();
		this._renderScopeState();

		this._register(this._keybindingService.onDidUpdateKeybindings(() => this._renderButtonLabels()));
		this._register(addDisposableListener(this._domNode, EventType.MOUSE_DOWN, e => e.stopPropagation()));
		this._register(addDisposableListener(this._selectionScopeButton, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this._scope = 'selection';
			this._renderScopeState();
		}));
		this._register(addDisposableListener(this._fileScopeButton, EventType.CLICK, e => {
			e.preventDefault();
			e.stopPropagation();
			this._scope = 'file';
			this._renderScopeState();
		}));
		this._register(addDisposableListener(this._addToChatButton, EventType.CLICK, async e => {
			e.preventDefault();
			e.stopPropagation();
			await this._commandService.executeCommand(this._scope === 'file' ? ADD_FILE_TO_CHAT_COMMAND_ID : ADD_TO_CHAT_COMMAND_ID);
			this._hide();
		}));
		this._register(addDisposableListener(this._quickEditButton, EventType.CLICK, async e => {
			e.preventDefault();
			e.stopPropagation();
			const applyToEntireFile = this._scope === 'file';
			if (applyToEntireFile && this._editor.hasModel()) {
				this._editor.setSelection(this._editor.getModel().getFullModelRange());
			}
			const controller = InlineChatController.get(this._editor);
			if (controller) {
				await controller.inputOverlayWidget.showMenuAtSelection(
					applyToEntireFile
						? localize('chatSelectionActions.quickEdit.placeholder.fullFile', 'Describe what should change in this file')
						: localize('chatSelectionActions.quickEdit.placeholder.selection', 'Describe what should change in this selected code'),
					{ size: 'expanded' }
				);
			} else {
				await this._commandService.executeCommand(INLINE_CHAT_START);
			}
			this._hide();
		}));

		this._register(this._editor.onDidChangeCursorSelection(() => this._updateVisibility()));
		this._register(this._editor.onDidChangeModel(() => this._updateVisibility()));
		this._register(this._editor.onDidFocusEditorWidget(() => this._updateVisibility()));
		this._register(this._editor.onDidBlurEditorWidget(() => this._hide()));
		this._register(this._contextKeyService.onDidChangeContext(() => this._updateVisibility()));

		this._updateVisibility();
	}

	private _renderButtonLabels(): void {
		const addToChatKb = this._keybindingService.lookupKeybinding(ADD_TO_CHAT_COMMAND_ID)?.getLabel() ?? undefined;
		const quickEditKb = this._keybindingService.lookupKeybinding(INLINE_CHAT_START)?.getLabel() ?? undefined;

		this._renderButtonLabel(
			this._addToChatButton,
			localize('chatSelectionActions.addToChat', 'Add to Chat'),
			addToChatKb
		);
		this._renderButtonLabel(
			this._quickEditButton,
			localize('chatSelectionActions.quickEdit', 'Quick Edit'),
			quickEditKb
		);
	}

	private _renderScopeLabels(): void {
		this._selectionScopeButton.textContent = localize('chatSelectionActions.scope.selection', 'Selection');
		this._fileScopeButton.textContent = localize('chatSelectionActions.scope.file', 'Whole File');
	}

	private _renderScopeState(): void {
		const selectionActive = this._scope === 'selection';
		this._selectionScopeButton.classList.toggle('active', selectionActive);
		this._fileScopeButton.classList.toggle('active', !selectionActive);
		this._selectionScopeButton.setAttribute('aria-pressed', String(selectionActive));
		this._fileScopeButton.setAttribute('aria-pressed', String(!selectionActive));
		this._addToChatButton.title = selectionActive
			? localize('chatSelectionActions.addToChat.tooltip.selection', 'Attach selected code to chat')
			: localize('chatSelectionActions.addToChat.tooltip.file', 'Attach the whole file to chat');
		this._quickEditButton.title = selectionActive
			? localize('chatSelectionActions.quickEdit.tooltip.selection', 'Quick edit the selected code')
			: localize('chatSelectionActions.quickEdit.tooltip.file', 'Quick edit the whole file');
	}

	private _renderButtonLabel(button: HTMLButtonElement, label: string, keybindingLabel: string | undefined): void {
		button.textContent = '';
		append(button, $('span.chat-selection-action-label', undefined, label));
		if (keybindingLabel) {
			append(button, $('span.chat-selection-action-keybinding', undefined, keybindingLabel));
		}
	}

	private _updateVisibility(): void {
		const model = this._editor.getModel();
		const selection = this._editor.getSelection();
		const isEnabled = ChatContextKeys.enabled.getValue(this._contextKeyService);
		const hasSelection = !!selection && !selection.isEmpty();
		const isAllowedScheme = !!model && [Schemas.file, Schemas.vscodeRemote, Schemas.untitled, Schemas.vscodeUserData].includes(model.uri.scheme);

		if (!isEnabled || !model || !hasSelection || !isAllowedScheme || this._editor.isSimpleWidget) {
			this._hide();
			return;
		}

		this._position = {
			position: selection.getEndPosition(),
			preference: [ContentWidgetPositionPreference.BELOW, ContentWidgetPositionPreference.ABOVE],
		};

		if (!this._isVisible) {
			this._editor.addContentWidget(this);
			this._isVisible = true;
		} else {
			this._editor.layoutContentWidget(this);
		}
	}

	private _hide(): void {
		if (this._isVisible) {
			this._isVisible = false;
			this._editor.removeContentWidget(this);
		}
		this._position = null;
	}

	getId(): string {
		return this._id;
	}

	getDomNode(): HTMLElement {
		return this._domNode;
	}

	getPosition(): IContentWidgetPosition | null {
		return this._position;
	}

	override dispose(): void {
		this._hide();
		super.dispose();
	}
}

export class ChatSelectionActionsContribution extends Disposable {
	static readonly ID = 'chatSelectionActionsContribution';

	constructor(
		private readonly _editor: ICodeEditor,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		super();
		this._register(instantiationService.createInstance(ChatSelectionActionsWidget, this._editor));
	}
}

registerEditorContribution(ChatSelectionActionsContribution.ID, ChatSelectionActionsContribution, EditorContributionInstantiation.AfterFirstRender);
