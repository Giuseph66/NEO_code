/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { INeocodeSwarmAgentConfig, INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';
import { URI } from '../../../../base/common/uri.js';
import { parseStoredOpenAITokenBundle } from './neocodeSwarmOpenAIOAuthController.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IOpenAIHttpResponse, IOpenAIRequestService, NEO_SWARM_OPENAI_REQUEST_CHANNEL } from '../common/neocodeSwarmOpenAIRequestTypes.js';
import { ProxyChannel } from '../../../../base/parts/ipc/common/ipc.js';

export interface IAgentGenerationContext {
	provider: INeocodeSwarmProviderConfig;
	secret?: string;
	prompt: string;
}

const GENERATOR_SYSTEM_PROMPT = `You are an expert AI orchestrator responsible for compiling configurations for new specialized AI Agents based on a user's prompt.
You must output ONLY valid JSON describing the agent. Do not wrap it in markdown block quotes (like \`\`\`json). Just the raw object.

The output MUST abide by this TypeScript interface structure:
{
	"name": string, // A short, descriptive name for the agent (max 3 words)
	"role": "planner" | "coder" | "reviewer" | "researcher" | "debugger" | "custom",
	"mode": "parallel" | "serial", // Default to "parallel" unless the task implies strictly serial execution
	"soulRule": string, // A highly detailed, robust system prompt governing how the agent should behave, its constraints, and standard operating procedures. Be comprehensive.
}

For example, if the user asks for a 'frontend bug fixer', you might return:
{
	"name": "Frontend Debugger",
	"role": "debugger",
	"mode": "parallel",
	"soulRule": "You are a specialized frontend debugger. Your primary responsibility is analyzing React, DOM, and CSS issues..."
}
`;

export class NeocodeSwarmAgentGenerator {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) { }

	public async generateAgent(context: IAgentGenerationContext, token: CancellationToken = CancellationToken.None): Promise<Partial<INeocodeSwarmAgentConfig>> {
		if (token.isCancellationRequested) {
			return {};
		}
		const headers = await this.buildHeaders(context);
		const url = this.buildUrl(context);
		const payload = this.buildPayload(context);

		// Use background request for OpenAI to bypass CORS and handle Codex/Cloudflare issues
		if (context.provider.type === 'openai') {
			try {
				const response = await this.performBackgroundRequest({
					type: 'POST',
					url,
					headers,
					data: JSON.stringify(payload)
				});

				if (response.statusCode < 200 || response.statusCode >= 300) {
					// Hard API error (e.g. 401, 403, 429) - rethrow immediately to notify user
					throw new Error(`Model API HTTP ${response.statusCode}: ${response.body}`);
				}

				const content = this.extractContent(context.provider, response.body);
				if (!content) {
					throw new Error('No content returned from the model.');
				}

				return this.parseAgentJson(content);
			} catch (error) {
				// If it's a "Model API HTTP" error, we've already thrown it correctly above
				if (error.message?.includes('Model API HTTP')) {
					throw error;
				}
				// Otherwise it's likely a worker bridge failure or timeout; try fallback fetch
				console.error('Background request infrastructure failure:', error);
			}
		}

		const controller = new AbortController();
		const timeoutHandle = setTimeout(() => controller.abort(), 60000); // 60s timeout

		try {
			const response = await fetch(url, {
				method: 'POST',
				headers,
				body: JSON.stringify(payload),
				signal: controller.signal
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Model API HTTP ${response.status}: ${errorText}`);
			}

			const contentType = response.headers.get('content-type') || '';
			let content: string | undefined;

			// Handle streaming responses (SSE) which cannot be passed to response.json()
			if (contentType.includes('text/event-stream') || (context.provider.type === 'openai' && context.provider.authMethod === 'login')) {
				const text = await response.text();
				content = this.extractContent(context.provider, text);
			} else {
				const data = await response.json();
				content = this.extractContent(context.provider, data);
			}

			if (!content) {
				throw new Error('No content returned from the model.');
			}

			return this.parseAgentJson(content);
		} finally {
			clearTimeout(timeoutHandle);
		}
	}

	private async performBackgroundRequest(request: { type: 'GET' | 'POST'; url: string; headers?: Record<string, string>; data?: string }): Promise<IOpenAIHttpResponse> {
		const module = await import('../../../services/utilityProcess/electron-browser/utilityProcessWorkerWorkbenchService.js');
		const utilityProcessService = this.instantiationService.invokeFunction(accessor => accessor.get(module.IUtilityProcessWorkerWorkbenchService)) as any;

		let worker: any | undefined;
		try {
			worker = await utilityProcessService.createWorker({
				moduleId: 'vs/workbench/contrib/neocodeSwarm/node/neocodeSwarmOpenAIRequestMain',
				type: 'openaiHttpRequest',
				name: 'NeoCode OpenAI HTTP Bridge'
			});
			const requestService = ProxyChannel.toService<IOpenAIRequestService>(worker.client.getChannel(NEO_SWARM_OPENAI_REQUEST_CHANNEL));
			return await requestService.request({
				method: request.type,
				url: request.url,
				headers: request.headers,
				body: request.data,
				timeoutMs: 60000
			});
		} finally {
			worker?.dispose();
		}
	}

	private async buildHeaders(context: IAgentGenerationContext): Promise<Record<string, string>> {
		const { provider, secret } = context;

		if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
			const token = await this.getQwenOAuthToken();
			if (!token) {
				throw new Error('Qwen OAuth token not found or expired. Please re-authenticate.');
			}
			return {
				'Authorization': `Bearer ${token}`,
				'Content-Type': 'application/json'
			};
		}

		if (provider.type === 'openai' && provider.authMethod === 'login') {
			if (!secret) throw new Error('OpenAI login token missing.');
			const bundle = parseStoredOpenAITokenBundle(secret);
			if (!bundle?.accessToken) throw new Error('Invalid OpenAI login token bundle.');
			return {
				'Authorization': `Bearer ${bundle.accessToken}`,
				'Content-Type': 'application/json'
			};
		}

		const apiKey = secret?.trim() || '';

		switch (provider.type) {
			case 'openai':
			case 'custom':
				return {
					'Authorization': `Bearer ${apiKey}`,
					'Content-Type': 'application/json'
				};
			case 'anthropic':
				return {
					'x-api-key': apiKey,
					'anthropic-version': '2023-06-01',
					'Content-Type': 'application/json'
				};
			case 'gemini':
				return {
					'Content-Type': 'application/json'
				};
			default:
				throw new Error(`Authentication for provider type ${provider.type} is not implemented for Agent Generation.`);
		}
	}

	private buildUrl(context: IAgentGenerationContext): string {
		const { provider } = context;
		const baseUrl = this.normalizeBaseUrl(provider.baseUrl);
		const model = provider.selectedModel ?? provider.models[0] ?? '';

		if (provider.type === 'openai' && provider.authMethod === 'login') {
			const codexBase = 'https://chatgpt.com/backend-api/codex';
			const normalizedCodex = this.normalizeBaseUrl(provider.baseUrl ?? codexBase);
			return `${normalizedCodex}/responses`;
		}

		switch (provider.type) {
			case 'openai':
			case 'qwen-code':
			case 'custom':
				return `${baseUrl}/v1/chat/completions`;
			case 'anthropic':
				return `${baseUrl}/v1/messages`;
			case 'gemini': {
				const apiKey = context.secret?.trim() || '';
				return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
			}
			default:
				throw new Error(`Unsupported provider type: ${provider.type}`);
		}
	}

	private buildPayload(context: IAgentGenerationContext): any {
		const { provider, prompt } = context;
		const model = provider.selectedModel ?? provider.models[0] ?? '';

		if (provider.type === 'openai' && provider.authMethod === 'login') {
			return {
				model,
				input: [
					{
						role: 'user',
						content: [{ type: 'input_text', text: prompt }]
					}
				],
				instructions: GENERATOR_SYSTEM_PROMPT,
				stream: true, // Codex requires stream: true
				store: false
			};
		}

		switch (provider.type) {
			case 'openai':
			case 'qwen-code':
			case 'custom':
				return {
					model,
					messages: [
						{ role: 'system', content: GENERATOR_SYSTEM_PROMPT },
						{ role: 'user', content: prompt }
					],
					temperature: 0.2, // Low temp for structured JSON
					response_format: { type: 'json_object' } // Supported by OpenAI/Qwen
				};
			case 'anthropic':
				return {
					model,
					system: GENERATOR_SYSTEM_PROMPT,
					messages: [
						{ role: 'user', content: prompt }
					],
					temperature: 0.2,
					max_tokens: 4096
				};
			case 'gemini':
				return {
					contents: [
						{ role: 'user', parts: [{ text: `${GENERATOR_SYSTEM_PROMPT}\n\nUser Request: ${prompt}` }] }
					],
					generationConfig: {
						temperature: 0.2,
						responseMimeType: 'application/json'
					}
				};
			default:
				return {};
		}
	}

	private extractContent(provider: INeocodeSwarmProviderConfig, data: any): string | undefined {
		if (provider.type === 'openai' && provider.authMethod === 'login') {
			// Codex response format can be direct JSON or SSE stream chunks.
			// When stream: true is used, the whole response collected by the background worker
			// or standard fetch may be a series of "data: {...}" lines.

			const raw = typeof data === 'string' ? data : JSON.stringify(data);
			return this.extractOpenAICodexText(raw);
		}

		switch (provider.type) {
			case 'openai':
			case 'qwen-code':
			case 'custom':
				return data.choices?.[0]?.message?.content;
			case 'anthropic':
				return data.content?.[0]?.text;
			case 'gemini':
				return data.candidates?.[0]?.content?.parts?.[0]?.text;
			default:
				return undefined;
		}
	}

	private extractOpenAICodexText(raw: string): string {
		const trimmed = raw.trim();
		if (!trimmed) {
			return '';
		}

		try {
			// Try to parse as a direct JSON response first
			const payload = JSON.parse(trimmed);
			const directText = this.extractOpenAIResponsesText(payload);
			if (directText) {
				return directText;
			}
		} catch {
			// Not a simple JSON; fall through to SSE parsing
		}

		let deltaText = '';
		let snapshotText = '';
		for (const line of trimmed.split(/\r?\n/)) {
			const chunk = line.trim();
			if (!chunk.startsWith('data:')) {
				continue;
			}
			const jsonChunk = chunk.slice(5).trim();
			if (!jsonChunk || jsonChunk === '[DONE]') {
				continue;
			}
			try {
				const event = JSON.parse(jsonChunk);
				const eventType = typeof event.type === 'string' ? event.type : '';
				if (eventType.includes('response.output_text.delta') && typeof event.delta === 'string') {
					deltaText += event.delta;
					continue;
				}

				const responsePayload = event.response && typeof event.response === 'object' ? event.response : event;
				const eventText = this.extractOpenAIResponsesText(responsePayload);
				if (eventText) {
					snapshotText = eventText;
				}
			} catch {
				// ignore malformed SSE chunk
			}
		}

		return deltaText.trim() || snapshotText.trim();
	}

	private extractOpenAIResponsesText(payload: any): string {
		const directOutputText = payload.output_text;
		if (typeof directOutputText === 'string' && directOutputText.trim()) {
			return directOutputText.trim();
		}

		const output = Array.isArray(payload.output) ? payload.output : [];
		const chunks: string[] = [];
		for (const item of output) {
			const contentArr = Array.isArray(item?.content) ? item.content : [];
			for (const block of contentArr) {
				if (typeof block?.text === 'string' && block.text.trim()) {
					chunks.push(block.text.trim());
				}
			}
		}
		return chunks.join('\n').trim();
	}

	private parseAgentJson(content: string): Partial<INeocodeSwarmAgentConfig> {
		try {
			// Strip markdown code blocks if the model ignored instructions
			let cleaned = content.trim();
			if (cleaned.startsWith('\`\`\`json')) {
				cleaned = cleaned.replace(/^\`\`\`json/, '');
			} else if (cleaned.startsWith('\`\`\`')) {
				cleaned = cleaned.replace(/^\`\`\`/, '');
			}
			if (cleaned.endsWith('\`\`\`')) {
				cleaned = cleaned.replace(/\`\`\`$/, '');
			}

			const parsed = JSON.parse(cleaned);

			return {
				name: parsed.name,
				role: parsed.role,
				mode: parsed.mode,
				soulRule: parsed.soulRule
			};
		} catch (e) {
			throw new Error('Failed to parse model response into valid agent JSON format. Response was: ' + content);
		}
	}

	private normalizeBaseUrl(baseUrl: string | undefined): string {
		if (!baseUrl) {
			return 'https://api.openai.com'; // Default OpenAI
		}
		return baseUrl.trim().replace(/\/+$/, '');
	}

	private async getQwenOAuthToken(): Promise<string | undefined> {
		try {
			const userHomeUri = await this.pathService.userHome();
			const credsUri = URI.joinPath(userHomeUri, '.qwen', 'oauth_creds.json');
			const content = await this.fileService.readFile(credsUri);
			const text = content.value.toString();
			if (!text.trim()) {
				return undefined;
			}
			const creds = JSON.parse(text) as { access_token?: string; expiry_date?: number };
			if (!creds.access_token || (creds.expiry_date && creds.expiry_date < Date.now())) {
				return undefined;
			}
			return creds.access_token;
		} catch {
			return undefined;
		}
	}
}
