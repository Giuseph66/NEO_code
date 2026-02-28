/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ResourceMap } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/path.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IChatEditingService, IModifiedFileEntry } from '../../../contrib/chat/common/editing/chatEditingService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { localize } from '../../../../nls.js';

/**
 * Watches for file changes made by external AI agents (CLIs like Claude Code, Codex, Qwen)
 * and presents an accept/reject diff UI via the chat editing session infrastructure.
 */
export class NeocodeExternalEditWatcher extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.neocodeExternalEditWatcher';

	/** Last known content for each tracked file URI. */
	private readonly _snapshots = new ResourceMap<string>();

	/**
	 * URIs currently being saved by VS Code itself.
	 * Used to avoid treating VS Code saves as external edits.
	 */
	private readonly _ownSaveUris = new Set<string>();

	/** Debounce in-flight external change handlers to avoid duplicate entries. */
	private readonly _pendingHandlers = new Set<string>();

	constructor(
		@IFileService private readonly fileService: IFileService,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IModelService private readonly modelService: IModelService,
		@IChatEditingService private readonly chatEditingService: IChatEditingService,
		@IEditorService private readonly editorService: IEditorService,
		@INotificationService private readonly notificationService: INotificationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Snapshot all currently open text models
		for (const model of this.modelService.getModels()) {
			if (model.uri.scheme === 'file') {
				this._snapshots.set(model.uri, model.getValue());
			}
		}

		// Track newly added models so we always have a before-snapshot available
		this._register(this.modelService.onModelAdded(model => {
			if (model.uri.scheme === 'file') {
				this._snapshots.set(model.uri, model.getValue());
			}
		}));

		// Track VS Code saves: update snapshot and mark URI as an "own save"
		// so we ignore the resulting file-change event from the OS.
		// onDidSave is on textFileService.files (ITextFileEditorModelManager)
		this._register(this.textFileService.files.onDidSave(event => {
			const uri = event.model.resource;
			const key = uri.toString();
			this._ownSaveUris.add(key);

			// Update snapshot to the saved content
			const textModel = this.modelService.getModel(uri);
			if (textModel) {
				this._snapshots.set(uri, textModel.getValue());
			}

			// Remove from own-save set after 500 ms (enough for the OS fs event to arrive)
			setTimeout(() => this._ownSaveUris.delete(key), 500);
		}));

		// Detect external file changes from the OS
		this._register(this.fileService.onDidFilesChange(event => {
			for (const uri of event.rawUpdated) {
				if (uri.scheme !== 'file') {
					continue;
				}

				const key = uri.toString();
				if (this._ownSaveUris.has(key)) {
					// VS Code saved this file — not an external change
					continue;
				}

				if (!this._pendingHandlers.has(key)) {
					this._pendingHandlers.add(key);
					this._handleExternalChange(uri).finally(() => this._pendingHandlers.delete(key));
				}
			}
		}));
	}

	private async _handleExternalChange(uri: URI): Promise<void> {
		const beforeContent = this._snapshots.get(uri);
		if (beforeContent === undefined) {
			// We have no known baseline for this file — skip to avoid incorrect diffs
			return;
		}

		let afterContent: string;
		try {
			const fileContent = await this.fileService.readFile(uri);
			afterContent = fileContent.value.toString();
		} catch (err) {
			this.logService.warn('[neocode watcher] Could not read changed file:', err);
			return;
		}

		if (beforeContent === afterContent) {
			// Content unchanged — spurious event
			return;
		}

		// Eagerly update the snapshot so subsequent events see the new baseline
		this._snapshots.set(uri, afterContent);

		// Find the most recently active editing session
		const sessions = this.chatEditingService.editingSessionsObs.get();
		const editingSession = sessions[0];

		if (!editingSession) {
			// No editing session active — open the file and show a plain notification
			await this.editorService.openEditor({ resource: uri, options: { preserveFocus: true } });
			this.notificationService.info(
				localize('neoExternalEditNoSession', "External agent modified '{0}'", basename(uri.path))
			);
			return;
		}

		// Ensure the file is open in an editor so the inline diff decorations are visible
		await this.editorService.openEditor({ resource: uri, options: { preserveFocus: true } });

		let entry: IModifiedFileEntry;
		try {
			entry = await editingSession.addExternalReviewEntry(uri, beforeContent);
		} catch (err) {
			this.logService.error('[neocode watcher] addExternalReviewEntry failed:', err);
			return;
		}

		const filename = basename(uri.path);
		this.notificationService.prompt(
			Severity.Info,
			localize('neoExternalEditPrompt', "External agent modified '{0}'. Review changes?", filename),
			[
				{
					label: localize('neoReview', "Review"),
					run: () => editingSession.show()
				},
				{
					label: localize('neoAccept', "Accept All"),
					run: () => entry.accept()
				},
				{
					label: localize('neoReject', "Reject All"),
					run: () => entry.reject()
				},
			],
			{ sticky: false }
		);
	}
}
