/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INeocodeSwarmProviderConfig, INeocodeSwarmConfig } from '../common/neocodeSwarmTypes.js';
import { INeocodeSwarmSecretService, INeocodeSwarmStorageService } from '../common/neocodeSwarmStorage.js';
import { IGeminiAuthService } from '../../neocode/gemini/common/geminiTypes.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { IQwenOAuthWorkerPostResult, IQwenOAuthWorkerService as IQwenOAuthUtilityProcessWorkerService, NEO_QWEN_OAUTH_WORKER_CHANNEL } from '../../neocode/qwen/common/qwenOAuthWorkerTypes.js';
import { isOpenAITokenExpiredOrNearExpiry, parseStoredOpenAITokenBundle, refreshOpenAITokenBundle } from './neocodeSwarmOpenAIOAuthController.js';

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): unknown };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

interface IResolvedProviderCredential {
	provider: INeocodeSwarmProviderConfig;
	token: string;
	extraEnv?: Record<string, string>;
}

const DEFAULT_QWEN_OAUTH_RESOURCE_URL = 'https://dashscope.aliyuncs.com/compatible-mode';
const QWEN_OAUTH_CODER_MODEL = 'coder-model';
const QWEN_OAUTH_VISION_MODEL = 'vision-model';
const MAX_RESPONSE_SNIPPET = 700;

export class NeocodeSwarmVoiceTranscriptionService extends Disposable {

	constructor(
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
	}

	async transcribeAudio(audioBlob: Blob): Promise<string> {
		if (!audioBlob || audioBlob.size <= 0) {
			throw new Error(localize('neoVoiceTranscription.emptyAudio', 'Audio vazio. Grave novamente.'));
		}

		const resolved = await this.resolveOrchestratorCredential();
		const model = this.resolveOrchestratorModel(resolved.provider, this.storageService.load());
		this.logService.info(`[neocode voice] transcribing with provider=${resolved.provider.name} (${resolved.provider.type}/${resolved.provider.authMethod}) model=${model}`);

		switch (resolved.provider.type) {
			case 'gemini': {
				return this.transcribeWithGemini(resolved.provider, resolved.token, model, audioBlob);
			}
			case 'anthropic': {
				throw new Error(localize('neoVoiceTranscription.anthropicUnsupported', 'Transcricao de audio nao esta disponivel para Anthropic neste fluxo. Use OpenAI, Gemini ou Qwen Code.'));
			}
			case 'openai':
			case 'custom':
			case 'qwen-code': {
				return this.transcribeWithOpenAICompatible(resolved.provider, resolved.token, model, audioBlob, resolved.extraEnv);
			}
		}
	}

	private async resolveOrchestratorCredential(): Promise<IResolvedProviderCredential> {
		const config = this.storageService.load();
		const enabledProviders = config.providers.filter(provider => provider.enabled);
		if (enabledProviders.length === 0) {
			throw new Error(localize('neoVoiceTranscription.noProviders', 'Nenhum provedor habilitado no enxame.'));
		}

		const orchestratorProvider = enabledProviders.find(provider => provider.id === config.orchestrator.providerId);
		if (!orchestratorProvider) {
			throw new Error(localize('neoVoiceTranscription.orchestratorProviderDisabled', 'O provedor configurado no orquestrador nao esta habilitado no enxame.'));
		}

		const token = await this.resolveProviderToken(orchestratorProvider);
		if (!token?.token?.trim()) {
			throw new Error(localize(
				'neoVoiceTranscription.orchestratorCredentialMissing',
				'O provedor do orquestrador ({0}) nao possui credencial valida para transcrever audio.',
				orchestratorProvider.name
			));
		}

		return {
			provider: orchestratorProvider,
			token: token.token,
			extraEnv: token.extraEnv,
		};
	}

	private resolveOrchestratorModel(provider: INeocodeSwarmProviderConfig, config: INeocodeSwarmConfig): string {
		const configuredModel = config.orchestrator.providerId === provider.id
			? config.orchestrator.model?.trim()
			: undefined;
		const providerModel = provider.selectedModel?.trim() || provider.models[0]?.trim();
		const rawModel = configuredModel || providerModel || 'default';

		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			return this.normalizeQwenOAuthModel(rawModel);
		}

