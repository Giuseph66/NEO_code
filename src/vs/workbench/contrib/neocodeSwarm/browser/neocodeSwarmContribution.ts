/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { NEO_SWARM_OPEN_SETTINGS_COMMAND_ID } from '../common/neocodeSwarmTypes.js';
import { NeocodeSwarmSettingsEditor, NeocodeSwarmSettingsEditorInput } from './neocodeSwarmSettingsEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { INeocodeSwarmSecretService, INeocodeSwarmStorageService } from '../common/neocodeSwarmStorage.js';
import { NeocodeSwarmSecretService } from './neocodeSwarmSecretService.js';
import { NeocodeSwarmStorageService } from './neocodeSwarmStorageService.js';
import { NeocodeSwarmChatParticipant } from './neocodeSwarmChatParticipant.js';
import { NeocodeExternalEditWatcher } from './neocodeExternalEditWatcher.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import { NeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import {
	NeocodeSwarmActivityEditorInput,
	NeocodeSwarmActivityEditorPane,
	createActivityEditorInput,
} from './neocodeSwarmActivityPanel.js';

const NEOCODE_SETTINGS_MENU = MenuId.for('NeoCodeSettingsMenu');
const NEOCODE_GLOBAL_SETTINGS_MENU = MenuId.for('NeoCodeGlobalSettingsMenu');

// ─── Singleton services ───────────────────────────────────────────────────

registerSingleton(INeocodeSwarmSecretService, NeocodeSwarmSecretService, InstantiationType.Delayed);
registerSingleton(INeocodeSwarmStorageService, NeocodeSwarmStorageService, InstantiationType.Delayed);
registerSingleton(INeocodeSwarmActivityService, NeocodeSwarmActivityService, InstantiationType.Delayed);

// ─── Workbench contributions ──────────────────────────────────────────────

registerWorkbenchContribution2(NeocodeSwarmChatParticipant.ID, NeocodeSwarmChatParticipant, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(NeocodeExternalEditWatcher.ID, NeocodeExternalEditWatcher, WorkbenchPhase.AfterRestored);

// ─── Menus ────────────────────────────────────────────────────────────────

MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	title: localize('neoCodeMenu', "NeoCode"),
	submenu: NEOCODE_SETTINGS_MENU,
	group: '4_configuration',
	order: 6,
});

MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	title: localize('neoCodeMenuGlobal', "NeoCode"),
	submenu: NEOCODE_GLOBAL_SETTINGS_MENU,
	group: '3_configuration',
	order: 6,
});

// ─── Settings editor pane ─────────────────────────────────────────────────

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NeocodeSwarmSettingsEditor,
		NeocodeSwarmSettingsEditor.ID,
		localize('neocodeSwarmSettingsEditor', "Editor de Configuracoes do Enxame"),
	),
	[new SyncDescriptor(NeocodeSwarmSettingsEditorInput)],
);

class NeocodeSwarmSettingsEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof NeocodeSwarmSettingsEditorInput;
	}
	serialize(_editorInput: EditorInput): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(NeocodeSwarmSettingsEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NeocodeSwarmSettingsEditorInput.ID,
	NeocodeSwarmSettingsEditorSerializer,
);

// ─── Activity panel pane ──────────────────────────────────────────────────

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NeocodeSwarmActivityEditorPane,
		NeocodeSwarmActivityEditorPane.ID,
		localize('neocodeSwarmActivityEditor', "NeoCode Swarm Activity"),
	),
	[new SyncDescriptor(NeocodeSwarmActivityEditorInput)],
);

class NeocodeSwarmActivityEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof NeocodeSwarmActivityEditorInput;
	}
	serialize(_editorInput: EditorInput): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return createActivityEditorInput(instantiationService);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NeocodeSwarmActivityEditorInput.ID,
	NeocodeSwarmActivityEditorSerializer,
);

// ─── Actions ──────────────────────────────────────────────────────────────

registerAction2(class OpenNeoSwarmSettingsAction extends Action2 {
	constructor() {
		super({
			id: NEO_SWARM_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('neocodeOpenSwarmSettings', "NeoCode: Configurar Enxame de Agentes"),
			category: Categories.Preferences,
			icon: Codicon.settingsGear,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 1 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 1 },
				{ id: MenuId.TitleBar, group: '5_neocode', order: 1 },
				{ id: MenuId.LayoutControlMenu, group: 'neocode', order: 1 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(NeocodeSwarmSettingsEditorInput), { pinned: true });
	}
});

registerAction2(class OpenNeoSwarmActivityAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.openSwarmActivity',
			title: localize2('neocodeOpenSwarmActivity', "NeoCode: Abrir Painel de Atividade do Enxame"),
			category: Categories.Preferences,
			icon: Codicon.dashboard,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 2 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 2 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const input = createActivityEditorInput(instantiationService);
		await editorService.openEditor(input, { pinned: false, revealIfOpened: true });
	}
});
