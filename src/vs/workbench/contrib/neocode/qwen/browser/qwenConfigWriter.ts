/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../../base/common/buffer.js';
import { dirname, joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IQwenProviderConfig } from '../common/qwenTypes.js';

interface IQwenModelProviderEntry {
	id: string;
	name: string;
	envKey: string;
	baseUrl?: string;
}

interface IQwenSettings {
	security?: {
		auth?: {
			selectedType?: string;
		};
	};
	modelProviders?: Record<string, IQwenModelProviderEntry[]>;
	env?: Record<string, string>;
	model?: {
		name?: string;
	};
	neocode?: {
		qwen?: {
			displayName?: string;
			protocol?: string;
			baseUrl?: string;
			authType?: string;
		};
	};
	[key: string]: unknown;
}

export class QwenConfigWriter {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
	) { }

	async syncConfig(config: IQwenProviderConfig): Promise<void> {
		const targets = await this.getConfigTargets();
		for (const target of targets) {
			const current = await this.readSettings(target) ?? {};
			const next = this.mergeSettings(current, config);
			await this.writeSettings(target, next);
		}
	}

	async resetBrokenAuthState(): Promise<void> {
		const targets = await this.getConfigTargets();
		for (const target of targets) {
			const current = await this.readSettings(target);
			if (!current?.security?.auth || typeof current.security.auth !== 'object') {
				continue;
			}
			if (!('selectedType' in current.security.auth)) {
				continue;
			}
			delete current.security.auth.selectedType;
			await this.writeSettings(target, current);
		}
	}

	async hasBrokenAuthState(): Promise<boolean> {
		const targets = await this.getConfigTargets();
		for (const target of targets) {
			const current = await this.readSettings(target);
			if (current?.security?.auth?.selectedType) {
				return true;
			}
		}
		return false;
	}

	async removeGeneratedConfig(): Promise<void> {
		const targets = await this.getConfigTargets();
		for (const target of targets) {
			const current = await this.readSettings(target);
			if (!current) {
				continue;
			}
			if (current.neocode) {
				delete current.neocode;
				await this.writeSettings(target, current);
			}
		}
	}

	private mergeSettings(current: IQwenSettings, config: IQwenProviderConfig): IQwenSettings {
		// Build the provider entry in the format expected by the Qwen CLI:
		// modelProviders[protocol] = [{ id, name, envKey, baseUrl }]
		const providerEntry: IQwenModelProviderEntry = {
			id: config.modelId,
			name: config.displayName,
			envKey: config.envVarName,
			...(config.baseUrl ? { baseUrl: config.baseUrl } : {})
		};

		// Keep existing entries for this protocol that have different model IDs,
		// then upsert the current one.
		const existingEntries: IQwenModelProviderEntry[] = Array.isArray(current.modelProviders?.[config.protocol])
			? (current.modelProviders![config.protocol] as IQwenModelProviderEntry[])
			: [];
		const filteredEntries = existingEntries.filter(e => e.id !== config.modelId);
		const nextEntries = [providerEntry, ...filteredEntries];

		const nextModelProviders: Record<string, IQwenModelProviderEntry[]> = {
			...(current.modelProviders ?? {}),
			[config.protocol]: nextEntries
		};

		// Write the env section so the CLI can pick up the API key from settings
		// (only for apiKey auth; for oauth the key is managed by the CLI itself)
		const nextEnv: Record<string, string> = { ...(current.env ?? {}) };
		if (config.authType === 'apiKey' && config.envVarName) {
			// Leave a placeholder so the user knows which var to set — the actual
			// value is injected at runtime from the VSCode secret store.
			if (!nextEnv[config.envVarName]) {
				nextEnv[config.envVarName] = '';
			}
		}

		return {
			...current,
			security: {
				...(current.security ?? {}),
				auth: {
					...(current.security?.auth ?? {}),
					selectedType: config.authType === 'qwen-oauth' ? 'qwen-oauth' : config.protocol
				}
			},
			modelProviders: nextModelProviders,
			env: nextEnv,
			model: {
				...(current.model ?? {}),
				name: config.modelId
			},
			neocode: {
				...(current.neocode ?? {}),
				qwen: {
					displayName: config.displayName,
					protocol: config.protocol,
					baseUrl: config.baseUrl,
					authType: config.authType
				}
			}
		};
	}

	private async getConfigTargets(): Promise<URI[]> {
		const userHome = await this.pathService.userHome();
		const userSettings = joinPath(userHome, '.qwen', 'settings.json');
		const targets = [userSettings];
		const firstFolder = this.workspaceContextService.getWorkspace().folders[0]?.uri;
		if (firstFolder) {
			targets.push(joinPath(firstFolder, '.qwen', 'settings.json'));
		}
		return targets;
	}

	private async readSettings(resource: URI): Promise<IQwenSettings | undefined> {
		try {
			const content = await this.fileService.readFile(resource);
			return JSON.parse(content.value.toString()) as IQwenSettings;
		} catch (error) {
			this.logService.debug('[neocode qwen] cannot read settings', resource.toString(), error);
			return undefined;
		}
	}

	private async writeSettings(resource: URI, settings: IQwenSettings): Promise<void> {
		await this.fileService.createFolder(dirname(resource));
		await this.fileService.writeFile(resource, VSBuffer.fromString(`${JSON.stringify(settings, null, 2)}\n`));
	}
}
