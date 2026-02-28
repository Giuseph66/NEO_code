/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import {
	createDefaultNeocodeSwarmConfig,
	INeocodeSwarmCapabilitiesConfig,
	INeocodeSwarmCommandConfig,
	INeocodeSwarmConfig,
	INeocodeSwarmHookConfig,
	INeocodeSwarmPersonalityConfig,
	INeocodeSwarmProviderConfig,
	INeocodeSwarmSkillConfig,
	NeocodeSwarmAuthMethod,
	NeocodeSwarmProviderType,
	NEO_SWARM_STORAGE_KEY
} from '../common/neocodeSwarmTypes.js';
import { INeocodeSwarmStorageService } from '../common/neocodeSwarmStorage.js';

export class NeocodeSwarmStorageService extends Disposable implements INeocodeSwarmStorageService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IStorageService private readonly storageService: IStorageService
	) {
		super();
	}

	load(): INeocodeSwarmConfig {
		const value = this.storageService.get(NEO_SWARM_STORAGE_KEY, StorageScope.PROFILE);
		if (!value) {
			return createDefaultNeocodeSwarmConfig();
		}

		try {
			const parsed = JSON.parse(value) as Partial<INeocodeSwarmConfig>;
			const fallback = createDefaultNeocodeSwarmConfig();
			if (parsed.version !== 1) {
				return fallback;
			}

			const normalizedProviders = this.normalizeProviders(Array.isArray(parsed.providers) ? parsed.providers : fallback.providers, fallback.providers);
			const remappedProviderIdByLegacyId = normalizedProviders.remappedProviderIdByLegacyId;

			return {
				...fallback,
				...parsed,
				providers: normalizedProviders.providers,
				agents: (Array.isArray(parsed.agents) ? parsed.agents : fallback.agents).map(a => ({
					...a,
					providerId: remappedProviderIdByLegacyId.get(a.providerId ?? '') ?? a.providerId,
					skills: a.skills ?? []
				})),
				orchestrator: {
					...fallback.orchestrator,
					...(parsed.orchestrator ?? {}),
					providerId: remappedProviderIdByLegacyId.get(parsed.orchestrator?.providerId ?? '') ?? parsed.orchestrator?.providerId
				},
				security: {
					...fallback.security,
					...(parsed.security ?? {})
				},
				advanced: {
					...fallback.advanced,
					...(parsed.advanced ?? {})
				},
				capabilities: this.normalizeCapabilities(parsed.capabilities, fallback.capabilities)
			};
		} catch {
			return createDefaultNeocodeSwarmConfig();
		}
	}

	save(config: INeocodeSwarmConfig): void {
		this.storageService.store(
			NEO_SWARM_STORAGE_KEY,
			JSON.stringify(config),
			StorageScope.PROFILE,
			StorageTarget.USER
		);
	}

	private normalizeProviders(inputProviders: readonly INeocodeSwarmProviderConfig[], fallbackProviders: readonly INeocodeSwarmProviderConfig[]): { providers: INeocodeSwarmProviderConfig[]; remappedProviderIdByLegacyId: Map<string, string> } {
		const canonicalByType = new Map<NeocodeSwarmProviderType, INeocodeSwarmProviderConfig>();
		for (const provider of fallbackProviders) {
			canonicalByType.set(provider.type, provider);
		}

		const remappedProviderIdByLegacyId = new Map<string, string>();
		const mergedByKey = new Map<string, INeocodeSwarmProviderConfig>();
		for (const rawProvider of inputProviders) {
			const provider = rawProvider as INeocodeSwarmProviderConfig & { defaultModel?: string };
			const legacyType = (rawProvider as { type?: string }).type;

			// Proactively purge legacy Copilot provider.
			if (provider.id === 'copilot' || legacyType === 'copilot' || provider.name === 'Copilot') {
				continue;
			}

			const normalizedType = normalizeProviderType(provider.type);
			const key = normalizedType === 'custom' ? (provider.id || 'custom') : normalizedType;
			const canonical = canonicalByType.get(normalizedType);
			const existing = mergedByKey.get(key);

			let normalizedModels = uniqueStrings([
				...(provider.models ?? []),
				...(provider.defaultModel ? [provider.defaultModel] : []),
				...(canonical?.models ?? [])
			]);
			let selectedModel = provider.selectedModel ?? provider.defaultModel ?? existing?.selectedModel ?? canonical?.selectedModel ?? normalizedModels[0];
			const nextAuthMethod = mergeAuthMethod(existing?.authMethod, normalizeAuthMethod(provider.authMethod), canonical?.authMethod);

			if (normalizedType === 'qwen-code' && nextAuthMethod === 'qwen-oauth') {
				normalizedModels = uniqueStrings(
					normalizedModels.map(normalizeQwenOAuthModel)
				);
				if (!normalizedModels.length) {
					normalizedModels = ['coder-model', 'vision-model'];
				}
				const mappedSelectedModel = normalizeQwenOAuthModel(selectedModel ?? '');
				selectedModel = normalizedModels.includes(mappedSelectedModel) ? mappedSelectedModel : normalizedModels[0];
			}

			const merged: INeocodeSwarmProviderConfig = {
				id: existing?.id ?? (normalizedType === 'custom' ? provider.id : canonical?.id ?? provider.id),
				type: normalizedType,
				name: existing?.name ?? (normalizedType === 'custom' ? (provider.name || 'Custom') : canonical?.name ?? normalizeProviderName(normalizedType)),
				authMethod: nextAuthMethod,
				enabled: (existing?.enabled ?? false) || (provider.enabled ?? false),
				models: normalizedModels,
				selectedModel: normalizedModels.includes(selectedModel ?? '') ? selectedModel : normalizedModels[0],
				baseUrl: normalizedType === 'custom' ? (provider.baseUrl || existing?.baseUrl) : undefined,
				soulRule: provider.soulRule ?? existing?.soulRule ?? '',
				status: mergeProviderStatus(existing?.status, provider.status),
				statusMessage: provider.statusMessage ?? existing?.statusMessage,
				cliAuthEnabled: provider.cliAuthEnabled ?? existing?.cliAuthEnabled
			};

			mergedByKey.set(key, merged);
			if (provider.id) {
				remappedProviderIdByLegacyId.set(provider.id, merged.id);
			}
		}

		// Ensure base families always exist.
		for (const canonicalType of ['gemini', 'openai', 'anthropic', 'qwen-code'] as const) {
			if (!mergedByKey.has(canonicalType) && canonicalByType.has(canonicalType)) {
				const fallback = canonicalByType.get(canonicalType)!;
				mergedByKey.set(canonicalType, { ...fallback, models: [...fallback.models] });
			}
		}

		return {
			providers: [...mergedByKey.values()],
			remappedProviderIdByLegacyId
		};
	}

	private normalizeCapabilities(parsedCapabilities: Partial<INeocodeSwarmCapabilitiesConfig> | undefined, fallback: INeocodeSwarmCapabilitiesConfig): INeocodeSwarmCapabilitiesConfig {
		const parsed = parsedCapabilities ?? {};

		const inputPersonalities = Array.isArray(parsed.personalities) ? parsed.personalities as INeocodeSwarmPersonalityConfig[] : [];
		const inputSkills = Array.isArray(parsed.skills) ? parsed.skills as INeocodeSwarmSkillConfig[] : [];
		const inputHooks = Array.isArray(parsed.hooks) ? parsed.hooks as INeocodeSwarmHookConfig[] : [];
		const inputCommands = Array.isArray(parsed.commands) ? parsed.commands as INeocodeSwarmCommandConfig[] : [];

		return {
			personalities: mergeCapabilitiesWithFallback(inputPersonalities, fallback.personalities, ['sourcePath']),
			skills: mergeCapabilitiesWithFallback(inputSkills, fallback.skills, ['instructionPath']),
			hooks: mergeCapabilitiesWithFallback(inputHooks, fallback.hooks, ['scriptPath']),
			commands: mergeCapabilitiesWithFallback(inputCommands, fallback.commands, ['executablePath'])
		};
	}

}