		return rawModel;
	}

	private async resolveProviderToken(provider: INeocodeSwarmProviderConfig): Promise<{ token: string; extraEnv?: Record<string, string> } | undefined> {
		if (provider.type === 'gemini') {
			try {
				const runtimeEnv = await this.geminiAuthService.buildRuntimeEnv();
				const token = runtimeEnv.env['GEMINI_API_KEY'] ?? runtimeEnv.env['GOOGLE_API_KEY'];
				if (token?.trim()) {
					return { token: token.trim() };
				}
			} catch (error) {
				this.logService.warn('[neocode voice] failed to resolve Gemini credentials:', error);
			}
		}

		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			try {
				const envData = await this.qwenAuthService.buildRuntimeEnv();
				const qwenConfig = this.qwenAuthService.loadConfig();
				const token = envData.env[qwenConfig.envVarName];
				if (token?.trim()) {
					return {
						token: token.trim(),
						extraEnv: envData.env,
					};
				}
			} catch (error) {
				this.logService.warn('[neocode voice] failed to resolve Qwen credentials:', error);
			}
		}

		if (provider.type === 'openai' && provider.authMethod === 'login') {
			const openAI = await this.resolveOpenAILoginToken(provider);
			if (openAI?.trim()) {
				return { token: openAI.trim() };
			}
		}

		const scope = this.providerSecretScope(provider);
		const storageCandidates = scope !== provider.id ? [scope, provider.id] : [scope];
		for (const kind of ['apiKey', 'loginToken', 'cliToken'] as const) {
			for (const storageKey of storageCandidates) {
				const value = await this.secretService.getProviderSecret(storageKey, kind);
				if (!value?.trim()) {
					continue;
				}
				if (value.trim().startsWith('{')) {
					continue;
				}
				return { token: value.trim() };
			}
		}

		return undefined;
	}

	private async resolveOpenAILoginToken(provider: INeocodeSwarmProviderConfig): Promise<string | undefined> {
		const scope = this.providerSecretScope(provider);
		for (const storageKey of [scope, provider.id]) {
			for (const kind of ['loginToken', 'apiKey'] as const) {
				const raw = await this.secretService.getProviderSecret(storageKey, kind);
				if (!raw?.trim()) {
					continue;
				}
				if (!raw.trim().startsWith('{')) {
					return raw.trim();
				}
				const bundle = parseStoredOpenAITokenBundle(raw);
				if (!bundle?.accessToken) {
					continue;
				}
				if (!isOpenAITokenExpiredOrNearExpiry(bundle)) {
					return bundle.accessToken;
				}
				try {
					const refreshed = await refreshOpenAITokenBundle(bundle);
					return refreshed.accessToken;
				} catch {
					return bundle.accessToken;
				}
			}
		}
		return undefined;
	}

	private providerSecretScope(provider: INeocodeSwarmProviderConfig): string {
		return provider.type === 'custom' ? provider.id : provider.type;
	}

	private async transcribeWithOpenAICompatible(
		provider: INeocodeSwarmProviderConfig,
		apiKey: string,
		model: string,
		audioBlob: Blob,
		extraEnv?: Record<string, string>,
	): Promise<string> {
		const baseUrl = this.resolveOpenAICompatibleBaseUrl(provider, extraEnv);
		if (!baseUrl) {
			throw new Error(localize('neoVoiceTranscription.baseUrlMissing', 'Base URL do provedor nao configurada para transcricao.'));
		}

		const endpoint = this.buildEndpointUrl(baseUrl, '/audio/transcriptions');
		const fileName = this.inferAudioFileName(audioBlob.type);
		const authHeader = { Authorization: `Bearer ${apiKey}` };

		let response: IQwenOAuthWorkerPostResult | undefined;
		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			response = await this.postMultipartViaQwenWorker({
				url: endpoint,
				fileBase64: await this.blobToBase64(audioBlob),
				fileName,
				fileMimeType: audioBlob.type || 'audio/webm',
				fields: {
					model,
				},
				headers: authHeader,
			});
		} else {
			const formData = new FormData();
			formData.append('file', audioBlob, fileName);
			formData.append('model', model);
			const fetchResponse = await fetch(endpoint, {
				method: 'POST',
				headers: authHeader,
				body: formData,
			});
			response = {
				statusCode: fetchResponse.status,
				body: await fetchResponse.text(),
			};
		}

		if (response.statusCode < 200 || response.statusCode >= 300) {
			if (this.isMissingModelRequestScopeError(response.statusCode, response.body)) {
				throw new Error(localize(
					'neoVoiceTranscription.missingScope',
					'A credencial do provedor nao tem permissao para transcricao neste endpoint (scope `model.request`). Configure uma credencial/API key com esse escopo no projeto/organizacao.'
				));
			}
			if (this.shouldTryChatAudioFallback(response.statusCode, response.body)) {
				this.logService.info('[neocode voice] /audio/transcriptions unavailable, trying multimodal fallback via /chat/completions');
				try {
					return await this.transcribeWithOpenAICompatibleChatAudio(provider, apiKey, model, audioBlob, baseUrl);
				} catch (chatFallbackError) {
					throw new Error(localize(
						'neoVoiceTranscription.audioEndpointUnsupportedWithFallbackError',
						'Falha na transcricao direta (/audio/transcriptions) e na tentativa multimodal via chat. Erro direto: {0} | Erro fallback: {1}',
						this.truncate(response.body),
						this.truncate(chatFallbackError instanceof Error ? chatFallbackError.message : String(chatFallbackError))
					));
				}
			}
			throw new Error(`HTTP ${response.statusCode}: ${this.truncate(response.body)}`);
		}

		const parsed = this.safeParseJson(response.body);
		const text = this.extractTranscriptionText(parsed);
		if (!text) {
			throw new Error(localize('neoVoiceTranscription.emptyResult', 'A transcricao retornou vazia.'));
		}
		return text;
	}

	private shouldTryChatAudioFallback(statusCode: number, body: string): boolean {
		if (statusCode >= 400 && statusCode < 500) {
			if (/audio\/transcriptions/i.test(body)) {
				return true;
			}
			if (/invalid\s*url/i.test(body)) {
				return true;
			}
			if (/unsupported|not supported|unknown endpoint/i.test(body)) {
				return true;
			}
		}
		return false;
	}

	private isMissingModelRequestScopeError(statusCode: number, body: string): boolean {
		if (statusCode !== 401 && statusCode !== 403) {
			return false;
		}
		return /model\.request/i.test(body)
			|| /missing scopes/i.test(body)
			|| /insufficient permissions/i.test(body);
	}

	private async transcribeWithOpenAICompatibleChatAudio(
		provider: INeocodeSwarmProviderConfig,
		apiKey: string,
		model: string,
		audioBlob: Blob,
		baseUrl: string,
	): Promise<string> {
		const endpoint = this.buildEndpointUrl(baseUrl, '/chat/completions');
		const payload = {
			model,
			temperature: 0,
			stream: false,
			messages: [
				{
					role: 'user',
					content: [
						{
							type: 'text',
							text: 'Transcreva fielmente o audio em portugues do Brasil. Responda apenas com a transcricao.',
						},
						{
							type: 'input_audio',
							input_audio: {
								data: await this.blobToBase64(audioBlob),
								format: this.inferAudioInputFormat(audioBlob.type),
							},
						},
					],
				},
			],
		};

		const response = await this.postOpenAICompatibleJson(provider, endpoint, apiKey, payload);
		if (response.statusCode < 200 || response.statusCode >= 300) {
			if (this.isMissingModelRequestScopeError(response.statusCode, response.body)) {
				throw new Error(localize(
					'neoVoiceTranscription.missingScopeChatFallback',
					'A credencial atual nao possui permissao `model.request` para inferencia no chat/completions.'
				));
			}
			throw new Error(`HTTP ${response.statusCode}: ${this.truncate(response.body)}`);
		}

		const parsed = this.safeParseJson(response.body);
		const text = this.extractTranscriptionText(parsed);
		if (!text) {
			throw new Error(localize('neoVoiceTranscription.emptyChatAudioResult', 'A transcricao multimodal retornou vazia.'));
		}
		return text;
	}

	private async postOpenAICompatibleJson(
		provider: INeocodeSwarmProviderConfig,
		endpoint: string,
		apiKey: string,
		payload: unknown,
	): Promise<IQwenOAuthWorkerPostResult> {
		const headers = {
			Authorization: `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		};
		const body = JSON.stringify(payload);

		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			let utilityProcessService: IUtilityProcessWorkerServiceLike;
			try {
				const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
				utilityProcessService = this.instantiationService.invokeFunction(
					(accessor: any) => accessor.get(module.IUtilityProcessWorkerWorkbenchService)
				) as IUtilityProcessWorkerServiceLike;
			} catch (error) {
				throw new Error(`Worker indisponivel para requisicao JSON Qwen OAuth: ${error}`);
			}

			const worker = await utilityProcessService.createWorker({
				moduleId: 'vs/workbench/contrib/neocode/qwen/node/qwenOAuthWorkerMain',
				type: 'qwenOAuth',
				name: 'NeoCode Qwen OAuth Worker',
			});

			const service = ProxyChannel.toService<IQwenOAuthUtilityProcessWorkerService>(
				worker.client.getChannel(NEO_QWEN_OAUTH_WORKER_CHANNEL as string) as any
			);

			try {
				return await service.post({ url: endpoint, body, headers });
			} finally {
				worker.dispose();
			}
		}

		const response = await fetch(endpoint, {
			method: 'POST',
			headers,
			body,
		});
		return {
			statusCode: response.status,
			body: await response.text(),
		};
	}

	private async transcribeWithGemini(
		provider: INeocodeSwarmProviderConfig,
		apiKey: string,
		model: string,
		audioBlob: Blob,
	): Promise<string> {
		const baseUrl = (provider.baseUrl?.trim() || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
		const endpoint = `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Accept': 'application/json',
			},
			body: JSON.stringify({
				contents: [{
					role: 'user',
					parts: [
						{ text: 'Transcreva o audio em texto claro em portugues do Brasil. Responda apenas com a transcricao.' },
						{
							inlineData: {
								mimeType: audioBlob.type || 'audio/webm',
								data: await this.blobToBase64(audioBlob),
							},
						},
					],
				}],
				generationConfig: {
					temperature: 0,
				},
			}),
		});

		const rawBody = await response.text();
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}: ${this.truncate(rawBody)}`);
		}

		const parsed = this.safeParseJson(rawBody);
		const text = this.extractGeminiText(parsed);
		if (!text) {
			throw new Error(localize('neoVoiceTranscription.emptyGeminiResult', 'Gemini nao retornou texto de transcricao.'));
		}
		return text;
	}

	private resolveOpenAICompatibleBaseUrl(provider: INeocodeSwarmProviderConfig, extraEnv?: Record<string, string>): string {
		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			// For Qwen OAuth, always prioritize the resource URL from the OAuth credentials.
			// Some manually configured base URLs (e.g. chat-focused gateways) don't expose
			// /audio/transcriptions and cause "Invalid URL (POST /v1/audio/transcriptions)".
			const resourceUrl = (extraEnv?.['QWEN_OAUTH_RESOURCE_URL'] || DEFAULT_QWEN_OAUTH_RESOURCE_URL).trim();
			const normalizedUrl = this.normalizeOpenAIBaseUrlCandidate(this.toAbsoluteHttpUrl(resourceUrl)) || DEFAULT_QWEN_OAUTH_RESOURCE_URL;

			const explicitBaseUrl = provider.baseUrl?.trim();
			if (explicitBaseUrl && this.normalizeOpenAIBaseUrlCandidate(this.toAbsoluteHttpUrl(explicitBaseUrl)) !== normalizedUrl) {
				this.logService.info(`[neocode voice] qwen-oauth: using OAuth resource URL for transcription base (${normalizedUrl}) instead of provider.baseUrl (${explicitBaseUrl})`);
			}

			return normalizedUrl.endsWith('/v1') ? normalizedUrl : `${normalizedUrl}/v1`;
		}

		const explicitBaseUrl = provider.baseUrl?.trim();
		if (explicitBaseUrl) {
			const normalized = this.normalizeOpenAIBaseUrlCandidate(this.toAbsoluteHttpUrl(explicitBaseUrl));
			if (!normalized) {
				this.logService.warn(`[neocode voice] ignoring invalid provider.baseUrl="${explicitBaseUrl}" for ${provider.name}`);
			}
			const withoutTrailingSlash = normalized?.replace(/\/+$/, '');
			if (withoutTrailingSlash) {
				return withoutTrailingSlash;
			}
		}

		switch (provider.type) {
			case 'openai':
				return 'https://api.openai.com/v1';
			case 'qwen-code': {
				return 'https://dashscope.aliyuncs.com/compatible-mode/v1';
			}
			case 'custom':
				return '';
			default:
				return 'https://api.openai.com/v1';
		}
	}

	private normalizeQwenOAuthModel(model: string): string {
		const raw = (model || '').trim();
		if (!raw) {
			return QWEN_OAUTH_CODER_MODEL;
		}

		const lower = raw.toLowerCase();
		if (lower === QWEN_OAUTH_CODER_MODEL || lower === QWEN_OAUTH_VISION_MODEL) {
			return lower;
		}
		if (/(vision|vl|image|multimodal|qvq)/.test(lower)) {
			return QWEN_OAUTH_VISION_MODEL;
		}
		if (
			lower.includes('coder') ||
			lower.includes('code') ||
			lower.startsWith('qwen3') ||
			lower.startsWith('qwen2')
		) {
			return QWEN_OAUTH_CODER_MODEL;
		}
		return QWEN_OAUTH_CODER_MODEL;
	}

	private normalizeOpenAIBaseUrlCandidate(absoluteUrl: string | undefined): string | undefined {
		if (!absoluteUrl) {
			return undefined;
		}

		try {
			const parsed = new URL(absoluteUrl);
			let pathname = parsed.pathname.replace(/\/+$/, '');

			const endpointSuffixes = ['/chat/completions', '/audio/transcriptions', '/responses'];
			for (const suffix of endpointSuffixes) {
				if (pathname.toLowerCase().endsWith(suffix)) {
					pathname = pathname.slice(0, -suffix.length) || '/';
					break;
				}
			}

			parsed.pathname = pathname;
			return parsed.toString().replace(/\/+$/, '');
		} catch {
			return undefined;
		}
	}

	private toAbsoluteHttpUrl(input: string): string | undefined {
		const raw = input.trim();
		if (!raw) {
			return undefined;
		}

		const candidate = /^https?:\/\//i.test(raw)
			? raw
			: raw.startsWith('/')
				? undefined
				: `https://${raw.replace(/^\/+/, '')}`;
		if (!candidate) {
			return undefined;
		}

		try {
			const parsed = new URL(candidate);
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return undefined;
			}
			return parsed.toString().replace(/\/+$/, '');
		} catch {
			return undefined;
		}
	}

	private buildEndpointUrl(baseUrl: string, endpointPath: string): string {
		try {
			return new URL(endpointPath.replace(/^\/+/, ''), `${baseUrl.replace(/\/+$/, '')}/`).toString();
		} catch {
			throw new Error(localize('neoVoiceTranscription.invalidBaseUrl', 'Base URL invalida para transcricao: {0}', baseUrl));
		}
	}

	private async postMultipartViaQwenWorker(options: {
		url: string;
		fileBase64: string;
		fileName: string;
		fileMimeType: string;
		fields: Record<string, string>;
		headers?: Record<string, string>;
	}): Promise<IQwenOAuthWorkerPostResult> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			utilityProcessService = this.instantiationService.invokeFunction(
				(accessor: any) => accessor.get(module.IUtilityProcessWorkerWorkbenchService)
			) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(`Worker indisponivel para transcricao Qwen OAuth: ${error}`);
		}

		const worker = await utilityProcessService.createWorker({
			moduleId: 'vs/workbench/contrib/neocode/qwen/node/qwenOAuthWorkerMain',
			type: 'qwenOAuth',
			name: 'NeoCode Qwen OAuth Worker',
		});

		const service = ProxyChannel.toService<IQwenOAuthUtilityProcessWorkerService>(
			worker.client.getChannel(NEO_QWEN_OAUTH_WORKER_CHANNEL as string) as any
		);

		try {
			if (!service.postMultipartBase64) {
				throw new Error('Worker nao suporta postMultipartBase64.');
			}
			return await service.postMultipartBase64(options);
		} finally {
			worker.dispose();
		}
	}

	private extractTranscriptionText(payload: unknown): string | undefined {
		if (!payload || typeof payload !== 'object') {
			return undefined;
		}

		const directText = this.readStringField(payload, 'text')
			|| this.readStringField(payload, 'transcript')
			|| this.readStringField(payload, 'output_text');
		if (directText) {
			return directText;
		}

		const choices = (payload as { choices?: Array<{ text?: string; message?: { content?: string } }> }).choices;
		if (Array.isArray(choices)) {
			for (const choice of choices) {
				const content = choice?.message?.content ?? choice?.text;
				if (typeof content === 'string' && content.trim().length > 0) {
					return content.trim();
				}
				if (Array.isArray(content)) {
					const parts = content
						.map(part => {
							if (!part || typeof part !== 'object') {
								return '';
							}
							const text = (part as { text?: unknown }).text;
							return typeof text === 'string' ? text.trim() : '';
						})
						.filter(Boolean);
					if (parts.length > 0) {
						return parts.join('\n').trim();
					}
				}
			}
		}

		return this.extractGeminiText(payload);
	}

	private extractGeminiText(payload: unknown): string | undefined {
		const candidates = (payload as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates;
		if (!Array.isArray(candidates)) {
			return undefined;
		}

		const allParts: string[] = [];
		for (const candidate of candidates) {
			for (const part of candidate.content?.parts ?? []) {
				if (typeof part.text === 'string' && part.text.trim().length > 0) {
					allParts.push(part.text.trim());
				}
			}
		}

		if (allParts.length === 0) {
			return undefined;
		}
		return allParts.join('\n').trim();
	}

	private readStringField(payload: unknown, key: string): string | undefined {
		if (!payload || typeof payload !== 'object') {
			return undefined;
		}
		const value = (payload as Record<string, unknown>)[key];
		if (typeof value !== 'string') {
			return undefined;
		}
		const normalized = value.trim();
		return normalized.length > 0 ? normalized : undefined;
	}

	private safeParseJson(raw: string): unknown {
		try {
			return JSON.parse(raw);
		} catch {
			return { text: raw };
		}
	}

	private truncate(value: string): string {
		const trimmed = value.trim();
		if (trimmed.length <= MAX_RESPONSE_SNIPPET) {
			return trimmed;
		}
		return `${trimmed.slice(0, MAX_RESPONSE_SNIPPET)}...`;
	}

	private inferAudioFileName(mimeType: string): string {
		const normalized = mimeType.toLowerCase();
		if (normalized.includes('webm')) {
			return 'recording.webm';
		}
		if (normalized.includes('mp4')) {
			return 'recording.m4a';
		}
		if (normalized.includes('wav')) {
			return 'recording.wav';
		}
		if (normalized.includes('mpeg') || normalized.includes('mp3')) {
			return 'recording.mp3';
		}
		return 'recording.webm';
	}

	private inferAudioInputFormat(mimeType: string): string {
		const normalized = mimeType.toLowerCase();
		if (normalized.includes('wav')) {
			return 'wav';
		}
		if (normalized.includes('mpeg') || normalized.includes('mp3')) {
			return 'mp3';
		}
		if (normalized.includes('mp4') || normalized.includes('m4a')) {
			return 'm4a';
		}
		if (normalized.includes('webm')) {
			return 'webm';
		}
		return 'wav';
	}

	private async blobToBase64(blob: Blob): Promise<string> {
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = '';
		const chunkSize = 0x8000;
		for (let index = 0; index < bytes.length; index += chunkSize) {
			const chunk = bytes.subarray(index, Math.min(index + chunkSize, bytes.length));
			binary += String.fromCharCode(...chunk);
		}
		return btoa(binary);
	}
}
