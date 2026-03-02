/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../contrib/chat/common/chatService/chatService.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { INeocodeToolExecutor } from '../../neocode/qwen/common/qwenTypes.js';
import {
	INeocodeSwarmConfig,
	INeocodeSwarmProviderConfig,
	NeocodeSwarmProviderType,
	ISwarmExecutionPlan,
	ISwarmAgentPlan,
} from '../common/neocodeSwarmTypes.js';
import { NeocodeSwarmAgentRunner, ISwarmAgentRunOptions, IAgentProgressUpdate } from './neocodeSwarmAgentRunner.js';
import { INeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import { NeocodeSwarmCustomModal } from './neocodeSwarmCustomModal.js';
import './media/neocodeSwarmCustomModal.css';

export interface ISwarmOrchestratorOptions {
	prompt: string;
	config: INeocodeSwarmConfig;
	provider: INeocodeSwarmProviderConfig;
	apiKey: string | undefined;
	/** Extra env vars to merge into every request (e.g. QWEN_OAUTH_RESOURCE_URL for qwen-oauth). */
	extraEnv?: Record<string, string>;
	toolExecutor: INeocodeToolExecutor;
	systemPrompt: string;
	sessionId: string;
	/** When true, skips complexity analysis and forces multi-agent execution (used by /swarm command). */
	forceMultiAgent?: boolean;
	onProgress: (parts: IChatProgress[]) => void;
	/** Resolves the stored API key for any provider by ID. Used to give agents their own credentials. */
	resolveApiKey?: (providerId: string) => Promise<string | undefined>;
}

/**
 * Keywords that indicate the user wants actual work done (not just a question).
 * When matched, the complexity analysis is biased toward multi-agent execution.
 */
const ACTION_KEYWORDS = /\b(cri[ae]r?|desenvolv[ae]r?|implement[ae]r?|cod[ei]ficar?|constru[ií]r?|program[ae]r?|faça?|faz[ae]r?|escrever?|montare?|gerar?|refatorar?|construar?|create?|build|implement|develop|code|write|make|generate|refactor|add|fix|update|setup|configure|scaffold|bootstrap)\b/i;
const DEFAULT_MULTI_AGENT_COUNT = 3;
const MIN_AGENT_COUNT = 1;
const MAX_AGENT_COUNT = 20;
const DEFAULT_TIME_BUDGET_MINUTES = 30;
const MIN_TIME_BUDGET_MINUTES = 1;
const FALLBACK_AGENT_NAMES = ['Atlas', 'Forge', 'Nova', 'Sage', 'Echo', 'Rex', 'Luna', 'Zara', 'Orion', 'Bolt', 'Iris', 'Storm', 'Hex', 'Blaze', 'Scout'];

// ── Provider utilities shared with agent runner ────────────────────────────

export function buildProviderConfig(provider: INeocodeSwarmProviderConfig) {
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
	// can read QWEN_OAUTH_RESOURCE_URL from the env (the correct resource endpoint
	// for the OAuth token, which differs from the DashScope API-key endpoint).
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

export function buildEnvFromProvider(
	provider: INeocodeSwarmProviderConfig,
	apiKey: string | undefined,
	extraEnv?: Record<string, string>,
): Record<string, string> {
	const envVarMap: Record<NeocodeSwarmProviderType, string> = {
		gemini: 'GEMINI_API_KEY',
		anthropic: 'ANTHROPIC_API_KEY',
		openai: 'OPENAI_API_KEY',
		'qwen-code': 'DASHSCOPE_API_KEY',
		custom: 'CUSTOM_API_KEY',
	};
	// Start from extraEnv (e.g. QWEN_OAUTH_RESOURCE_URL) and overlay the explicit API key.
	const env: Record<string, string> = extraEnv ? { ...extraEnv } : {};
	if (apiKey) {
		env[envVarMap[provider.type]] = apiKey;
	}
	return env;
}

/**
 * Orchestrates multi-agent swarm execution.
 * Analyzes task complexity, spawns named agents, runs them in parallel, and synthesizes results.
 */
export class NeocodeSwarmOrchestrator extends Disposable {
	private readonly adapter: QwenRuntimeAdapter;

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILogService private readonly logService: ILogService,
		@INeocodeSwarmActivityService private readonly activityService: INeocodeSwarmActivityService,
	) {
		super();
		this.adapter = this._register(instantiationService.createInstance(QwenRuntimeAdapter));
	}

	async execute(options: ISwarmOrchestratorOptions, token: CancellationToken): Promise<void> {
		const { prompt, config, provider, apiKey, extraEnv, toolExecutor, systemPrompt, sessionId, forceMultiAgent, onProgress, resolveApiKey } = options;

		this.logService.info(`[neocode orchestrator] Starting execution. provider=${provider.name} (${provider.type}/${provider.authMethod}) forceMultiAgent=${forceMultiAgent}`);

		// Step 1: Analyze task complexity (or force multi-agent if requested)
		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString('_🧠 Orquestrador pensando sobre a tarefa..._'),
		}]);

		let preAnalysisPlan: ISwarmExecutionPlan;
		try {
			// Apply a 45s timeout to the pre-analysis — if the LLM hangs, fall back.
			const ANALYSIS_TIMEOUT_MS = 45_000;
			const analysisPromise = forceMultiAgent
				? Promise.resolve<ISwarmExecutionPlan>({
					complexity: 'moderate',
					reasoning: localize('neocodeSwarm.preAnalysis.forced.reasoning', "Modo multi-agente forçado pelo usuário."),
					directAnswer: '',
					agents: [],
					needsTimeBudget: false,
				})
				: this.analyzePlan(prompt, config, provider, apiKey, extraEnv, token, undefined, false);

			preAnalysisPlan = await Promise.race([
				analysisPromise,
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error(`Plan analysis timed out after ${ANALYSIS_TIMEOUT_MS / 1000}s`)), ANALYSIS_TIMEOUT_MS),
				),
			]);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[neocode orchestrator] analyzePlan failed/timed-out — falling back to single-agent. Error: ${msg}`);
			onProgress([{ kind: 'progressMessage', content: new MarkdownString('_⚠️ Análise de plano falhou, usando modo direto..._') }]);
			await this.runSingleAgent(prompt, provider, apiKey, extraEnv, toolExecutor, systemPrompt, onProgress, token);
			return;
		}

		this.logService.info('[neocode orchestrator] Pre-analysis:', JSON.stringify({ complexity: preAnalysisPlan.complexity, agents: preAnalysisPlan.agents.length, forced: forceMultiAgent }));

		if (token.isCancellationRequested) { return; }

		// Step 2: Simple conversational question → answer directly (no agents, no tools)
		// NOTE: we only use directAnswer when there are NO action keywords in the prompt.
		if (preAnalysisPlan.complexity === 'simple' && preAnalysisPlan.directAnswer && !ACTION_KEYWORDS.test(prompt)) {
			this.logService.info('[neocode orchestrator] Direct answer path (simple, no action keywords)');
			onProgress([{ kind: 'markdownContent', content: new MarkdownString(preAnalysisPlan.directAnswer) }]);
			return;
		}

		// Step 3: Single-agent tasks (simple with tools or fallback)
		if (preAnalysisPlan.complexity === 'simple') {
			this.logService.info('[neocode orchestrator] Single-agent path (simple complexity)');
			await this.runSingleAgent(prompt, provider, apiKey, extraEnv, toolExecutor, systemPrompt, onProgress, token);
			return;
		}

		// Step 4: Ask the user for execution preferences, then generate the detailed plan.
		const modal = this.instantiationService.createInstance(
			NeocodeSwarmCustomModal,
			DEFAULT_MULTI_AGENT_COUNT,
			this.getDefaultTimeBudgetForComplexity(preAnalysisPlan.complexity),
			async (preferences) => this.generatePlanForSelection(
				prompt,
				config,
				provider,
				apiKey,
				extraEnv,
				token,
				!!forceMultiAgent,
				preferences.agentCount,
			),
		);
		const preferences = await modal.show();

		if (!preferences) {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString('> ⏹️ Execução do enxame cancelada pelo usuário antes do início.\n\n'),
			}]);
			return;
		}

		let plan = preferences.plan;
		if (!plan) {
			plan = await this.generatePlanForSelection(
				prompt,
				config,
				provider,
				apiKey,
				extraEnv,
				token,
				!!forceMultiAgent,
				preferences.agentCount,
			);
		}

		if (token.isCancellationRequested) { return; }

		// Step 6: Confirmation is now handled within the custom modal's summary step.
		// If preferences is returned, it means the user confirmed the final step.

		if (token.isCancellationRequested) { return; }

		// Step 7: Show final plan in chat and register session in activity service
		this.emitPlan(plan, onProgress);
		const timeBudgetLabel = preferences.timeMode === 'indeterminate'
			? localize('neocodeSwarm.executionConfig.indeterminate', "tempo indeterminado")
			: this.formatDefinedTimeBudget(preferences.timeBudgetMinutes ?? DEFAULT_TIME_BUDGET_MINUTES);
		onProgress([{
			kind: 'markdownContent',
			content: new MarkdownString(
				`> ⚙️ **Configuração confirmada:** ${preferences.agentCount} agentes | ⏱️ ${timeBudgetLabel}\n\n`,
			),
		}]);

		this.activityService.startSession(sessionId, plan);
		this.activityService.setOrchestratorStatus(sessionId, `🚀 ${plan.agents.length} agentes em execução`);

		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString(`_🚀 Iniciando ${plan.agents.length} agentes em paralelo..._`),
		}]);

		// Step 8: Execute agents in parallel
		const agentResults = await this.executeAgentsInParallel(
			plan, provider, apiKey, extraEnv, toolExecutor, systemPrompt, config, sessionId,
			preferences.timeBudgetMinutes, onProgress, token, resolveApiKey, preferences.agentCount,
		);

		if (token.isCancellationRequested) {
			this.activityService.completeSession(sessionId);
			return;
		}

		// Step 9: Synthesize results
		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString('_🧠 Orquestrador sintetizando resultados dos agentes..._'),
		}]);
		this.activityService.setOrchestratorStatus(sessionId, '🔗 Sintetizando resultados...');

		const synthesis = await this.synthesizeResults(
			prompt, plan, agentResults, provider, apiKey, extraEnv, systemPrompt, token,
		);

		this.activityService.setOrchestratorStatus(sessionId, '✅ Concluído');
		this.activityService.completeSession(sessionId);

		onProgress([{
			kind: 'markdownContent',
			content: new MarkdownString(`\n\n---\n\n## ✅ Resultado Final\n\n${synthesis}`),
		}]);
	}

	private async generatePlanForSelection(
		prompt: string,
		config: INeocodeSwarmConfig,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		token: CancellationToken,
		forceMultiAgent: boolean,
		requestedAgentCount: number,
	): Promise<ISwarmExecutionPlan> {
		try {
			const plan = forceMultiAgent
				? await this.buildForcedMultiAgentPlan(prompt, provider, apiKey, extraEnv, config, token, requestedAgentCount)
				: await this.analyzePlan(prompt, config, provider, apiKey, extraEnv, token, requestedAgentCount, true);
			return this.enforceAgentCount(plan, prompt, requestedAgentCount);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[neocode orchestrator] generatePlanForSelection failed, applying local fallback. Error: ${msg}`);
			return this.enforceAgentCount(this.buildFallbackMultiAgentPlan(prompt), prompt, requestedAgentCount);
		}
	}

	// ─── Complexity analysis ──────────────────────────────────────────────────

	private async analyzePlan(
		prompt: string,
		config: INeocodeSwarmConfig,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		token: CancellationToken,
		preferredAgentCount?: number,
		includeAgents: boolean = true,
	): Promise<ISwarmExecutionPlan> {
		// Pre-check: if the prompt contains action keywords, force at least "moderate".
		// This prevents the LLM from classifying "crie um jogo RPG" as "simple".
		const hasActionKeyword = ACTION_KEYWORDS.test(prompt);

		// Build list of available agent roles from config
		const agentRoles = config.agents.filter(a => a.active).map(a => `${a.role}: ${a.name}`).join(', ');
		const preferredAgentRule = typeof preferredAgentCount === 'number'
			? `\nREQUISITO ADICIONAL DO USUÁRIO: crie EXATAMENTE ${preferredAgentCount} agentes (nem mais, nem menos).\n`
			: '';
		const analysisModeRule = includeAgents
			? ''
			: '\nMODO PRÉ-ANÁLISE: NÃO crie agentes agora. Retorne obrigatoriamente "agents": [] e foque apenas em classificar a complexidade.\n';

		const analysisPrompt = `Você é o ORQUESTRADOR de um enxame de agentes de IA especializados em desenvolvimento de software.

TAREFA DO USUÁRIO:
${prompt}

AGENTES DISPONÍVEIS NO ENXAME: ${agentRoles || 'planner, coder, reviewer, researcher'}
${preferredAgentRule}
${analysisModeRule}

═══════════════════════════════════════════
REGRAS ABSOLUTAS DE CLASSIFICAÇÃO:
═══════════════════════════════════════════

❌ "simple" APENAS PARA:
- Perguntas teóricas sem ação ("o que é um RPG?", "explique X")
- Definições e explicações curtas
- Conversas sem nenhuma tarefa de desenvolvimento

✅ "moderate" PARA:
- Qualquer tarefa que envolva escrever código, mesmo que pequena
- Correção de bugs, adição de funcionalidades, scripts
- Análise de código com recomendações de mudança
- Multi-agente quando houver benefício claro de paralelismo

✅ "complex" PARA:
- Criar qualquer aplicação, jogo, sistema ou feature completa
- Projetos que requerem múltiplos arquivos
- Tarefas com análise + implementação + revisão
- Preferência por múltiplos agentes em paralelo

IMPORTANTE: Qualquer pedido de CRIAÇÃO (crie, faça, desenvolva, implemente, construa, build, create, make) = NO MÍNIMO "moderate" com múltiplos agentes.
PRIORIDADE ABSOLUTA: se o usuário definiu quantidade de agentes, respeite EXATAMENTE essa quantidade.
PRIORIDADE DE EXECUÇÃO: priorize agentes que ENTREGAM implementação (telas, endpoints, lógica, testes). Evite criar agentes só de documentação/arquitetura, a menos que o usuário peça explicitamente.

═══════════════════════════════════════════
FORMATO DE RESPOSTA (JSON PURO, SEM MARKDOWN):
═══════════════════════════════════════════
{
  "complexity": "complex",
  "reasoning": "Breve justificativa em 1 frase",
  "directAnswer": "",
  "agents": [
    {
      "id": "agent-1",
      "name": "Forge",
      "emoji": "⚒️",
      "role": "coder",
      "task": "Implemente as telas/fluxos de UI necessários para a tarefa usando edit_file/write_file e valide navegação/estado."
    },
    {
      "id": "agent-2",
      "name": "Nova",
      "emoji": "🧩",
      "role": "coder",
      "task": "Implemente endpoints/serviços e integração com a UI usando edit_file/write_file. Garanta contratos e tratamento de erros."
    }
  ],
  "needsTimeBudget": false
}

REGRAS PARA OS AGENTES:
- Cada agente deve ter tarefa MUITO específica com instruções concretas de AÇÃO
- Use verbos imperativos: "Liste", "Crie", "Escreva", "Implemente", "Analise", "Verifique"
- Mencione as ferramentas que o agente deve usar (write_file, edit_file, read_file, run_terminal)
- Para "coder": a tarefa DEVE incluir "use write_file para criar" ou "use edit_file para modificar"
- Pelo menos 70% dos agentes devem estar focados em implementação de código (UI, API, lógica, testes)
- No máximo 1 agente pode ser de pesquisa/análise; documentação só se solicitada pelo usuário
- Distribua por frentes paralelas de entrega (ex: frontend, backend, integração, testes)
- needsTimeBudget=true apenas se a tarefa for muito grande (projeto completo com muitos arquivos)
- Nomes dos agentes: Atlas, Forge, Nova, Sage, Echo, Rex, Luna, Zara, Orion, Bolt, Iris, Storm, Hex, Blaze, Scout

SE MODO PRÉ-ANÁLISE ESTIVER ATIVO:
- "agents" deve ser sempre []
- Não detalhe tarefas de agentes`;

		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, apiKey, extraEnv);

		this.logService.info(`[neocode orchestrator] analyzePlan: calling adapter. protocol=${providerConfig.protocol} authType=${providerConfig.authType} model=${providerConfig.modelId} hasApiKey=${!!apiKey}`);

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: analysisPrompt,
			systemPrompt: 'Você é um orquestrador de agentes IA para desenvolvimento de software. Responda APENAS com JSON válido. Nunca use markdown ou explicações fora do JSON.',
			includePartialMessages: false,
			maxToolCallRounds: 0,
		};

		let rawJson = '';
		try {
			const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);
			for await (const chunk of stream) {
				if (token.isCancellationRequested) { break; }
				if (chunk.type === 'content' && chunk.value) {
					rawJson += chunk.value;
				} else if (chunk.type === 'error' && chunk.error) {
					this.logService.error(`[neocode orchestrator] analyzePlan stream error: ${chunk.error}`);
					throw new Error(chunk.error);
				}
			}
			this.logService.info(`[neocode orchestrator] analyzePlan: stream done. rawJsonLen=${rawJson.length} preview=${rawJson.slice(0, 100)}`);

			// Extract JSON from response (model might wrap in code block)
			const jsonMatch = /\{[\s\S]*\}/.exec(rawJson);
			if (jsonMatch) {
				const parsed = JSON.parse(jsonMatch[0]) as ISwarmExecutionPlan;

				// Post-process: enforce minimum complexity for action tasks
				if (hasActionKeyword && parsed.complexity === 'simple') {
					parsed.complexity = 'moderate';
					parsed.reasoning += ' (promovido para multi-agente por palavras-chave de ação)';
				}

				if (!includeAgents) {
					parsed.agents = [];
					return parsed;
				}

				// If complexity > simple but no agents, create a default pair
				if (parsed.complexity !== 'simple' && (!parsed.agents || parsed.agents.length === 0)) {
					parsed.agents = [
						{ id: 'agent-1', name: 'Scout', emoji: '🔍', role: 'researcher', task: `Analise o contexto da tarefa: "${prompt}". Liste os arquivos relevantes com list_dir e read_file. Crie um plano de implementação detalhado.` },
						{ id: 'agent-2', name: 'Forge', emoji: '⚒️', role: 'coder', task: `Implemente a solução para: "${prompt}". Use write_file para criar novos arquivos e edit_file para modificar existentes. Escreva o código completo e funcional.` },
					];
				}

				// Assign sequential IDs if missing
				if (Array.isArray(parsed.agents)) {
					parsed.agents.forEach((agent, i) => {
						if (!agent.id) { agent.id = `agent-${i + 1}`; }
					});
				}
				return this.enforceAgentCount(parsed, prompt, preferredAgentCount);
			}
		} catch (err) {
			this.logService.warn(`[neocode orchestrator] Failed to parse plan JSON (provider: ${provider.name} ${provider.selectedModel ?? provider.models[0] ?? ''}, authMethod: ${provider.authMethod}):`, rawJson, err);
		}

		// Fallback: use action-aware defaults
		if (hasActionKeyword) {
			if (!includeAgents) {
				return {
					complexity: 'moderate',
					reasoning: 'Pré-análise: tarefa com palavras-chave de ação requer execução multi-agente.',
					agents: [],
					needsTimeBudget: false,
				};
			}
			return this.enforceAgentCount(this.buildFallbackMultiAgentPlan(prompt), prompt, preferredAgentCount);
		}

		const fallbackSimplePlan: ISwarmExecutionPlan = {
			complexity: 'simple',
			reasoning: 'Análise automática não disponível — usando modo direto.',
			agents: [],
			needsTimeBudget: false,
		};
		return includeAgents ? this.enforceAgentCount(fallbackSimplePlan, prompt, preferredAgentCount) : fallbackSimplePlan;
	}

	/** Creates a multi-agent plan without calling the LLM — used when /swarm is forced or as fallback. */
	private async buildForcedMultiAgentPlan(
		prompt: string,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		config: INeocodeSwarmConfig,
		token: CancellationToken,
		preferredAgentCount?: number,
	): Promise<ISwarmExecutionPlan> {
		// Still ask the LLM for the plan but bias it strongly toward multi-agent
		const plan = await this.analyzePlan(prompt, config, provider, apiKey, extraEnv, token, preferredAgentCount, true);

		// Force at least moderate with multi-agent
		if (plan.complexity === 'simple') {
			return this.enforceAgentCount(this.buildFallbackMultiAgentPlan(prompt), prompt, preferredAgentCount);
		}
		return this.enforceAgentCount(plan, prompt, preferredAgentCount);
	}

	private buildFallbackMultiAgentPlan(prompt: string): ISwarmExecutionPlan {
		return {
			complexity: 'moderate',
			reasoning: 'Modo multi-agente ativado para garantir execução com ferramentas de código.',
			agents: [
				{
					id: 'agent-1',
					name: 'Scout',
					emoji: '🔍',
					role: 'researcher',
					task: `Analise o contexto e a estrutura do projeto para a tarefa: "${prompt}". Use list_dir(".") para ver a estrutura, read_file para ler arquivos relevantes. Produza um relatório com o plano de implementação detalhado.`,
				},
				{
					id: 'agent-2',
					name: 'Forge',
					emoji: '⚒️',
					role: 'coder',
					task: `Implemente a tarefa: "${prompt}". Use write_file para criar novos arquivos, edit_file para modificar existentes e run_terminal para executar comandos quando necessário. Escreva o código completo, funcional e bem documentado.`,
				},
			],
			needsTimeBudget: false,
		};
	}

	// ─── Plan display ─────────────────────────────────────────────────────────

	private emitPlan(plan: ISwarmExecutionPlan, onProgress: (parts: IChatProgress[]) => void): void {
		const complexityEmoji = { simple: '🟢', moderate: '🟡', complex: '🔴' }[plan.complexity];
		const complexityLabel = { simple: 'Simples', moderate: 'Moderada', complex: 'Complexa' }[plan.complexity];

		let md = `\n---\n\n## 🧠 Orquestrador — Plano de Execução\n\n`;
		md += `> 💭 **Raciocínio:** ${plan.reasoning}\n\n`;
		md += `**Complexidade:** ${complexityEmoji} ${complexityLabel} &nbsp;|&nbsp; **Agentes:** ${plan.agents.length} em paralelo\n\n`;

		if (plan.agents.length > 0) {
			md += `### 👥 Agentes Despachados\n\n`;
			for (const agent of plan.agents) {
				const taskPreview = agent.task.length > 100 ? `${agent.task.substring(0, 100)}...` : agent.task;
				md += `- **${agent.emoji} ${agent.name}** (\`${agent.role}\`) — ${taskPreview}\n`;
			}
			md += `\n`;
		}

		md += `---\n\n`;
		onProgress([{ kind: 'markdownContent', content: new MarkdownString(md) }]);
	}

	// ─── Execution setup ──────────────────────────────────────────────────────

	private getDefaultTimeBudgetForComplexity(complexity: ISwarmExecutionPlan['complexity']): number {
		switch (complexity) {
			case 'complex':
				return 60;
			case 'moderate':
				return 30;
			default:
				return DEFAULT_TIME_BUDGET_MINUTES;
		}
	}

	private formatDefinedTimeBudget(minutes: number): string {
		const safeMinutes = Math.max(MIN_TIME_BUDGET_MINUTES, minutes);
		const hours = Math.floor(safeMinutes / 60);
		const remainingMinutes = safeMinutes % 60;
		if (hours > 0 && remainingMinutes > 0) {
			return localize('neocodeSwarm.timeLabel.hoursAndMinutes', "{0}h {1}min", hours, remainingMinutes);
		}
		if (hours > 0) {
			return localize('neocodeSwarm.timeLabel.hoursOnly', "{0}h", hours);
		}
		return localize('neocodeSwarm.timeLabel.minutesOnly', "{0}min", remainingMinutes);
	}

	private enforceAgentCount(plan: ISwarmExecutionPlan, prompt: string, requestedAgentCount: number | undefined): ISwarmExecutionPlan {
		if (typeof requestedAgentCount !== 'number') {
			return plan;
		}

		const target = Math.max(MIN_AGENT_COUNT, Math.min(MAX_AGENT_COUNT, requestedAgentCount));
		const normalizedAgents = Array.isArray(plan.agents) ? plan.agents.map(agent => ({ ...agent })) : [];

		if (normalizedAgents.length > target) {
			normalizedAgents.length = target;
		}

		const fallbackFocusByIndex = [
			'mapear a base de código e listar arquivos críticos',
			'implementar a solução principal com write_file e edit_file',
			'revisar qualidade, bugs e riscos',
			'validar testes e cobertura',
			'otimizar performance e robustez',
			'verificar integração e regressões',
			'refinar documentação técnica',
			'auditar erros silenciosos e observabilidade',
		];

		while (normalizedAgents.length < target) {
			const index = normalizedAgents.length;
			const fallbackName = FALLBACK_AGENT_NAMES[index % FALLBACK_AGENT_NAMES.length];
			const focus = fallbackFocusByIndex[index % fallbackFocusByIndex.length];
			normalizedAgents.push({
				id: `agent-${index + 1}`,
				name: fallbackName,
				emoji: index % 2 === 0 ? '🧠' : '⚙️',
				role: index % 3 === 1 ? 'coder' : index % 3 === 2 ? 'reviewer' : 'researcher',
				task: `Apoie a tarefa do usuário: "${prompt}". Foque em ${focus}. Use as ferramentas necessárias para produzir entregáveis concretos.`,
			});
		}

		for (const [index, agent] of normalizedAgents.entries()) {
			agent.id = `agent-${index + 1}`;
			agent.name = agent.name || FALLBACK_AGENT_NAMES[index % FALLBACK_AGENT_NAMES.length];
			agent.emoji = agent.emoji || (index % 2 === 0 ? '🧠' : '⚙️');
			agent.role = agent.role || 'custom';
			agent.task = agent.task || `Contribua com uma parte específica da tarefa: "${prompt}".`;
		}

		return {
			...plan,
			complexity: target > 1 && plan.complexity === 'simple' ? 'moderate' : plan.complexity,
			agents: normalizedAgents,
		};
	}

	// ─── Parallel agent execution ─────────────────────────────────────────────

	private async executeAgentsInParallel(
		plan: ISwarmExecutionPlan,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		toolExecutor: INeocodeToolExecutor,
		systemPrompt: string,
		config: INeocodeSwarmConfig,
		sessionId: string,
		timeBudgetMinutes: number | undefined,
		onProgress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
		resolveApiKey?: (providerId: string) => Promise<string | undefined>,
		requestedParallelism?: number,
	): Promise<Map<string, string>> {
		const results = new Map<string, string>();
		const configuredConcurrency = Math.max(1, Math.floor(config.advanced.concurrency ?? plan.agents.length));
		const concurrency = typeof requestedParallelism === 'number'
			? Math.max(1, Math.min(plan.agents.length, Math.floor(requestedParallelism)))
			: Math.max(1, Math.min(plan.agents.length, configuredConcurrency));
		this.logService.info(`[neocode orchestrator] Parallel execution configured. agents=${plan.agents.length} concurrency=${concurrency}`);
		const agentTimeBudgetSeconds = timeBudgetMinutes
			? Math.max(60, Math.floor((timeBudgetMinutes * 60) / Math.max(1, plan.agents.length)))
			: undefined;

		const budgetCancellation = timeBudgetMinutes ? new CancellationTokenSource(token) : undefined;
		const executionToken = budgetCancellation?.token ?? token;
		let budgetExceeded = false;
		let budgetTimer: ReturnType<typeof setTimeout> | undefined;

		if (budgetCancellation && timeBudgetMinutes) {
			budgetTimer = setTimeout(() => {
				budgetExceeded = true;
				budgetCancellation.cancel();
			}, timeBudgetMinutes * 60_000);
		}

		try {
			// Build per-agent task factories (lazy to allow concurrency batching)
			const taskFactories = plan.agents.map((agentPlan, agentIndex) => async () => {
				let agentProvider = this.selectProviderForAgent(agentPlan, config, provider, agentIndex);
				// Resolve the agent's API key: reuse the already-loaded key if same provider,
				// otherwise ask the caller (who has secretService access) for the stored secret.
				let agentApiKey: string | undefined;
				if (agentProvider.id === provider.id) {
					agentApiKey = apiKey;
				} else if (resolveApiKey) {
					agentApiKey = await resolveApiKey(agentProvider.id);
				}

				// CLI-based providers (anthropic login, openai login) return undefined from resolveApiKey
				// because their credentials are not plain API tokens. Fall back to the orchestrator's
				// provider so the agent can still execute via QwenRuntimeAdapter.
				if (!agentApiKey) {
					this.logService.warn(`[neocode orchestrator] Agent ${agentPlan.name} provider "${agentProvider.name}" has no adapter-compatible key — falling back to orchestrator provider "${provider.name}"`);
					agentProvider = provider;
					agentApiKey = apiKey;
				}

				// Propagate extraEnv (e.g. QWEN_OAUTH_RESOURCE_URL) so the agent uses the
				// correct resource endpoint when the orchestrator provider uses qwen-oauth.
				const agentExtraEnv = agentProvider.id === provider.id ? extraEnv : undefined;

				const runner = this._register(this.instantiationService.createInstance(NeocodeSwarmAgentRunner));
				const orchestrationContext = [
					timeBudgetMinutes
						? `Orçamento total do enxame: ${timeBudgetMinutes} minutos.`
						: 'Orçamento total do enxame: tempo indeterminado.',
					agentTimeBudgetSeconds ? `Tempo de referência para este agente: ~${agentTimeBudgetSeconds} segundos.` : '',
					'Atue de forma objetiva e priorize entregáveis concretos dentro do orçamento.',
				].filter(Boolean).join('\n');

				const runOptions: ISwarmAgentRunOptions = {
					plan: agentPlan,
					provider: agentProvider,
					apiKey: agentApiKey,
					extraEnv: agentExtraEnv,
					toolExecutor,
					systemPrompt,
					context: orchestrationContext,
					onUpdate: (update: IAgentProgressUpdate) => {
						this.activityService.updateAgent(sessionId, update);
						this.emitAgentUpdate(update, agentPlan, onProgress);
					},
				};

				const result = await runner.run(runOptions, executionToken);
				results.set(agentPlan.id, result);
			});

			// Execute in batches respecting concurrency limit
			for (let i = 0; i < taskFactories.length; i += concurrency) {
				if (executionToken.isCancellationRequested) { break; }
				const batch = taskFactories.slice(i, i + concurrency).map(f => f());
				await Promise.all(batch);
			}
		} finally {
			if (budgetTimer) {
				clearTimeout(budgetTimer);
			}
			budgetCancellation?.dispose();
		}

		if (budgetExceeded) {
			this.activityService.setOrchestratorStatus(sessionId, '⏱️ Orçamento de tempo atingido, finalizando com resultados parciais');
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`> ⏱️ Orçamento de ${timeBudgetMinutes} minutos atingido. Finalizando com os resultados parciais obtidos.\n\n`),
			}]);
		}

		return results;
	}

	private selectProviderForAgent(
		agentPlan: ISwarmAgentPlan,
		config: INeocodeSwarmConfig,
		defaultProvider: INeocodeSwarmProviderConfig,
		agentIndex: number = 0,
	): INeocodeSwarmProviderConfig {
		// Check if an agent config with this role specifies a provider explicitly
		const agentConfig = config.agents.find(a => a.role === agentPlan.role && a.active && a.providerId);
		if (agentConfig?.providerId) {
			const agentProvider = config.providers.find(p => p.id === agentConfig.providerId && p.enabled);
			if (agentProvider) { return agentProvider; }
		}
		// Round-robin across all enabled providers so each agent uses a different model
		const enabledProviders = config.providers.filter(p => p.enabled);
		if (enabledProviders.length > 1) {
			return enabledProviders[agentIndex % enabledProviders.length];
		}
		return defaultProvider;
	}

	private emitAgentUpdate(
		update: IAgentProgressUpdate,
		plan: ISwarmAgentPlan,
		onProgress: (parts: IChatProgress[]) => void,
	): void {
		if (!update.log) { return; }

		const { log } = update;
		const prefix = `${plan.emoji} **${plan.name}**`;

		if (update.status === 'done') {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n${prefix} ✅ _Concluído_\n`),
			}]);
		} else if (log.type === 'tool') {
			// Show tool usage as persistent markdown so it stays visible
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n> ${prefix} 🔧 \`${log.content}\`\n`),
			}]);
		} else if (log.type === 'thinking') {
			onProgress([{
				kind: 'progressMessage',
				content: new MarkdownString(`_${prefix} 💭 ${log.content}_`),
			}]);
		} else if (log.type === 'error') {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n${prefix} ❌ _Erro: ${log.content}_\n`),
			}]);
		}
	}

	// ─── Result synthesis ─────────────────────────────────────────────────────

	private async synthesizeResults(
		originalPrompt: string,
		plan: ISwarmExecutionPlan,
		agentResults: Map<string, string>,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		systemPrompt: string,
		token: CancellationToken,
	): Promise<string> {
		const resultBlocks = plan.agents.map(agent => {
			const result = agentResults.get(agent.id) ?? '(sem resultado)';
			return `### ${agent.emoji} ${agent.name} (${agent.role})\n${result}`;
		}).join('\n\n');

		const synthesisPrompt = `## Tarefa Original do Usuário
${originalPrompt}

## Resultados dos Agentes do Enxame
${resultBlocks}

## Sua Missão
Você é o orquestrador. Sintetize os resultados acima em uma resposta coesa, completa e útil para o usuário.
- Integre os resultados de todos os agentes de forma harmoniosa
- Elimine redundâncias
- Destaque o que foi feito, o que foi descoberto e quais são os próximos passos (se houver)
- Seja claro e objetivo`;

		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, apiKey, extraEnv);

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: synthesisPrompt,
			systemPrompt,
			includePartialMessages: false,
			maxToolCallRounds: 0,
		};

		let synthesis = '';
		try {
			const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);
			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}
				if (chunk.type === 'content' && chunk.value) {
					synthesis += chunk.value;
				}
			}
		} catch (err) {
			this.logService.error('[neocode orchestrator] Synthesis failed:', err);
			// Fallback: return raw agent results
			return resultBlocks;
		}

		return synthesis || resultBlocks;
	}

	// ─── Simple single-agent mode ─────────────────────────────────────────────

	private async runSingleAgent(
		prompt: string,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		toolExecutor: INeocodeToolExecutor,
		systemPrompt: string,
		onProgress: (parts: IChatProgress[]) => void,
		token: CancellationToken,
	): Promise<void> {
		this.logService.info(`[neocode orchestrator] runSingleAgent: provider=${provider.name} (${provider.type}/${provider.authMethod}) hasApiKey=${!!apiKey}`);

		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, apiKey, extraEnv);

		const sdkOptions: IQwenSdkTaskOptions = {
			prompt,
			systemPrompt,
			includePartialMessages: true,
			permissionMode: 'default',
			toolExecutor,
			maxToolCallRounds: 15,
		};

		const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, sdkOptions, token);
		let hasContent = false;

		for await (const chunk of stream) {
			if (token.isCancellationRequested) {
				break;
			}
			if (chunk.type === 'content' && chunk.value) {
				hasContent = true;
				onProgress([{ kind: 'markdownContent', content: new MarkdownString(chunk.value) }]);
			} else if (chunk.type === 'tool_call' && chunk.toolName) {
				onProgress([{
					kind: 'progressMessage',
					content: new MarkdownString(`_🔧 \`${chunk.toolName}\`_`),
				}]);
			} else if (chunk.type === 'error' && chunk.error) {
				onProgress([{ kind: 'markdownContent', content: new MarkdownString(`**Erro:** ${chunk.error}`) }]);
			}
		}

		if (!hasContent) {
			this.logService.warn('[neocode orchestrator] runSingleAgent: no content received from provider');
			onProgress([{ kind: 'markdownContent', content: new MarkdownString('_Sem resposta do provedor._') }]);
		} else {
			this.logService.info('[neocode orchestrator] runSingleAgent: completed successfully');
		}
	}
}
