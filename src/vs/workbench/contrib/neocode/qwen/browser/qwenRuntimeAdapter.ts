/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { sanitizeQwenError } from '../common/qwenConfigSchema.js';
import { IQwenConnectionTestResult, IQwenProviderConfig, IQwenRuntimeEnvResult, QwenProtocol } from '../common/qwenTypes.js';
import { IQwenOAuthWorkerService, NEO_QWEN_OAUTH_WORKER_CHANNEL } from '../common/qwenOAuthWorkerTypes.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { QwenCliBridge } from './qwenCliBridge.js';

interface IUtilityProcessWorkerHandle {
	client: { getChannel(channelName: string): IChannel };
	dispose(): void;
}

interface IUtilityProcessWorkerServiceLike {
	createWorker(process: { moduleId: string; type: string; name: string }): Promise<IUtilityProcessWorkerHandle>;
}

export interface IQwenSdkTaskOptions {
	prompt: string;
	pathToQwenExecutable?: string;
	includePartialMessages?: boolean;
	permissionMode?: 'plan' | 'default' | 'acceptEdits' | 'bypassPermissions';
	excludeTools?: string[];
	abortController?: AbortController;
}

/**
 * Event chunk emitted during a streaming task.
 */
export interface IQwenStreamChunk {
	type: 'content' | 'tool_call' | 'done' | 'error';
	value?: string;
	toolName?: string;
	error?: string;
}

// ─── Default base URLs per protocol ──────────────────────────────────────────

const DEFAULT_BASE_URLS: Record<QwenProtocol, string> = {
	'openai': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
	'gemini': 'https://generativelanguage.googleapis.com/v1beta',
	'anthropic': 'https://api.anthropic.com/v1',
	'vertex-ai': 'https://generativelanguage.googleapis.com/v1beta',
};
const DEFAULT_QWEN_OAUTH_RESOURCE_URL = 'https://dashscope.aliyuncs.com/compatible-mode';
const QWEN_OAUTH_CODER_MODEL = 'coder-model';
const QWEN_OAUTH_VISION_MODEL = 'vision-model';

/**
 * Browser-compatible runtime adapter for Qwen.
 * Uses direct fetch() REST calls to OpenAI-compatible / Gemini / Anthropic APIs.
 * Zero Node.js dependencies — runs natively in the browser.
 */
export class QwenRuntimeAdapter extends Disposable {
	private readonly cliBridge: QwenCliBridge;

	constructor(
		@ILogService private readonly logService: ILogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this.cliBridge = this._register(instantiationService.createInstance(QwenCliBridge));
	}

	// ─── Streaming task execution ──────────────────────────────────────────

	async *runTask(config: IQwenProviderConfig, envData: IQwenRuntimeEnvResult, options: IQwenSdkTaskOptions, token: CancellationToken): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		if (token.isCancellationRequested) {
			throw new Error('cancelled');
		}

		const apiKey = envData.env[config.envVarName];
		this.logService.info(`[neocode qwen] runTask authType=${config.authType} envVar=${config.envVarName} hasKey=${!!apiKey}`);
		if (!apiKey) {
			if (config.authType === 'qwen-oauth') {
				throw new Error('Sessao Qwen OAuth ausente ou expirada. Faca login novamente.');
			}
			throw new Error('API key ausente. Configure e salve a credencial.');
		}

		const abortController = options.abortController ?? new AbortController();

		// Cancel on token cancellation
		const onCancel = token.onCancellationRequested(() => abortController.abort());