function normalizeProviderType(rawType: string): NeocodeSwarmProviderType {
	const type = (rawType || '').toLowerCase();
	if (type === 'custom') {
		return 'custom';
	}
	if (type.includes('gemini')) {
		return 'gemini';
	}
	if (type.includes('openai') || type.includes('chatgpt') || type.includes('codex')) {
		return 'openai';
	}
	if (type.includes('qwen')) {
		return 'qwen-code';
	}
	if (type.includes('anthropic') || type.includes('claude') || type.includes('cloud')) {
		return 'anthropic';
	}
	return 'custom';
}



function normalizeAuthMethod(method: string | undefined): NeocodeSwarmAuthMethod {
	if (method === 'apiKey' || method === 'login' || method === 'cliToken' || method === 'qwen-oauth') {
		return method;
	}
	return 'login';
}

function mergeAuthMethod(a: NeocodeSwarmAuthMethod | undefined, b: NeocodeSwarmAuthMethod, c: NeocodeSwarmAuthMethod | undefined): NeocodeSwarmAuthMethod {
	const options = [a, b, c];
	if (options.includes('apiKey')) {
		return 'apiKey';
	}
	if (options.includes('qwen-oauth')) {
		return 'qwen-oauth';
	}
	if (options.includes('login')) {
		return 'login';
	}
	return 'cliToken';
}

