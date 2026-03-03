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
import { IQwenAuthService, NEO_QWEN_COMMAND_OPEN_SETTINGS } from '../common/qwenTypes.js';
import { QwenAuthService } from './qwenAuthService.js';
import { QwenSettingsDialog, QwenSettingsEditorInput } from './qwenSettingsDialog.js';

registerSingleton(IQwenAuthService, QwenAuthService, InstantiationType.Delayed);

const NEOCODE_SETTINGS_MENU = MenuId.for('NeoCodeSettingsMenu');
const NEOCODE_GLOBAL_SETTINGS_MENU = MenuId.for('NeoCodeGlobalSettingsMenu');

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		QwenSettingsDialog,
		QwenSettingsDialog.ID,
		localize('neocode.qwen.editor.title', 'Configurar Qwen')
	),
	[new SyncDescriptor(QwenSettingsEditorInput)]
);

class QwenSettingsEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof QwenSettingsEditorInput;
	}
	serialize(_editorInput: EditorInput): string { return ''; }
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(QwenSettingsEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(QwenSettingsEditorInput.ID, QwenSettingsEditorSerializer);

registerAction2(class OpenQwenSettingsAction extends Action2 {
	constructor() {
		super({
			id: NEO_QWEN_COMMAND_OPEN_SETTINGS,
			title: localize2('neocode.qwen.open', 'NeoCode: Configurar Qwen'),
			category: Categories.Preferences,
			icon: Codicon.hubot,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 2 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 2 }
			]
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(QwenSettingsEditorInput), { pinned: true });
	}
});