		try {
			if (config.protocol === 'anthropic') {
				yield* this.streamAnthropic(config, apiKey, options, abortController);
			} else if (config.protocol === 'gemini' || config.protocol === 'vertex-ai') {
				yield* this.streamGemini(config, apiKey, options, abortController);
			} else {
				// Default: OpenAI-compatible (covers Qwen/DashScope, OpenAI, etc.)
				yield* this.streamOpenAICompatible(config, envData.env, apiKey, options, abortController);
			}
		} finally {
			onCancel.dispose();
		}
	}

	// ─── Connection test ───────────────────────────────────────────────────

	async testConnection(config: IQwenProviderConfig, envData: IQwenRuntimeEnvResult): Promise<IQwenConnectionTestResult> {
		if (config.authType === 'apiKey') {
			const envKey = config.envVarName.trim();
			if (!envKey || !envData.env[envKey]) {
				return { ok: false, kind: 'missing_key', message: 'API key ausente. Configure e salve a credencial.' };
			}
		}

		const apiKey = envData.env[config.envVarName];
		if (config.authType === 'qwen-oauth' && !apiKey) {
			return { ok: false, kind: 'auth_required', message: 'Sessao Qwen OAuth ausente ou expirada. Faca login novamente.' };
		}

		try {
			const abortController = new AbortController();
			const timeoutId = setTimeout(() => abortController.abort(), 8000);

			try {
				if (config.protocol === 'anthropic') {
					await this.testAnthropicConnection(config, apiKey, abortController);
				} else if (config.protocol === 'gemini' || config.protocol === 'vertex-ai') {
					await this.testGeminiConnection(config, apiKey, abortController);
				} else {
					await this.testOpenAIConnection(config, envData.env, apiKey, abortController);
				}
				return { ok: true, kind: 'connected', message: 'Conectado com sucesso ao Qwen.' };
			} finally {
				clearTimeout(timeoutId);
			}
		} catch (error) {
			const message = sanitizeQwenError(error instanceof Error ? error.message : String(error));
			if (/timeout|aborted|abort/i.test(message)) {
				return { ok: false, kind: 'timeout', message: 'Timeout ao testar conexao com Qwen.' };
			}
			if (/model/i.test(message)) {
				return { ok: false, kind: 'invalid_model', message };
			}
			if (/base url|url|ENOTFOUND|ECONNREFUSED/i.test(message)) {
				return { ok: false, kind: 'invalid_base_url', message };
			}
			if (/401|unauthorized|invalid.*key/i.test(message)) {
				if (config.authType === 'qwen-oauth') {
					return { ok: false, kind: 'auth_required', message: 'Sessao Qwen OAuth expirada ou invalida. Faca login novamente.' };
				}
				return { ok: false, kind: 'missing_key', message };
			}
			return { ok: false, kind: 'unknown_error', message };
		}
	}

	buildSdkOptions(config: IQwenProviderConfig, envData: IQwenRuntimeEnvResult, options: IQwenSdkTaskOptions): Record<string, unknown> {
		return {
			authType: config.authType,
			model: config.modelId,
			baseUrl: config.baseUrl,
			pathToQwenExecutable: options.pathToQwenExecutable,
			env: envData.env,
			permissionMode: options.permissionMode ?? 'plan',
			includePartialMessages: options.includePartialMessages ?? true,
			excludeTools: options.excludeTools ?? []
		};
	}

	async resetBrokenAuthState(): Promise<void> {
		this.logService.info('[neocode qwen] broken auth reset requested');
	}

	async detectCli(pathOverride?: string) {
		return this.cliBridge.detectQwenCli(pathOverride);
	}

	// ─── OpenAI-compatible streaming (Qwen/DashScope, OpenAI, etc.) ──────

	private resolveBaseUrl(config: IQwenProviderConfig, envData?: Record<string, string>): string {
		if (config.baseUrl?.trim()) {
			return config.baseUrl.trim().replace(/\/+$/, '');
		}
		if (config.authType === 'qwen-oauth') {
			const resourceUrl = envData?.['QWEN_OAUTH_RESOURCE_URL'] || DEFAULT_QWEN_OAUTH_RESOURCE_URL;
			const normalizedUrl = resourceUrl.startsWith('http') ? resourceUrl : `https://${resourceUrl}`;
			return normalizedUrl.endsWith('/v1') ? normalizedUrl : `${normalizedUrl}/v1`;
		}
		return DEFAULT_BASE_URLS[config.protocol] ?? DEFAULT_BASE_URLS['openai'];
	}

	private resolveModelId(config: IQwenProviderConfig): string {
		if (config.authType !== 'qwen-oauth') {
			return config.modelId;
		}
		const raw = (config.modelId || '').trim();
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

	private async *streamOpenAICompatible(
		config: IQwenProviderConfig,
		envData: Record<string, string>,
		apiKey: string,
		options: IQwenSdkTaskOptions,
		abortController: AbortController
	): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		if (config.authType === 'qwen-oauth') {
			yield* this.streamViaWorker(config, envData, apiKey, options, abortController);
			return;
		}

		const baseUrl = this.resolveBaseUrl(config);
		const endpoint = `${baseUrl}/chat/completions`;
		const modelId = this.resolveModelId(config);
		this.logService.info(`[neocode qwen] request endpoint=${endpoint} authType=${config.authType}`);

		const systemMessage = options.permissionMode === 'plan'
			? 'Voce e um assistente de codigo. Analise e planeje, mas nao escreva codigo diretamente.'
			: 'Voce e um assistente de codigo inteligente e eficiente.';

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
			},
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: systemMessage },
					{ role: 'user', content: options.prompt }
				],
				stream: true,
			}),
			signal: abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${detail}`);
		}

		yield* this.parseSSEStream(response);
	}

	private async *streamViaWorker(
		config: IQwenProviderConfig,
		envData: Record<string, string>,
		apiKey: string,
		options: IQwenSdkTaskOptions,
		abortController: AbortController
	): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const baseUrl = this.resolveBaseUrl(config, envData);
		const endpoint = `${baseUrl}/chat/completions`;
		const modelId = this.resolveModelId(config);
		this.logService.info(`[neocode qwen] worker stream endpoint=${endpoint}`);

		const workerData = await this.startWorker();
		const systemMessage = options.permissionMode === 'plan'
			? 'Voce e um assistente de codigo. Analise e planeje, mas nao escreva codigo diretamente.'
			: 'Voce e um assistente de codigo inteligente e eficiente.';

		const eventStream = workerData.service.onDynamicStream({
			url: endpoint,
			body: JSON.stringify({
				model: modelId,
				messages: [
					{ role: 'system', content: systemMessage },
					{ role: 'user', content: options.prompt }
				],
				stream: true,
			}),
			headers: {
				'Authorization': `Bearer ${apiKey}`
			}
		});

		let isReady = false;
		let promiseResolver: ((value: void) => void) | undefined;
		let streamError: Error | undefined;
		const queue: any[] = [];

		const disposable = eventStream(chunk => {
			if (chunk.type === 'error') {
				streamError = new Error(chunk.error);
				isReady = true;
			} else if (chunk.type === 'done') {
				isReady = true;
			} else if (chunk.type === 'data') {
				queue.push(chunk.data);
			}

			if (promiseResolver) {
				promiseResolver();
				promiseResolver = undefined;
			}
		});

		abortController.signal.addEventListener('abort', () => {
			disposable.dispose();
			workerData.worker.dispose();
		});

		try {
			let buffer = '';
			while (true) {
				if (streamError) {
					throw streamError;
				}

				if (queue.length > 0) {
					const chunkData = queue.shift();
					if (chunkData) {
						buffer += chunkData;
						buffer = yield* this.parseSSEBuffer(buffer);
					}
					continue;
				}

				if (isReady && queue.length === 0) {
					break;
				}

				await new Promise<void>(resolve => {
					promiseResolver = resolve;
				});
			}
		} finally {
			disposable.dispose();
			workerData.worker.dispose();
		}
	}

	private async startWorker(): Promise<{ worker: IUtilityProcessWorkerHandle; service: IQwenOAuthWorkerService }> {
		let utilityProcessService: IUtilityProcessWorkerServiceLike;
		try {
			const module = await import('../../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
			// eslint-disable-next-line local/code-no-dangerous-type-assertions
			utilityProcessService = this.instantiationService.invokeFunction(
				(accessor: any) => accessor.get(module.IUtilityProcessWorkerWorkbenchService)
			) as IUtilityProcessWorkerServiceLike;
		} catch (error) {
			throw new Error(`Worker indisponivel: ${error}`);
		}

		const worker = await utilityProcessService.createWorker({
			moduleId: 'vs/workbench/contrib/neocode/qwen/node/qwenOAuthWorkerMain',
			type: 'qwenOAuth',
			name: 'NeoCode Qwen OAuth Worker',
		});

		const service = ProxyChannel.toService<IQwenOAuthWorkerService>(
			worker.client.getChannel(NEO_QWEN_OAUTH_WORKER_CHANNEL)
		);

		return { worker, service };
	}

	private async testOpenAIConnection(config: IQwenProviderConfig, envData: Record<string, string>, apiKey: string, abortController: AbortController): Promise<void> {
		const baseUrl = this.resolveBaseUrl(config, envData);
		const endpoint = `${baseUrl}/chat/completions`;
		const modelId = this.resolveModelId(config);
		this.logService.info(`[neocode qwen] testing connection endpoint=${endpoint} authType=${config.authType}`);

		const body = JSON.stringify({
			model: modelId,
			messages: [{ role: 'user', content: 'Responda apenas com: ok' }],
			max_tokens: 10,
			stream: false,
		});

		const headers = {
			'Authorization': `Bearer ${apiKey}`,
			'Content-Type': 'application/json',
		};

		let responseText = '';
		let statusCode = 0;

		if (config.authType === 'qwen-oauth') {
			const workerData = await this.startWorker();
			try {
				const response = await workerData.service.post({
					url: endpoint,
					body,
					headers
				});
				statusCode = response.statusCode;
				responseText = response.body;
			} finally {
				workerData.worker.dispose();
			}
		} else {
			const response = await fetch(endpoint, {
				method: 'POST',
				headers,
				body,
				signal: abortController.signal,
			});
			statusCode = response.status;
			responseText = await response.text().catch(() => '');
		}

		if (statusCode < 200 || statusCode >= 300) {
			throw new Error(`HTTP ${statusCode}: ${responseText}`);
		}

		const payload = JSON.parse(responseText) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		const text = payload.choices?.[0]?.message?.content?.trim();
		this.logService.debug(`[neocode qwen] Connection test succeeded: ${text?.slice(0, 60)}`);
	}

	// ─── Gemini REST streaming ──────────────────────────────────────────

	private async *streamGemini(
		config: IQwenProviderConfig,
		apiKey: string,
		options: IQwenSdkTaskOptions,
		abortController: AbortController
	): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const baseUrl = this.resolveBaseUrl(config);
		const model = encodeURIComponent(config.modelId);
		const endpoint = `${baseUrl}/models/${model}:streamGenerateContent?key=${encodeURIComponent(apiKey)}&alt=sse`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents: [{ parts: [{ text: options.prompt }] }]
			}),
			signal: abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${detail}`);
		}

		yield* this.parseGeminiSSEStream(response);
	}

	private async testGeminiConnection(config: IQwenProviderConfig, apiKey: string, abortController: AbortController): Promise<void> {
		const baseUrl = this.resolveBaseUrl(config);
		const model = encodeURIComponent(config.modelId);
		const endpoint = `${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				contents: [{ parts: [{ text: 'Responda apenas com: ok' }] }]
			}),
			signal: abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${detail}`);
		}

		this.logService.debug('[neocode qwen] Gemini connection test succeeded');
	}

	// ─── Anthropic REST streaming ───────────────────────────────────────

	private async *streamAnthropic(
		config: IQwenProviderConfig,
		apiKey: string,
		options: IQwenSdkTaskOptions,
		abortController: AbortController
	): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const baseUrl = this.resolveBaseUrl(config);
		const endpoint = `${baseUrl}/messages`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: config.modelId,
				max_tokens: 8192,
				stream: true,
				messages: [{ role: 'user', content: options.prompt }]
			}),
			signal: abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${detail}`);
		}

		yield* this.parseAnthropicSSEStream(response);
	}

	private async testAnthropicConnection(config: IQwenProviderConfig, apiKey: string, abortController: AbortController): Promise<void> {
		const baseUrl = this.resolveBaseUrl(config);
		const endpoint = `${baseUrl}/messages`;

		const response = await fetch(endpoint, {
			method: 'POST',
			headers: {
				'x-api-key': apiKey,
				'Content-Type': 'application/json',
				'anthropic-version': '2023-06-01',
			},
			body: JSON.stringify({
				model: config.modelId,
				max_tokens: 10,
				messages: [{ role: 'user', content: 'Responda apenas com: ok' }]
			}),
			signal: abortController.signal,
		});

		if (!response.ok) {
			const detail = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status}: ${detail}`);
		}

		this.logService.debug('[neocode qwen] Anthropic connection test succeeded');
	}

	// ─── SSE parsers ────────────────────────────────────────────────────

	private async *parseSSEBuffer(buffer: string): AsyncGenerator<IQwenStreamChunk, string, unknown> {
		const lines = buffer.split('\n');
		const nextBuffer = lines.pop() ?? '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed || !trimmed.startsWith('data:')) {
				continue;
			}

			const data = trimmed.slice(5).trim();
			if (data === '[DONE]') {
				yield { type: 'done' };
				continue;
			}

			try {
				const parsed = JSON.parse(data) as {
					choices?: Array<{
						delta?: { content?: string; tool_calls?: Array<{ function?: { name?: string } }> };
						finish_reason?: string | null;
					}>;
				};

				const delta = parsed.choices?.[0]?.delta;
				if (delta?.content) {
					yield { type: 'content', value: delta.content };
				}
				if (delta?.tool_calls) {
					for (const tc of delta.tool_calls) {
						if (tc.function?.name) {
							yield { type: 'tool_call', toolName: tc.function.name };
						}
					}
				}
			} catch {
				// Skip malformed JSON lines
			}
		}

		return nextBuffer;
	}

	/**
	 * Parse OpenAI-compatible SSE stream (text/event-stream).
	 * Each line starts with "data: " and the payload is JSON with delta content.
	 */
	private async *parseSSEStream(response: Response): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const body = response.body;
		if (!body) {
			return;
		}

		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				buffer = yield* this.parseSSEBuffer(buffer);
			}
		} finally {
			reader.releaseLock();
		}

		yield { type: 'done' };
	}

	/**
	 * Parse Gemini SSE stream.
	 */
	private async *parseGeminiSSEStream(response: Response): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const body = response.body;
		if (!body) {
			return;
		}

		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed.startsWith('data:')) {
						continue;
					}
					const data = trimmed.slice(5).trim();
					if (!data) {
						continue;
					}

					try {
						const parsed = JSON.parse(data) as {
							candidates?: Array<{
								content?: { parts?: Array<{ text?: string }> };
							}>;
						};

						const text = parsed.candidates?.[0]?.content?.parts?.find(p => typeof p.text === 'string')?.text;
						if (text) {
							yield { type: 'content', value: text };
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		yield { type: 'done' };
	}

	/**
	 * Parse Anthropic SSE stream.
	 */
	private async *parseAnthropicSSEStream(response: Response): AsyncGenerator<IQwenStreamChunk, void, unknown> {
		const body = response.body;
		if (!body) {
			return;
		}

		const reader = body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) {
					break;
				}

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() ?? '';

				let currentEvent = '';
				for (const line of lines) {
					const trimmed = line.trim();
					if (trimmed.startsWith('event:')) {
						currentEvent = trimmed.slice(6).trim();
						continue;
					}
					if (!trimmed.startsWith('data:')) {
						continue;
					}
					const data = trimmed.slice(5).trim();
					if (!data) {
						continue;
					}

					try {
						const parsed = JSON.parse(data);
						if (currentEvent === 'content_block_delta' && parsed.delta?.text) {
							yield { type: 'content', value: parsed.delta.text };
						} else if (currentEvent === 'message_stop') {
							yield { type: 'done' };
							return;
						}
					} catch {
						// Skip malformed JSON
					}
				}
			}
		} finally {
			reader.releaseLock();
		}

		yield { type: 'done' };
	}
}
