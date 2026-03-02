/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { INeocodeToolExecutor } from '../../neocode/qwen/common/qwenTypes.js';
import {
	INeocodeSwarmProviderConfig,
	NeocodeSwarmProviderType,
	ISwarmAgentPlan,
	ISwarmAgentLogEntry,
	SwarmAgentStatus,
} from '../common/neocodeSwarmTypes.js';

export interface IAgentProgressUpdate {
	agentId: string;
	status: SwarmAgentStatus;
	log?: ISwarmAgentLogEntry;
}

export interface ISwarmAgentRunOptions {
	plan: ISwarmAgentPlan;
	provider: INeocodeSwarmProviderConfig;
	apiKey: string | undefined;
	/** Extra env vars merged into every request (e.g. QWEN_OAUTH_RESOURCE_URL for qwen-oauth). */
	extraEnv?: Record<string, string>;
	toolExecutor: INeocodeToolExecutor;
	systemPrompt: string;
	/** Optional context from the orchestrator or other agents. */
	context?: string;
	onUpdate: (update: IAgentProgressUpdate) => void;
}

function buildAgentProviderConfig(provider: INeocodeSwarmProviderConfig) {
	const protocolMap: Record<NeocodeSwarmProviderType, 'openai' | 'gemini' | 'anthropic' | 'vertex-ai'> = {
		gemini: 'gemini',
		anthropic: 'anthropic',
		openai: 'openai',
		'qwen-code': 'openai',
		custom: 'openai',
	};
	const envVarMap: Record<NeocodeSwarmProviderType, string> = {
		gemini: 'GEMINI_API_KEY',
		anthropic: 'ANTHROPIC_API_KEY',
		openai: 'OPENAI_API_KEY',
		'qwen-code': 'DASHSCOPE_API_KEY',
		custom: 'CUSTOM_API_KEY',
	};
	const baseUrlMap: Record<NeocodeSwarmProviderType, string> = {
		gemini: 'https://generativelanguage.googleapis.com/v1beta',
		anthropic: 'https://api.anthropic.com/v1',
		openai: 'https://api.openai.com/v1',
		'qwen-code': 'https://dashscope.aliyuncs.com/compatible-mode/v1',
		custom: '',
	};
	// For qwen-oauth, leave baseUrl undefined so QwenRuntimeAdapter.resolveBaseUrl()
	// reads QWEN_OAUTH_RESOURCE_URL from the env (the correct OAuth resource endpoint).
	const baseUrl = provider.authMethod === 'qwen-oauth'
		? (provider.baseUrl?.trim() || undefined)
		: (provider.baseUrl ?? baseUrlMap[provider.type]);
	return {
		authType: provider.authMethod === 'qwen-oauth' ? 'qwen-oauth' as const : 'apiKey' as const,
		protocol: protocolMap[provider.type],
		modelId: provider.selectedModel ?? provider.models[0] ?? 'default',
		displayName: provider.name,
		baseUrl,
		envVarName: envVarMap[provider.type],
	};
}

/**
 * Runs a single named agent within the swarm orchestration system.
 * Each runner has its own QwenRuntimeAdapter and reports progress via callbacks.
 */
export class NeocodeSwarmAgentRunner extends Disposable {
	private readonly adapter: QwenRuntimeAdapter;

	constructor(
		@IInstantiationService instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.adapter = this._register(instantiationService.createInstance(QwenRuntimeAdapter));
	}

	async run(options: ISwarmAgentRunOptions, token: CancellationToken): Promise<string> {
		const { plan, provider, apiKey, extraEnv, toolExecutor, systemPrompt, context, onUpdate } = options;

		const modelLabel = `${provider.name} › ${provider.selectedModel ?? provider.models[0] ?? 'default'}`;

		onUpdate({
			agentId: plan.id,
			status: 'thinking',
			log: {
				type: 'thinking',
				content: `[${modelLabel}] Iniciando: ${plan.task.substring(0, 80)}...`,
				timestamp: Date.now(),
			},
		});

		let agentPrompt = plan.task;
		if (context) {
			agentPrompt = `## Contexto do Orquestrador\n${context}\n\n## Sua Tarefa\n${plan.task}`;
		}

		const agentSystemPrompt = `${systemPrompt}

## Sua Identidade
Você é **${plan.name}** ${plan.emoji}, agente especializado em **${plan.role}** dentro de um enxame colaborativo de IA.

## Regras de Comportamento
- Foque EXCLUSIVAMENTE na sua tarefa designada
- Seja orientado a AÇÕES concretas, não apenas texto explicativo
- Use as ferramentas disponíveis (write_file, edit_file, read_file, list_dir, run_terminal) para FAZER o trabalho
- Para tarefas de desenvolvimento: ESCREVA O CÓDIGO REAL usando write_file e edit_file
- Para análise: use read_file e list_dir para explorar, depois produza resultados concretos
- Não peça permissão — execute a tarefa diretamente
- Ao finalizar, produza um resumo do que foi criado/modificado/descoberto

## Regra de Ouro
Se sua tarefa é criar ou implementar algo: **escreva o código completo e funcional agora**.
Não explique apenas como fazer — FAÇA usando as ferramentas disponíveis.`;

		const providerConfig = buildAgentProviderConfig(provider);
		// Start from extraEnv (e.g. QWEN_OAUTH_RESOURCE_URL) and overlay the explicit API key.
		const env: Record<string, string> = extraEnv ? { ...extraEnv } : {};
		if (apiKey) {
			env[providerConfig.envVarName] = apiKey;
		}

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: agentPrompt,
			systemPrompt: agentSystemPrompt,
			includePartialMessages: true,
			permissionMode: 'default',
			toolExecutor,
			maxToolCallRounds: 10,
		};

		onUpdate({ agentId: plan.id, status: 'working' });

		let result = '';
		try {
			const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);
			for await (const chunk of stream) {
				if (token.isCancellationRequested) { break; }

				if (chunk.type === 'content' && chunk.value) {
					result += chunk.value;
				} else if (chunk.type === 'tool_call' && chunk.toolName) {
					onUpdate({
						agentId: plan.id,
						status: 'working',
						log: { type: 'tool', content: chunk.toolName, timestamp: Date.now() },
					});
				} else if (chunk.type === 'error' && chunk.error) {
					this.logService.error(`[neocode agent ${plan.name}/${modelLabel}] Error:`, chunk.error);
					onUpdate({
						agentId: plan.id,
						status: 'error',
						log: { type: 'error', content: `[${modelLabel}] ${chunk.error}`, timestamp: Date.now() },
					});
					return `Erro em ${modelLabel}: ${chunk.error}`;
				}
			}

			onUpdate({
				agentId: plan.id,
				status: 'done',
				log: { type: 'message', content: 'Tarefa concluída', timestamp: Date.now() },
			});
			return result || '(sem resposta)';
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.error(`[neocode agent ${plan.name}/${modelLabel}] Exception:`, err);
			onUpdate({
				agentId: plan.id,
				status: 'error',
				log: { type: 'error', content: `[${modelLabel}] ${msg}`, timestamp: Date.now() },
			});
			return `Erro em ${modelLabel}: ${msg}`;
		}
	}
}
