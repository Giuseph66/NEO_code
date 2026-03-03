/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Categories } from '../../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../../common/editor.js';
import { EditorInput } from '../../../../common/editor/editorInput.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IGeminiAuthService, NEO_GEMINI_COMMAND_OPEN_SETTINGS } from '../common/geminiTypes.js';
import { GeminiAuthService } from './geminiAuthService.js';
import { GeminiSettingsDialog, GeminiSettingsEditorInput } from './geminiSettingsDialog.js';

// ─── Service registration ─────────────────────────────────────────────────────
registerSingleton(IGeminiAuthService, GeminiAuthService, InstantiationType.Delayed);

// ─── Menu contributions ───────────────────────────────────────────────────────
const NEOCODE_SETTINGS_MENU = MenuId.for('NeoCodeSettingsMenu');
const NEOCODE_GLOBAL_SETTINGS_MENU = MenuId.for('NeoCodeGlobalSettingsMenu');

// ─── Editor pane registration ─────────────────────────────────────────────────
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		GeminiSettingsDialog,
		GeminiSettingsDialog.ID,
		localize('neocode.gemini.editor.title', 'Configurar Gemini')
	),
	[new SyncDescriptor(GeminiSettingsEditorInput)]
);

class GeminiSettingsEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof GeminiSettingsEditorInput;
	}
	serialize(_editorInput: EditorInput): string { return ''; }
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(GeminiSettingsEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	GeminiSettingsEditorInput.ID,
	GeminiSettingsEditorSerializer
);

// ─── Command / Action registration ───────────────────────────────────────────
registerAction2(class OpenGeminiSettingsAction extends Action2 {
	constructor() {
		super({
			id: NEO_GEMINI_COMMAND_OPEN_SETTINGS,
			title: localize2('neocode.gemini.open', 'NeoCode: Configurar Gemini'),
			category: Categories.Preferences,
			icon: Codicon.sparkle,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 3 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 3 }
			]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(GeminiSettingsEditorInput), { pinned: true });
	}
});