function mergeProviderStatus(a: INeocodeSwarmProviderConfig['status'], b: INeocodeSwarmProviderConfig['status']): INeocodeSwarmProviderConfig['status'] {
	if (a === 'connected' || b === 'connected') {
		return 'connected';
	}
	if (a === 'error' || b === 'error') {
		return 'error';
	}
	return 'notConfigured';
}

function normalizeProviderName(type: NeocodeSwarmProviderType): string {
	switch (type) {
		case 'gemini': return 'Gemini';
		case 'openai': return 'OpenAI';
		case 'anthropic': return 'Anthropic';
		case 'qwen-code': return 'Qwen Code';
		default: return 'Custom';
	}
}

function uniqueStrings(values: readonly string[]): string[] {
	const result: string[] = [];
	for (const value of values) {
		const normalized = value.trim();
		if (!normalized || result.includes(normalized)) {
			continue;
		}
		result.push(normalized);
	}
	return result;
}

function normalizeQwenOAuthModel(model: string): string {
	const value = model.trim().toLowerCase();
	if (!value) {
		return 'coder-model';
	}
	if (value === 'coder-model' || value === 'vision-model') {
		return value;
	}
	if (/(vision|vl|image|multimodal|qvq)/.test(value)) {
		return 'vision-model';
	}
	return 'coder-model';
}

function mergeCapabilityLists<T extends { id: string }>(input: readonly T[], fallback: readonly T[], keyFn: (item: T) => string): T[] {
	const result: T[] = [];
	const seen = new Set<string>();

	const push = (item: T) => {
		const key = keyFn(item);
		if (!key || seen.has(key)) {
			return;
		}
		seen.add(key);
		result.push(item);
	};

	for (const item of input) {
		push(item);
	}
	for (const item of fallback) {
		push(item);
	}

	return result;
}

function normalizeKey(value: string): string {
	return value.trim().toLowerCase();
}

function mergeCapabilitiesWithFallback<T extends { id: string; name: string }>(
	input: readonly T[],
	fallback: readonly T[],
	pathKeys: (keyof T)[]
): T[] {
	const fallbackByName = new Map<string, T>();
	const fallbackByPath = new Map<string, T>();

	for (const item of fallback) {
		const byName = normalizeKey(item.name);
		if (byName) {
			fallbackByName.set(byName, item);
		}

		for (const pathKey of pathKeys) {
			const pathVal = normalizeKey((item[pathKey] as string) ?? '');
			if (pathVal) {
				fallbackByPath.set(pathVal, item);
				// Also store without ${workspaceFolder}/ to match legacy paths
				if (pathVal.startsWith('${workspacefolder}/')) {
					fallbackByPath.set(pathVal.substring('${workspacefolder}/'.length), item);
				}
			}
		}
	}

	const enrichedInput = input.map(item => {
		let reference: T | undefined;

		for (const pathKey of pathKeys) {
			const pathVal = normalizeKey((item[pathKey] as string) ?? '');
			if (pathVal && fallbackByPath.has(pathVal)) {
				reference = fallbackByPath.get(pathVal);
				break;
			}
		}

		if (!reference) {
			const byName = normalizeKey(item.name);
			reference = fallbackByName.get(byName);
		}

		if (!reference) {
			return item;
		}

		const enriched = { ...item };
		for (const key in reference) {
			if (enriched[key] === undefined || enriched[key] === null || enriched[key] === '') {
				enriched[key] = reference[key];
			}
		}

		for (const pathKey of pathKeys) {
			const oldPath = enriched[pathKey] as string | undefined;
			const refPath = reference[pathKey] as string | undefined;

			if (oldPath && refPath && refPath.startsWith('${workspaceFolder}/') && oldPath === refPath.replace('${workspaceFolder}/', '')) {
				enriched[pathKey] = refPath as any;
			}
		}

		return enriched;
	});

	return mergeCapabilityLists(enrichedInput, fallback, item => {
		for (const pathKey of pathKeys) {
			const pathVal = normalizeKey((item[pathKey] as string) ?? '');
			if (pathVal) {
				return pathVal;
			}
		}
		return normalizeKey(item.name);
	});
}
