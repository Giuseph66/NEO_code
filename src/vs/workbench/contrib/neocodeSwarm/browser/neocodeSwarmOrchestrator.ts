/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { dirname, extname } from '../../../../base/common/path.js';
import { localize } from '../../../../nls.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../contrib/chat/common/chatService/chatService.js';
import { QwenRuntimeAdapter, IQwenSdkTaskOptions } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { INeocodeToolCall, INeocodeToolExecutor, INeocodeToolResult } from '../../neocode/qwen/common/qwenTypes.js';
import {
	INeocodeSwarmConfig,
	INeocodeSwarmAgentConfig,
	INeocodeSwarmCapabilitiesConfig,
	INeocodeSwarmCommandConfig,
	INeocodeSwarmHookConfig,
	INeocodeSwarmPersonalityConfig,
	INeocodeSwarmProviderConfig,
	INeocodeSwarmSkillConfig,
	NeocodeSwarmProviderType,
	ISwarmExecutionPlan,
	ISwarmAgentPlan,
	SwarmOrchestratorLogKind,
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
const QUICK_TASK_KEYWORDS = /\b(rapido|r[aá]pido|simples|pequeno|pontual|ajuste|ajustar|hotfix|typo|1 arquivo|um arquivo|few lines|quick fix)\b/i;
const DEFAULT_MULTI_AGENT_COUNT = 3;
const MIN_AGENT_COUNT = 1;
const MAX_AGENT_COUNT = 20;
const DEFAULT_TIME_BUDGET_MINUTES = 30;
const MIN_TIME_BUDGET_MINUTES = 1;
const QUICK_SINGLE_AGENT_THRESHOLD_SECONDS = 90;
const ORCHESTRATOR_READ_ONLY_TOOLS = new Set(['read_file', 'list_dir', 'search_files', 'glob_files']);
const SKILL_TYPE_TOOL_MAP: Record<string, ReadonlyArray<string>> = {
	terminal: ['run_terminal'],
	filesystem: ['read_file', 'write_file', 'edit_file', 'list_dir', 'glob_files', 'apply_patch'],
	search: ['search_files', 'web_fetch'],
	codebase: ['read_file', 'list_dir', 'search_files', 'glob_files', 'edit_file', 'write_file', 'apply_patch'],
};
const FALLBACK_AGENT_NAMES = ['Atlas', 'Forge', 'Nova', 'Sage', 'Echo', 'Rex', 'Luna', 'Zara', 'Orion', 'Bolt', 'Iris', 'Storm', 'Hex', 'Blaze', 'Scout'];
const CAPABILITY_PHASE_TIMEOUT_SECONDS = 20;
const MAX_CAPABILITY_INSTRUCTION_CHARS = 3000;
const MAX_ORCHESTRATION_ROUNDS = 4;
const MAX_DYNAMIC_AGENTS_PER_SESSION = 20;
const MIN_AGENT_RESULT_LENGTH_FOR_COMPLETION = 80;
const QUOTA_CIRCUIT_BREAKER_MIN_ERRORS = 3;
const QUOTA_CIRCUIT_BREAKER_RATIO = 0.35;
const MIN_AGENT_HARD_TIMEOUT_MS = 12_000;
const DEFAULT_AGENT_HARD_TIMEOUT_MS = 120_000;
const MAX_SYNTHESIS_TIMEOUT_MS = 20_000;
const EXECUTABLE_COMMAND_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ps1', '.py', '.js', '.mjs', '.cjs']);
const INSTRUCTION_COMMAND_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.toml', '.json', '.yaml', '.yml']);
const TOOL_NAME_ALIASES: Record<string, string[]> = {
	read_file: ['Read', 'ReadFile'],
	write_file: ['Write', 'WriteFile'],
	edit_file: ['Edit', 'MultiEdit', 'EditFile', 'Patch'],
	apply_patch: ['Edit', 'Patch', 'MultiEdit'],
	list_dir: ['List', 'LS'],
	search_files: ['Search', 'Grep'],
	glob_files: ['Glob'],
	run_terminal: ['Bash', 'Terminal', 'Shell'],
	web_fetch: ['WebFetch', 'Fetch', 'HTTP'],
};

interface ICapabilityRuntimeCommand {
	sourceType: 'hook' | 'command';
	sourceName: string;
	command: string;
}

interface ICapabilityPhaseInstruction {
	sourceType: 'hook' | 'command';
	sourceName: string;
	content: string;
}

interface ICapabilityToolRule {
	sourceName: string;
	matcher?: string;
	action: 'command' | 'instruction' | 'block';
	command?: string;
	instruction?: string;
	reason?: string;
}

interface IHookDispatchResult {
	preAgentCommands: ICapabilityRuntimeCommand[];
	postAgentCommands: ICapabilityRuntimeCommand[];
	preToolRules: ICapabilityToolRule[];
	postToolRules: ICapabilityToolRule[];
	preAgentInstructions: ICapabilityPhaseInstruction[];
	postAgentInstructions: ICapabilityPhaseInstruction[];
	warnings: string[];
}

interface IAgentCapabilityProfile {
	allowedTools?: Set<string>;
	systemPromptAddon?: string;
	contextAddon?: string;
	preAgentCommands: ICapabilityRuntimeCommand[];
	postAgentCommands: ICapabilityRuntimeCommand[];
	preAgentInstructions: ICapabilityPhaseInstruction[];
	postAgentInstructions: ICapabilityPhaseInstruction[];
	preToolRules: ICapabilityToolRule[];
	postToolRules: ICapabilityToolRule[];
	warnings: string[];
}

interface IAgentRoundWorkItem {
	agentPlan: ISwarmAgentPlan;
	round: number;
	additionalContext?: string;
	taskOverride?: string;
}

interface IAgentRoundResult {
	agentId: string;
	agentName: string;
	round: number;
	result: string;
	error?: string;
	task: string;
}

interface IOrchestratorNextAction {
	type: 'followup' | 'spawn';
	targetAgentId?: string;
	task: string;
	reason?: string;
	role?: string;
	name?: string;
}

interface IOrchestratorRoundDecision {
	complete: boolean;
	summary: string;
	actions: IOrchestratorNextAction[];
}

interface ISwarmExecutionLoopOutcome {
	results: Map<string, string>;
	budgetExceeded: boolean;
	quotaCircuitBroken: boolean;
	totalQuotaFailures: number;
}

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
		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString('_📚 Orquestrador inspecionando o projeto para estimar esforço..._'),
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
					shouldUseSwarm: true,
				})
				: this.analyzePlan(prompt, config, provider, apiKey, extraEnv, toolExecutor, token, undefined, false);

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

		// Step 3: Let the orchestrator execute directly when task is tiny/quick.
		if (this.shouldHandleWithSingleAgent(preAnalysisPlan, prompt, !!forceMultiAgent)) {
			this.logService.info(`[neocode orchestrator] Single-agent path selected by pre-analysis. complexity=${preAnalysisPlan.complexity} shouldUseSwarm=${preAnalysisPlan.shouldUseSwarm} estimatedEffortSeconds=${preAnalysisPlan.estimatedEffortSeconds ?? 'n/a'}`);
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
				toolExecutor,
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
				toolExecutor,
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
		// Start activity session
		const budgetSeconds = (preferences.timeMode === 'defined' && preferences.timeBudgetMinutes)
			? preferences.timeBudgetMinutes * 60
			: undefined;
		this.activityService.startSession(sessionId, plan, budgetSeconds);
		this.activityService.setOrchestratorStatus(sessionId, `🚀 ${plan.agents.length} agentes em execução`);
		this.appendOrchestratorLog(sessionId, 'dispatch', `Sessão iniciada com ${plan.agents.length} agentes.`, {
			details: `complexity=${plan.complexity}; timeMode=${preferences.timeMode}; budgetMinutes=${preferences.timeBudgetMinutes ?? 'indeterminado'}`,
		});

		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString(`_🚀 Iniciando ${plan.agents.length} agentes em paralelo..._`),
		}]);

		// Step 8: Execute agents in parallel
		const loopOutcome = await this.executeAgentsWithInteractionLoop(
			prompt, plan, provider, apiKey, extraEnv, toolExecutor, systemPrompt, config, sessionId,
			preferences.timeBudgetMinutes, onProgress, token, resolveApiKey, preferences.agentCount,
		);
		const agentResults = loopOutcome.results;

		if (token.isCancellationRequested) {
			this.activityService.completeSession(sessionId);
			return;
		}
		if (loopOutcome.quotaCircuitBroken) {
			const summary = this.buildPartialResultsSummary(plan, agentResults);
			this.activityService.setOrchestratorStatus(sessionId, '⛔ Execução interrompida por limite de quota do provedor');
			this.activityService.completeSession(sessionId);
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					`> ⛔ **Execução interrompida:** muitos erros de quota/rate-limit detectados.\n\n${summary}`,
				),
			}]);
			return;
		}
		if (loopOutcome.budgetExceeded) {
			const summary = this.buildPartialResultsSummary(plan, agentResults);
			this.activityService.setOrchestratorStatus(sessionId, '⏱️ Tempo limite atingido (execução encerrada)');
			this.activityService.completeSession(sessionId);
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(
					`> ⏱️ **Tempo limite atingido:** execução encerrada no orçamento definido.\n\n${summary}`,
				),
			}]);
			return;
		}

		// Step 9: Synthesize results
		onProgress([{
			kind: 'progressMessage',
			content: new MarkdownString('_🧠 Orquestrador sintetizando resultados dos agentes..._'),
		}]);
		this.activityService.setOrchestratorStatus(sessionId, '🔗 Sintetizando resultados...');
		this.appendOrchestratorLog(sessionId, 'decision', 'Sintetizando resultados finais de todas as rodadas.');

		const synthesis = await this.synthesizeWithTimeout(
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
		toolExecutor: INeocodeToolExecutor,
		token: CancellationToken,
		forceMultiAgent: boolean,
		requestedAgentCount: number,
	): Promise<ISwarmExecutionPlan> {
		try {
			const plan = forceMultiAgent
				? await this.buildForcedMultiAgentPlan(prompt, provider, apiKey, extraEnv, config, toolExecutor, token, requestedAgentCount)
				: await this.analyzePlan(prompt, config, provider, apiKey, extraEnv, toolExecutor, token, requestedAgentCount, true);
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
		toolExecutor: INeocodeToolExecutor,
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
		const projectInspectionRule = `\nANÁLISE DE PROJETO:
- Antes de decidir, use ferramentas de LEITURA para inspecionar o projeto atual (list_dir, glob_files, search_files, read_file).
- Faça inspeção objetiva e curta: estrutura, arquivos-chave e impacto da mudança.
- Se a tarefa parece resolver em segundos (ex: ajuste pequeno em 1 arquivo), prefira execução direta sem enxame.
- Se exigir frentes paralelas (UI + API + testes, múltiplos módulos), prefira enxame.\n`;

		const analysisPrompt = `Você é o ORQUESTRADOR de um enxame de agentes de IA especializados em desenvolvimento de software.

TAREFA DO USUÁRIO:
${prompt}

AGENTES DISPONÍVEIS NO ENXAME: ${agentRoles || 'planner, coder, reviewer, researcher'}
${preferredAgentRule}
${analysisModeRule}
${projectInspectionRule}

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
  "shouldUseSwarm": true,
  "estimatedEffortSeconds": 240,
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
- Não detalhe tarefas de agentes

REGRAS DE DECISÃO RÁPIDA:
- shouldUseSwarm=false quando a tarefa puder ser feita de forma segura e rápida por um único agente
- shouldUseSwarm=true quando houver benefício real de paralelismo
- estimatedEffortSeconds deve refletir sua estimativa após inspecionar o projeto`;

		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, apiKey, extraEnv);

		this.logService.info(`[neocode orchestrator] analyzePlan: calling adapter. protocol=${providerConfig.protocol} authType=${providerConfig.authType} model=${providerConfig.modelId} hasApiKey=${!!apiKey}`);

		const planningToolExecutor = this.createReadOnlyPlanningExecutor(toolExecutor);
		const sdkOptions: IQwenSdkTaskOptions = {
			prompt: analysisPrompt,
			systemPrompt: 'Você é um orquestrador de agentes IA para desenvolvimento de software. Responda APENAS com JSON válido. Nunca use markdown ou explicações fora do JSON.',
			includePartialMessages: false,
			toolExecutor: planningToolExecutor,
			maxToolCallRounds: includeAgents ? 4 : 6,
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
				parsed.shouldUseSwarm = this.resolveShouldUseSwarm(parsed, hasActionKeyword);
				if (typeof parsed.estimatedEffortSeconds !== 'number' || !Number.isFinite(parsed.estimatedEffortSeconds) || parsed.estimatedEffortSeconds <= 0) {
					parsed.estimatedEffortSeconds = parsed.shouldUseSwarm ? 240 : 45;
				}

				if (!includeAgents) {
					parsed.agents = [];
					return parsed;
				}

				// If complexity > simple but no agents, create a default pair
				if (parsed.complexity !== 'simple' && (!parsed.agents || parsed.agents.length === 0)) {
					parsed.agents = [
						{ id: 'agent-1', name: 'Forge', emoji: '⚒️', role: 'coder', task: `Implemente a frente de interface/fluxo da tarefa: "${prompt}". Use edit_file para modificar arquivos existentes e write_file para novos arquivos quando necessário.` },
						{ id: 'agent-2', name: 'Nova', emoji: '🧩', role: 'coder', task: `Implemente a frente de backend/serviços da tarefa: "${prompt}". Crie/ajuste endpoints, lógica e integração usando write_file/edit_file.` },
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
					shouldUseSwarm: true,
					estimatedEffortSeconds: 240,
				};
			}
			return this.enforceAgentCount(this.buildFallbackMultiAgentPlan(prompt), prompt, preferredAgentCount);
		}

		const fallbackSimplePlan: ISwarmExecutionPlan = {
			complexity: 'simple',
			reasoning: 'Análise automática não disponível — usando modo direto.',
			agents: [],
			needsTimeBudget: false,
			shouldUseSwarm: false,
			estimatedEffortSeconds: 30,
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
		toolExecutor: INeocodeToolExecutor,
		token: CancellationToken,
		preferredAgentCount?: number,
	): Promise<ISwarmExecutionPlan> {
		// Still ask the LLM for the plan but bias it strongly toward multi-agent
		const plan = await this.analyzePlan(prompt, config, provider, apiKey, extraEnv, toolExecutor, token, preferredAgentCount, true);

		// Force at least moderate with multi-agent
		if (plan.complexity === 'simple') {
			return this.enforceAgentCount(this.buildFallbackMultiAgentPlan(prompt), prompt, preferredAgentCount);
		}
		return this.enforceAgentCount({ ...plan, shouldUseSwarm: true }, prompt, preferredAgentCount);
	}

	private buildFallbackMultiAgentPlan(prompt: string): ISwarmExecutionPlan {
		return {
			complexity: 'moderate',
			reasoning: 'Modo multi-agente ativado para garantir execução com ferramentas de código.',
			agents: [
				{
					id: 'agent-1',
					name: 'Forge',
					emoji: '⚒️',
					role: 'coder',
					task: `Implemente a frente de UI/fluxos da tarefa: "${prompt}". Use read_file/list_dir para contexto mínimo e foque em escrever código com edit_file/write_file.`,
				},
				{
					id: 'agent-2',
					name: 'Nova',
					emoji: '🧩',
					role: 'coder',
					task: `Implemente API/serviços/integração da tarefa: "${prompt}". Use write_file/edit_file para entregar endpoints, regras e integração funcional.`,
				},
			],
			needsTimeBudget: false,
			shouldUseSwarm: true,
			estimatedEffortSeconds: 240,
		};
	}

	// ─── Plan display ─────────────────────────────────────────────────────────

	private emitPlan(plan: ISwarmExecutionPlan, onProgress: (parts: IChatProgress[]) => void): void {
		const complexityEmoji = { simple: '🟢', moderate: '🟡', complex: '🔴' }[plan.complexity];
		const complexityLabel = { simple: 'Simples', moderate: 'Moderada', complex: 'Complexa' }[plan.complexity];

		let md = `\n---\n\n## 🧠 Orquestrador — Plano de Execução\n\n`;
		md += `> 💭 **Análise Estratégica:** ${plan.reasoning}\n\n`;
		md += `**Complexidade:** ${complexityEmoji} ${complexityLabel} &nbsp;|&nbsp; **Agentes:** ${plan.agents.length} em paralelo\n\n`;

		if (plan.agents.length > 0) {
			md += `### 👥 Squad de Agentes\n\n`;
			md += `Estes agentes trabalharão simultaneamente para resolver a tarefa:\n\n`;

			for (const agent of plan.agents) {
				const roleLabel = this.getRoleLabel(agent.role);
				md += `<details>\n`;
				md += `<summary><b>${agent.emoji} ${agent.name}</b> — <i>${roleLabel}</i></summary>\n\n`;
				md += `> **Missão:** ${agent.task}\n\n`;
				md += `</details>\n`;
			}
			md += `\n`;

			md += `### 🔄 Fluxo de Trabalho (Workflow)\n\n`;
			md += `1. **Paralelismo:** Os agentes executarão suas missões em frentes distintas.\n`;
			md += `2. **Execução:** Usarão ferramentas de edição de arquivos e terminal.\n`;
			md += `3. **Sintese:** No final, consolidarei todos os entregáveis em uma solução única.\n\n`;
		}

		md += `---\n\n`;
		onProgress([{ kind: 'markdownContent', content: new MarkdownString(md, { supportHtml: true }) }]);
	}

	private getRoleLabel(role: string): string {
		switch (role) {
			case 'coder': return 'Implementador de Código';
			case 'reviewer': return 'Revisor de Qualidade';
			case 'researcher': return 'Pesquisador / Arquiteto';
			case 'planner': return 'Planejador de Tarefas';
			default: return 'Especialista';
		}
	}

	private getEmojiForRole(role: string): string {
		switch (role) {
			case 'reviewer':
				return '✅';
			case 'researcher':
				return '🔎';
			case 'planner':
				return '🧭';
			case 'debugger':
				return '🩺';
			default:
				return '⚙️';
		}
	}

	private appendOrchestratorLog(
		sessionId: string,
		kind: SwarmOrchestratorLogKind,
		content: string,
		options?: {
			details?: string;
			round?: number;
			agentId?: string;
		},
	): void {
		this.activityService.appendOrchestratorLog(sessionId, {
			kind,
			content,
			details: options?.details,
			round: options?.round,
			agentId: options?.agentId,
		});
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
			'implementar telas e fluxos de interface com edit_file/write_file',
			'implementar endpoints, serviços e regras de negócio',
			'integrar frontend com backend e tratar erros de ponta a ponta',
			'criar/ajustar testes automatizados para os fluxos implementados',
			'corrigir bugs e completar lacunas de implementação',
			'otimizar performance e robustez dos fluxos principais',
			'validar integração final e regressões funcionais',
			'ajustar documentação mínima somente do que foi implementado',
		];

		while (normalizedAgents.length < target) {
			const index = normalizedAgents.length;
			const fallbackName = FALLBACK_AGENT_NAMES[index % FALLBACK_AGENT_NAMES.length];
			const focus = fallbackFocusByIndex[index % fallbackFocusByIndex.length];
			const rolePattern: Array<'coder' | 'reviewer' | 'researcher'> = ['coder', 'coder', 'coder', 'reviewer', 'coder', 'coder', 'reviewer', 'researcher'];
			normalizedAgents.push({
				id: `agent-${index + 1}`,
				name: fallbackName,
				emoji: index % 2 === 0 ? '🧠' : '⚙️',
				role: rolePattern[index % rolePattern.length],
				task: `Apoie a tarefa do usuário: "${prompt}". Foque em ${focus}. Use as ferramentas necessárias para produzir entregáveis concretos.`,
			});
		}

		const userRequestedDocOrArchitecture = /\b(doc|docs|documenta[cç][aã]o|arquitetura|diagrama|especifica[cç][aã]o|spec)\b/i.test(prompt);
		let researcherCount = 0;
		for (const [index, agent] of normalizedAgents.entries()) {
			if (userRequestedDocOrArchitecture) {
				break;
			}

			const task = (agent.task || '').toLowerCase();
			const looksLikeDocOnly = /(document|arquitet|relat[oó]rio|mape|an[aá]lis|pesquis)/i.test(task);
			const hasImplementationSignals = /(implement|cod|endpoint|api|tela|ui|write_file|edit_file|test|integra)/i.test(task);

			if (agent.role === 'researcher') {
				researcherCount++;
			}

			// Keep at most one researcher in non-documentation tasks.
			if (agent.role === 'researcher' && researcherCount > 1) {
				agent.role = 'coder';
				agent.task = this.buildImplementationFallbackTask(prompt, index);
				continue;
			}

			// If the task is analysis/docs only, force implementation-oriented work.
			if (looksLikeDocOnly && !hasImplementationSignals) {
				agent.role = agent.role === 'reviewer' ? 'reviewer' : 'coder';
				agent.task = this.buildImplementationFallbackTask(prompt, index);
			}
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

	private createReadOnlyPlanningExecutor(toolExecutor: INeocodeToolExecutor): INeocodeToolExecutor {
		return {
			getTools: () => toolExecutor.getTools().filter(tool => ORCHESTRATOR_READ_ONLY_TOOLS.has(tool.name)),
			execute: async (call: INeocodeToolCall): Promise<INeocodeToolResult> => {
				if (!ORCHESTRATOR_READ_ONLY_TOOLS.has(call.name)) {
					return {
						id: call.id,
						content: `Tool não permitida na análise do orquestrador: ${call.name}`,
						isError: true,
					};
				}
				return toolExecutor.execute(call);
			},
		};
	}

	private resolveShouldUseSwarm(plan: ISwarmExecutionPlan, hasActionKeyword: boolean): boolean {
		if (typeof plan.shouldUseSwarm === 'boolean') {
			return plan.shouldUseSwarm;
		}
		if (typeof plan.estimatedEffortSeconds === 'number') {
			return plan.estimatedEffortSeconds > QUICK_SINGLE_AGENT_THRESHOLD_SECONDS;
		}
		if (plan.complexity === 'complex') {
			return true;
		}
		return hasActionKeyword;
	}

	private shouldHandleWithSingleAgent(plan: ISwarmExecutionPlan, prompt: string, forceMultiAgent: boolean): boolean {
		if (forceMultiAgent) {
			return false;
		}
		if (plan.complexity === 'simple') {
			return true;
		}
		if (plan.shouldUseSwarm === false) {
			return true;
		}
		if (typeof plan.estimatedEffortSeconds === 'number' && plan.estimatedEffortSeconds <= QUICK_SINGLE_AGENT_THRESHOLD_SECONDS) {
			// If the model estimated a short task, prefer direct execution unless the user explicitly asked for swarm.
			return !/\b(enxame|swarm|v[aá]rios agentes|multi[- ]?agente)\b/i.test(prompt);
		}
		if (QUICK_TASK_KEYWORDS.test(prompt)) {
			return !/\b(enxame|swarm|v[aá]rios agentes|multi[- ]?agente)\b/i.test(prompt);
		}
		return false;
	}

	private buildImplementationFallbackTask(prompt: string, index: number): string {
		const implementationTracks = [
			'implementar interface/telas e fluxo de interação principal com edit_file/write_file',
			'implementar endpoints/API e regras de negócio no backend',
			'integrar frontend e backend, incluindo tratamento de erros',
			'criar ou ajustar testes automatizados dos fluxos implementados',
			'corrigir bugs e completar lacunas funcionais da entrega',
			'otimizar performance dos caminhos críticos da feature',
		];
		const track = implementationTracks[index % implementationTracks.length];
		return `Implemente uma frente concreta da tarefa: "${prompt}". Foque em ${track}. Entregue código funcional usando edit_file/write_file e valide com run_terminal quando necessário.`;
	}

	// ─── Parallel agent execution ─────────────────────────────────────────────

	private async executeAgentsWithInteractionLoop(
		originalPrompt: string,
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
	): Promise<ISwarmExecutionLoopOutcome> {
		const results = new Map<string, string>();
		const configuredConcurrency = Math.max(1, Math.floor(config.advanced.concurrency ?? plan.agents.length));
		const initialConcurrency = typeof requestedParallelism === 'number'
			? Math.max(1, Math.min(plan.agents.length, Math.floor(requestedParallelism)))
			: Math.max(1, Math.min(plan.agents.length, configuredConcurrency));
		let concurrency = initialConcurrency;
		this.logService.info(`[neocode orchestrator] Parallel execution configured. agents=${plan.agents.length} concurrency=${concurrency}`);
		const agentTimeBudgetSeconds = timeBudgetMinutes
			? Math.max(60, Math.floor((timeBudgetMinutes * 60) / Math.max(1, plan.agents.length)))
			: undefined;
		const executionStartedAt = Date.now();
		const budgetMs = timeBudgetMinutes ? timeBudgetMinutes * 60_000 : undefined;
		let quotaCircuitBroken = false;
		let totalQuotaFailures = 0;

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
			const tokenCache = new Map<string, Promise<string | undefined>>();
			const resolveProviderToken = async (providerId: string): Promise<string | undefined> => {
				let pending = tokenCache.get(providerId);
				if (!pending) {
					pending = (async () => {
						if (providerId === provider.id) {
							return apiKey;
						}
						if (!resolveApiKey) {
							return undefined;
						}
						return resolveApiKey(providerId);
					})();
					tokenCache.set(providerId, pending);
				}
				return pending;
			};

			const enabledProviders = config.providers.filter(candidate => candidate.enabled);
			const adapterReadyProviderIds = new Set<string>();
			for (const enabledProvider of enabledProviders) {
				const tokenForProvider = await resolveProviderToken(enabledProvider.id);
				if (tokenForProvider) {
					adapterReadyProviderIds.add(enabledProvider.id);
				}
			}
			if (adapterReadyProviderIds.size === 0 && apiKey && provider.id) {
				adapterReadyProviderIds.add(provider.id);
			}
			if (adapterReadyProviderIds.size === 0) {
				this.appendOrchestratorLog(sessionId, 'error', 'Nenhum provedor com credencial adapter-compatible disponível para os agentes.');
				return {
					results,
					budgetExceeded,
					quotaCircuitBroken: true,
					totalQuotaFailures,
				};
			}
			if (adapterReadyProviderIds.size === 1 && concurrency > 1) {
				concurrency = 1;
				this.appendOrchestratorLog(sessionId, 'decision', 'Apenas 1 provedor compatível disponível. Concorrência reduzida para 1 para evitar sobrecarga.');
			}

			let round = 1;
			let pendingWork: IAgentRoundWorkItem[] = plan.agents.map(agent => ({ agentPlan: agent, round: 1 }));

			while (pendingWork.length > 0 && !executionToken.isCancellationRequested && round <= MAX_ORCHESTRATION_ROUNDS) {
				if (budgetMs !== undefined && Date.now() - executionStartedAt >= budgetMs) {
					budgetExceeded = true;
					budgetCancellation?.cancel();
					break;
				}
				const roundWork = pendingWork;
				pendingWork = [];

				this.activityService.setOrchestratorStatus(sessionId, `🧠 Rodada ${round}: executando ${roundWork.length} agentes`);
				this.appendOrchestratorLog(sessionId, 'dispatch', `Rodada ${round} iniciada com ${roundWork.length} agente(s).`, { round });

				onProgress([{
					kind: 'progressMessage',
					content: new MarkdownString(`_🔁 Rodada ${round}: ${roundWork.length} agente(s) em execução..._`),
				}]);

				const roundResults = await this.runAgentRoundBatch(
					roundWork,
					concurrency,
					{
						provider,
						apiKey,
						extraEnv,
						toolExecutor,
						systemPrompt,
						config,
						sessionId,
						timeBudgetMinutes,
						agentTimeBudgetSeconds,
						onProgress,
						token: executionToken,
						executionStartedAt,
						budgetMs,
						adapterReadyProviderIds,
						resolveProviderToken,
					},
				);
				if (roundResults.length === 0) {
					if (budgetMs !== undefined && Date.now() - executionStartedAt >= budgetMs) {
						budgetExceeded = true;
					}
					break;
				}

				for (const roundResult of roundResults) {
					results.set(roundResult.agentId, roundResult.result);
					const preview = roundResult.result.slice(0, 260);
					this.appendOrchestratorLog(
						sessionId,
						roundResult.error ? 'error' : 'result',
						`${roundResult.agentName} finalizou a rodada ${round}.`,
						{
							round,
							agentId: roundResult.agentId,
							details: preview,
						},
					);
				}
				const roundQuotaFailures = roundResults.reduce((count, result) => {
					const source = `${result.error ?? ''}\n${result.result ?? ''}`;
					return count + (this.isQuotaOrRateLimitError(source) ? 1 : 0);
				}, 0);
				totalQuotaFailures += roundQuotaFailures;
				if (roundQuotaFailures > 0) {
					const breakerThreshold = Math.max(
						QUOTA_CIRCUIT_BREAKER_MIN_ERRORS,
						Math.ceil(roundResults.length * QUOTA_CIRCUIT_BREAKER_RATIO),
					);
					this.appendOrchestratorLog(
						sessionId,
						'error',
						`Rodada ${round}: ${roundQuotaFailures} falha(s) de quota/rate-limit detectadas.`,
						{ round, details: `threshold=${breakerThreshold}; concurrency=${concurrency}` },
					);

					if (roundQuotaFailures >= breakerThreshold) {
						quotaCircuitBroken = true;
						this.activityService.setOrchestratorStatus(sessionId, '⛔ Quota/rate-limit do provedor atingido');
						onProgress([{
							kind: 'markdownContent',
							content: new MarkdownString('> ⛔ Muitos erros de quota/rate-limit detectados. Encerrando execução para evitar desperdício de tempo e chamadas.'),
						}]);
						break;
					}

					const nextConcurrency = Math.max(1, Math.floor(concurrency / 2));
					if (nextConcurrency !== concurrency) {
						concurrency = nextConcurrency;
						this.appendOrchestratorLog(
							sessionId,
							'decision',
							`Concorrência reduzida para ${concurrency} após erros de quota/rate-limit.`,
							{ round },
						);
					}
				}

				if (executionToken.isCancellationRequested || round >= MAX_ORCHESTRATION_ROUNDS || quotaCircuitBroken) {
					break;
				}

				const decision = await this.decideNextRoundActions(
					originalPrompt,
					plan,
					round,
					roundResults,
					results,
					provider,
					apiKey,
					extraEnv,
					executionToken,
				);

				this.appendOrchestratorLog(sessionId, 'decision', decision.summary, {
					round,
					details: decision.actions.length > 0 ? JSON.stringify(decision.actions, null, 2) : undefined,
				});

				if (decision.complete) {
					this.activityService.setOrchestratorStatus(sessionId, `✅ Orquestrador encerrou na rodada ${round}`);
					break;
				}

				const blockSpawnForStability = roundQuotaFailures > 0;
				for (const action of decision.actions) {
					if (action.type === 'followup') {
						const targetAgent = plan.agents.find(agent => agent.id === action.targetAgentId) ?? plan.agents[0];
						if (!targetAgent) {
							continue;
						}
						pendingWork.push({
							agentPlan: targetAgent,
							round: round + 1,
							taskOverride: action.task,
							additionalContext: action.reason,
						});
						this.appendOrchestratorLog(sessionId, 'dispatch', `Follow-up enviado para ${targetAgent.name}.`, {
							round: round + 1,
							agentId: targetAgent.id,
							details: action.task,
						});
						continue;
					}

					if (action.type === 'spawn') {
						if (blockSpawnForStability) {
							this.appendOrchestratorLog(
								sessionId,
								'decision',
								`Spawn ignorado na rodada ${round + 1} para evitar instabilidade enquanto há erros de quota/rate-limit.`,
								{ round: round + 1 },
							);
							continue;
						}
						const maxAgents = Math.min(MAX_DYNAMIC_AGENTS_PER_SESSION, MAX_AGENT_COUNT);
						if (plan.agents.length >= maxAgents) {
							this.appendOrchestratorLog(sessionId, 'error', 'Limite máximo de agentes atingido, spawn ignorado.', {
								round: round + 1,
								details: `maxAgents=${maxAgents}`,
							});
							continue;
						}

						const agentIndex = plan.agents.length;
						const agentId = `agent-${agentIndex + 1}`;
						const newAgent: ISwarmAgentPlan = {
							id: agentId,
							name: action.name || FALLBACK_AGENT_NAMES[agentIndex % FALLBACK_AGENT_NAMES.length],
							emoji: this.getEmojiForRole(action.role || 'coder'),
							role: action.role || 'coder',
							task: action.task,
						};
						plan.agents.push(newAgent);
						this.activityService.addAgent(sessionId, newAgent);
						pendingWork.push({
							agentPlan: newAgent,
							round: round + 1,
							additionalContext: action.reason,
						});
						this.appendOrchestratorLog(sessionId, 'dispatch', `Novo agente criado: ${newAgent.name}.`, {
							round: round + 1,
							agentId: newAgent.id,
							details: `${newAgent.role} | ${newAgent.task}`,
						});
					}
				}

				if (pendingWork.length === 0) {
					this.appendOrchestratorLog(sessionId, 'info', `Sem novas ações após a rodada ${round}. Encerrando loop.`);
					break;
				}

				round++;
			}
		} finally {
			if (budgetTimer) {
				clearTimeout(budgetTimer);
			}
			budgetCancellation?.dispose();
		}

		if (budgetExceeded) {
			this.appendOrchestratorLog(sessionId, 'status', 'Tempo limite atingido durante execução do enxame.');
		}

		return {
			results,
			budgetExceeded,
			quotaCircuitBroken,
			totalQuotaFailures,
		};
	}

	private async runAgentRoundBatch(
		workItems: IAgentRoundWorkItem[],
		concurrency: number,
		options: {
			provider: INeocodeSwarmProviderConfig;
			apiKey: string | undefined;
			extraEnv: Record<string, string> | undefined;
			toolExecutor: INeocodeToolExecutor;
			systemPrompt: string;
			config: INeocodeSwarmConfig;
			sessionId: string;
			timeBudgetMinutes: number | undefined;
			agentTimeBudgetSeconds: number | undefined;
			onProgress: (parts: IChatProgress[]) => void;
			token: CancellationToken;
			executionStartedAt: number;
			budgetMs?: number;
			adapterReadyProviderIds: Set<string>;
			resolveProviderToken: (providerId: string) => Promise<string | undefined>;
		},
	): Promise<IAgentRoundResult[]> {
		const results: IAgentRoundResult[] = [];
		const taskFactories = workItems.map((workItem, agentIndex) => async () => {
			try {
				const result = await this.executeAgentWorkItem(workItem, agentIndex, options);
				results.push(result);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				results.push({
					agentId: workItem.agentPlan.id,
					agentName: workItem.agentPlan.name,
					round: workItem.round,
					result: `Erro em ${workItem.agentPlan.name}: ${message}`,
					error: message,
					task: workItem.taskOverride ?? workItem.agentPlan.task,
				});
				this.activityService.updateAgent(options.sessionId, {
					agentId: workItem.agentPlan.id,
					status: 'error',
					log: {
						type: 'error',
						content: message,
						timestamp: Date.now(),
					},
				});
			}
		});

		for (let i = 0; i < taskFactories.length; i += concurrency) {
			if (options.token.isCancellationRequested) {
				break;
			}
			if (options.budgetMs !== undefined) {
				const elapsedMs = Date.now() - options.executionStartedAt;
				if (elapsedMs >= options.budgetMs) {
					break;
				}
			}
			const batch = taskFactories.slice(i, i + concurrency).map(factory => factory());
			await Promise.all(batch);
		}

		return results;
	}

	private async executeAgentWorkItem(
		workItem: IAgentRoundWorkItem,
		agentIndex: number,
		options: {
			provider: INeocodeSwarmProviderConfig;
			apiKey: string | undefined;
			extraEnv: Record<string, string> | undefined;
			toolExecutor: INeocodeToolExecutor;
			systemPrompt: string;
			config: INeocodeSwarmConfig;
			sessionId: string;
			timeBudgetMinutes: number | undefined;
			agentTimeBudgetSeconds: number | undefined;
			onProgress: (parts: IChatProgress[]) => void;
			token: CancellationToken;
			executionStartedAt: number;
			budgetMs?: number;
			adapterReadyProviderIds: Set<string>;
			resolveProviderToken: (providerId: string) => Promise<string | undefined>;
		},
	): Promise<IAgentRoundResult> {
		const { agentPlan } = workItem;
		const agentConfig = this.resolveAgentConfigForPlan(agentPlan, options.config, agentIndex);
		let agentProvider = this.selectProviderForAgent(agentPlan, options.config, options.provider, agentIndex, agentConfig);
		if (!options.adapterReadyProviderIds.has(agentProvider.id)) {
			const rerouted = this.selectReadyProviderForAgent(
				agentPlan,
				options.config,
				agentIndex,
				options.provider,
				options.adapterReadyProviderIds,
				agentConfig,
			);
			if (rerouted) {
				this.logService.info(`[neocode orchestrator] Agent ${agentPlan.name} provider "${agentProvider.name}" sem credencial adapter-compatible — redirecionando para "${rerouted.name}"`);
				agentProvider = rerouted;
			}
		}

		const agentApiKey = await options.resolveProviderToken(agentProvider.id);
		if (!agentApiKey) {
			const message = `Sem credencial adapter-compatible para o provedor "${agentProvider.name}".`;
			return {
				agentId: agentPlan.id,
				agentName: agentPlan.name,
				round: workItem.round,
				result: `Erro em ${agentPlan.name}: ${message}`,
				error: message,
				task: workItem.taskOverride ?? agentPlan.task,
			};
		}

		const agentExtraEnv = agentProvider.id === options.provider.id ? options.extraEnv : undefined;
		const onAgentUpdate = (update: IAgentProgressUpdate) => {
			this.activityService.updateAgent(options.sessionId, update);
			this.emitAgentUpdate(update, agentPlan, options.onProgress);
		};

		if (workItem.round > 1 && workItem.taskOverride) {
			onAgentUpdate({
				agentId: agentPlan.id,
				status: 'working',
				log: {
					type: 'message',
					content: `🔁 Rodada ${workItem.round}: novo direcionamento do orquestrador aplicado.`,
					timestamp: Date.now(),
				},
			});
		}

		const capabilityProfile = await this.buildAgentCapabilityProfile(agentConfig, options.config.capabilities, options.toolExecutor);
		const capabilityAwareToolExecutor = this.createCapabilityAwareToolExecutor(options.toolExecutor, capabilityProfile, agentPlan.id, onAgentUpdate, options.token);
		const agentSystemPrompt = capabilityProfile.systemPromptAddon
			? `${options.systemPrompt}\n\n${capabilityProfile.systemPromptAddon}`
			: options.systemPrompt;

		const runner = this._register(this.instantiationService.createInstance(NeocodeSwarmAgentRunner));
		const orchestrationContext = [
			options.timeBudgetMinutes
				? `Orçamento total do enxame: ${options.timeBudgetMinutes} minutos.`
				: 'Orçamento total do enxame: tempo indeterminado.',
			options.agentTimeBudgetSeconds ? `Tempo de referência para este agente: ~${options.agentTimeBudgetSeconds} segundos.` : '',
			`Rodada atual de execução: ${workItem.round}.`,
			workItem.additionalContext ? `Contexto adicional do orquestrador: ${workItem.additionalContext}` : '',
			'Atue de forma objetiva e priorize entregáveis concretos dentro do orçamento.',
			capabilityProfile.contextAddon,
		].filter(Boolean).join('\n');

		const planForRun: ISwarmAgentPlan = workItem.taskOverride
			? { ...agentPlan, task: workItem.taskOverride }
			: agentPlan;

		const runOptions: ISwarmAgentRunOptions = {
			plan: planForRun,
			provider: agentProvider,
			apiKey: agentApiKey,
			extraEnv: agentExtraEnv,
			toolExecutor: capabilityAwareToolExecutor,
			systemPrompt: agentSystemPrompt,
			context: orchestrationContext,
			onUpdate: onAgentUpdate,
		};

		for (const warning of capabilityProfile.warnings) {
			onAgentUpdate({
				agentId: agentPlan.id,
				status: 'working',
				log: {
					type: 'message',
					content: `⚠️ ${warning}`,
					timestamp: Date.now(),
				},
			});
		}

		await this.runCapabilityPhaseInstructions(capabilityProfile.preAgentInstructions, agentPlan.id, onAgentUpdate, 'pre-agent');
		await this.runCapabilityPhaseCommands(capabilityProfile.preAgentCommands, agentPlan.id, options.toolExecutor, onAgentUpdate, options.token, 'pre-agent');
		let result = '';
		let error: string | undefined;
		const agentHardTimeoutMs = this.computeAgentHardTimeoutMs(agentConfig, options, workItem.round);
		const perAgentCancellation = new CancellationTokenSource(options.token);
		try {
			result = await this.runWithTimeout(
				() => runner.run(runOptions, perAgentCancellation.token),
				agentHardTimeoutMs,
				() => perAgentCancellation.cancel(),
				`Timeout do agente ${agentPlan.name} após ${Math.round(agentHardTimeoutMs / 1000)}s`,
			);
			if (/^Erro em /i.test(result)) {
				error = result;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
			result = `Erro em ${agentPlan.name}: ${error}`;
		} finally {
			perAgentCancellation.dispose();
			await this.runCapabilityPhaseCommands(capabilityProfile.postAgentCommands, agentPlan.id, options.toolExecutor, onAgentUpdate, options.token, 'post-agent');
			await this.runCapabilityPhaseInstructions(capabilityProfile.postAgentInstructions, agentPlan.id, onAgentUpdate, 'post-agent');
		}

		return {
			agentId: agentPlan.id,
			agentName: agentPlan.name,
			round: workItem.round,
			result,
			error,
			task: planForRun.task,
		};
	}

	private async decideNextRoundActions(
		originalPrompt: string,
		plan: ISwarmExecutionPlan,
		round: number,
		roundResults: IAgentRoundResult[],
		allResults: Map<string, string>,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		token: CancellationToken,
	): Promise<IOrchestratorRoundDecision> {
		if (round >= MAX_ORCHESTRATION_ROUNDS) {
			return {
				complete: true,
				summary: `Limite de rodadas (${MAX_ORCHESTRATION_ROUNDS}) atingido.`,
				actions: [],
			};
		}

		const providerConfig = buildProviderConfig(provider);
		const env = buildEnvFromProvider(provider, apiKey, extraEnv);
		const roundBlocks = roundResults.map(result => {
			const body = result.result.slice(0, 2200);
			const hasError = result.error ? 'sim' : 'não';
			return `- agentId: ${result.agentId}\n  agentName: ${result.agentName}\n  hadError: ${hasError}\n  task: ${result.task}\n  output: ${body}`;
		}).join('\n\n');
		const existingAgents = plan.agents.map(agent => `${agent.id}:${agent.name}:${agent.role}`).join(', ');
		const prompt = `Você é o orquestrador do enxame.\n\nTarefa original: ${originalPrompt}\nResumo do plano: ${plan.reasoning}\nRodada atual: ${round}\nAgentes existentes: ${existingAgents}\n\nResultados desta rodada:\n${roundBlocks}\n\nTotal de resultados acumulados: ${allResults.size}\n\nDecida se a execução deve continuar.\n- complete=true quando a tarefa parece suficientemente concluída.\n- type=followup para pedir refinamento de um agente já existente.\n- type=spawn para criar um novo agente APENAS se houver lacuna clara.\n- Máximo de 3 ações.\n\nResponda APENAS em JSON com este formato:\n{\n  \"complete\": false,\n  \"summary\": \"frase curta\",\n  \"actions\": [\n    {\n      \"type\": \"followup\",\n      \"targetAgentId\": \"agent-1\",\n      \"task\": \"instrução objetiva\",\n      \"reason\": \"motivo\"\n    },\n    {\n      \"type\": \"spawn\",\n      \"name\": \"Bolt\",\n      \"role\": \"coder\",\n      \"task\": \"instrução objetiva\",\n      \"reason\": \"motivo\"\n    }\n  ]\n}`;

		try {
			let raw = '';
			const stream = this.adapter.runTask(providerConfig, { env, maskedEnv: {} }, {
				prompt,
				systemPrompt: 'Você decide os próximos passos de execução de um swarm. Responda apenas JSON válido.',
				includePartialMessages: false,
				maxToolCallRounds: 0,
			}, token);
			for await (const chunk of stream) {
				if (token.isCancellationRequested) {
					break;
				}
				if (chunk.type === 'content' && chunk.value) {
					raw += chunk.value;
				}
			}

			const match = /\{[\s\S]*\}/.exec(raw);
			if (!match) {
				return this.buildHeuristicRoundDecision(roundResults);
			}

			const parsed = JSON.parse(match[0]) as Partial<IOrchestratorRoundDecision> & { actions?: IOrchestratorNextAction[] };
			const actions = Array.isArray(parsed.actions) ? parsed.actions : [];
			const normalizedActions = actions
				.filter(action => !!action && typeof action.task === 'string' && action.task.trim().length > 0)
				.slice(0, 3)
				.map(action => ({
					type: action.type === 'spawn' ? 'spawn' as const : 'followup' as const,
					targetAgentId: action.targetAgentId,
					task: action.task.trim(),
					reason: action.reason?.trim(),
					name: action.name?.trim(),
					role: action.role?.trim(),
				}));

			return {
				complete: Boolean(parsed.complete),
				summary: typeof parsed.summary === 'string' && parsed.summary.trim().length > 0
					? parsed.summary.trim()
					: 'Decisão de continuação aplicada.',
				actions: normalizedActions,
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[neocode orchestrator] decideNextRoundActions failed, using heuristic fallback: ${message}`);
			return this.buildHeuristicRoundDecision(roundResults);
		}
	}

	private buildHeuristicRoundDecision(roundResults: IAgentRoundResult[]): IOrchestratorRoundDecision {
		const weakResults = roundResults.filter(result => {
			if (result.error) {
				return true;
			}
			const normalized = (result.result || '').trim();
			return normalized.length < MIN_AGENT_RESULT_LENGTH_FOR_COMPLETION;
		});

		if (weakResults.length === 0) {
			return {
				complete: true,
				summary: 'Todos os agentes trouxeram respostas com volume suficiente. Encerrando loop iterativo.',
				actions: [],
			};
		}

		const actions: IOrchestratorNextAction[] = weakResults.slice(0, 2).map(result => ({
			type: 'followup',
			targetAgentId: result.agentId,
			task: `Refine sua entrega da rodada anterior e produza resultado mais concreto. Foque em arquivos alterados, validação executada e pendências remanescentes.`,
			reason: 'Resultado anterior curto ou com erro.',
		}));

		return {
			complete: false,
			summary: `${weakResults.length} agente(s) precisam de refinamento antes da síntese final.`,
			actions,
		};
	}

	private selectReadyProviderForAgent(
		agentPlan: ISwarmAgentPlan,
		config: INeocodeSwarmConfig,
		agentIndex: number,
		defaultProvider: INeocodeSwarmProviderConfig,
		readyProviderIds: Set<string>,
		resolvedAgentConfig?: INeocodeSwarmAgentConfig,
	): INeocodeSwarmProviderConfig | undefined {
		if (resolvedAgentConfig?.providerId && readyProviderIds.has(resolvedAgentConfig.providerId)) {
			return config.providers.find(provider => provider.id === resolvedAgentConfig.providerId && provider.enabled);
		}

		const roleSpecificProviderId = config.agents.find(agent => agent.active && agent.role === agentPlan.role)?.providerId;
		if (roleSpecificProviderId && readyProviderIds.has(roleSpecificProviderId)) {
			return config.providers.find(provider => provider.id === roleSpecificProviderId && provider.enabled);
		}

		if (readyProviderIds.has(defaultProvider.id)) {
			return defaultProvider;
		}

		const readyProviders = config.providers.filter(provider => provider.enabled && readyProviderIds.has(provider.id));
		if (readyProviders.length === 0) {
			return undefined;
		}
		return readyProviders[agentIndex % readyProviders.length];
	}

	private computeAgentHardTimeoutMs(
		agentConfig: INeocodeSwarmAgentConfig | undefined,
		options: {
			agentTimeBudgetSeconds: number | undefined;
			executionStartedAt: number;
			budgetMs?: number;
		},
		round: number,
	): number {
		const configuredTimeoutMs = Math.max(
			MIN_AGENT_HARD_TIMEOUT_MS,
			Math.floor((agentConfig?.timeoutSeconds ?? 120) * 1000),
		);
		const referenceTimeoutMs = options.agentTimeBudgetSeconds
			? Math.max(MIN_AGENT_HARD_TIMEOUT_MS, Math.floor(options.agentTimeBudgetSeconds * 1000))
			: DEFAULT_AGENT_HARD_TIMEOUT_MS;
		let hardTimeoutMs = Math.min(configuredTimeoutMs, referenceTimeoutMs);
		if (round > 1) {
			hardTimeoutMs = Math.max(8_000, Math.floor(hardTimeoutMs * 0.75));
		}
		if (options.budgetMs === undefined) {
			return Math.max(MIN_AGENT_HARD_TIMEOUT_MS, hardTimeoutMs);
		}

		const remainingMs = options.budgetMs - (Date.now() - options.executionStartedAt) - 500;
		if (remainingMs <= 0) {
			return 1_000;
		}
		return Math.max(1_000, Math.min(hardTimeoutMs, remainingMs));
	}

	private async runWithTimeout<T>(
		operation: () => Promise<T>,
		timeoutMs: number,
		onTimeout: () => void,
		timeoutMessage: string,
	): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				operation(),
				new Promise<T>((_, reject) => {
					timer = setTimeout(() => {
						onTimeout();
						reject(new Error(timeoutMessage));
					}, timeoutMs);
				}),
			]);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
		}
	}

	private isQuotaOrRateLimitError(text: string): boolean {
		const normalized = text.toLowerCase();
		return normalized.includes('insufficient_quota')
			|| normalized.includes('free allocated quota exceeded')
			|| normalized.includes('quota exceeded')
			|| normalized.includes('rate_limit')
			|| normalized.includes('rate limit')
			|| normalized.includes('http 429');
	}

	private buildPartialResultsSummary(plan: ISwarmExecutionPlan, agentResults: Map<string, string>): string {
		if (agentResults.size === 0) {
			return 'Nenhum resultado parcial foi coletado dos agentes.';
		}
		const lines: string[] = ['### Resultados Parciais'];
		for (const agent of plan.agents.slice(0, 12)) {
			const result = agentResults.get(agent.id);
			if (!result) {
				continue;
			}
			const preview = result.trim().slice(0, 360);
			lines.push(`- **${agent.name}** (${agent.role}): ${preview}${result.length > 360 ? '...' : ''}`);
		}
		return lines.join('\n');
	}

	private async synthesizeWithTimeout(
		originalPrompt: string,
		plan: ISwarmExecutionPlan,
		agentResults: Map<string, string>,
		provider: INeocodeSwarmProviderConfig,
		apiKey: string | undefined,
		extraEnv: Record<string, string> | undefined,
		systemPrompt: string,
		token: CancellationToken,
	): Promise<string> {
		const synthesisCts = new CancellationTokenSource(token);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const synthesisPromise = this.synthesizeResults(
				originalPrompt,
				plan,
				agentResults,
				provider,
				apiKey,
				extraEnv,
				systemPrompt,
				synthesisCts.token,
			);
			const timeoutPromise = new Promise<string>((resolve) => {
				timer = setTimeout(() => {
					synthesisCts.cancel();
					resolve(this.buildPartialResultsSummary(plan, agentResults));
				}, MAX_SYNTHESIS_TIMEOUT_MS);
			});
			return await Promise.race([synthesisPromise, timeoutPromise]);
		} catch {
			return this.buildPartialResultsSummary(plan, agentResults);
		} finally {
			if (timer) {
				clearTimeout(timer);
			}
			synthesisCts.dispose();
		}
	}

	private selectProviderForAgent(
		agentPlan: ISwarmAgentPlan,
		config: INeocodeSwarmConfig,
		defaultProvider: INeocodeSwarmProviderConfig,
		agentIndex: number = 0,
		resolvedAgentConfig?: INeocodeSwarmAgentConfig,
	): INeocodeSwarmProviderConfig {
		if (resolvedAgentConfig?.providerId) {
			const resolvedProvider = config.providers.find(p => p.id === resolvedAgentConfig.providerId && p.enabled);
			if (resolvedProvider) { return resolvedProvider; }
		}

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

	private resolveAgentConfigForPlan(
		agentPlan: ISwarmAgentPlan,
		config: INeocodeSwarmConfig,
		agentIndex: number,
	): INeocodeSwarmAgentConfig | undefined {
		const activeAgents = config.agents.filter(agent => agent.active);
		if (activeAgents.length === 0) {
			return undefined;
		}

		const matchingByRole = activeAgents.filter(agent => agent.role === agentPlan.role);
		if (matchingByRole.length > 0) {
			return matchingByRole[agentIndex % matchingByRole.length];
		}

		return activeAgents[agentIndex % activeAgents.length];
	}

	private async buildAgentCapabilityProfile(
		agentConfig: INeocodeSwarmAgentConfig | undefined,
		capabilities: INeocodeSwarmCapabilitiesConfig,
		toolExecutor: INeocodeToolExecutor,
	): Promise<IAgentCapabilityProfile> {
		if (!agentConfig) {
			return {
				preAgentCommands: [],
				postAgentCommands: [],
				preAgentInstructions: [],
				postAgentInstructions: [],
				preToolRules: [],
				postToolRules: [],
				warnings: [],
			};
		}

		const resolvedSkills = this.resolveAgentSkills(agentConfig, capabilities);
		const allowedTools = this.resolveAllowedToolsFromSkills(resolvedSkills);
		const personalities = this.resolveAgentPersonalities(agentConfig, capabilities);
		const hooks = this.resolveAgentHooks(agentConfig, capabilities);
		const commands = this.resolveAgentCommands(agentConfig, capabilities);
		const runtimeHooks = await this.resolveRuntimeHooks(hooks, toolExecutor);
		const runtimeCommands = await this.resolveRuntimeCommands(commands, toolExecutor);

		const systemPromptParts: string[] = [];
		if (agentConfig.soulRule?.trim()) {
			systemPromptParts.push(`Regra principal do agente: ${agentConfig.soulRule.trim()}`);
		}
		if (personalities.length > 0) {
			const personalityRules = personalities.map(personality => `- ${personality.name}: ${personality.soulRule}`).join('\n');
			systemPromptParts.push(`Personalidades aplicadas:\n${personalityRules}`);
		}
		if (resolvedSkills.length > 0) {
			systemPromptParts.push(`Skills ativas para este agente: ${resolvedSkills.map(skill => skill.name).join(', ')}`);
		}
		if (hooks.length > 0) {
			systemPromptParts.push(`Hooks ativos (referência de fluxo): ${hooks.map(hook => hook.name).join(', ')}`);
		}
		if (commands.length > 0) {
			systemPromptParts.push(`Comandos preferenciais: ${commands.map(command => command.name).join(', ')}`);
		}
		if (runtimeCommands.instructionSnippets.length > 0) {
			const snippets = runtimeCommands.instructionSnippets.map(snippet => `### ${snippet.title}\n${snippet.content}`).join('\n\n');
			systemPromptParts.push(`Instruções de comandos ativos:\n${snippets}`);
		}
		if (runtimeHooks.preAgentInstructions.length > 0 || runtimeHooks.postAgentInstructions.length > 0) {
			const instructionText = [...runtimeHooks.preAgentInstructions, ...runtimeHooks.postAgentInstructions]
				.map(instruction => `- ${instruction.sourceName}: ${instruction.content}`)
				.join('\n');
			systemPromptParts.push(`Instruções de hooks ativas:\n${instructionText}`);
		}

		const contextParts: string[] = [];
		if (allowedTools && allowedTools.size > 0) {
			contextParts.push(`Ferramentas permitidas para este agente: ${Array.from(allowedTools).join(', ')}.`);
		}
		if (resolvedSkills.length > 0) {
			contextParts.push(`Especialização declarada: ${resolvedSkills.map(skill => `${skill.name} (${skill.type})`).join(', ')}.`);
		}
		if (runtimeHooks.preAgentCommands.length > 0 || runtimeHooks.postAgentCommands.length > 0) {
			contextParts.push(`Hooks executáveis configurados: pre-agent=${runtimeHooks.preAgentCommands.length}, post-agent=${runtimeHooks.postAgentCommands.length}.`);
		}
		if (runtimeHooks.preToolRules.length > 0 || runtimeHooks.postToolRules.length > 0) {
			contextParts.push(`Hooks por ferramenta ativos: pre-tool=${runtimeHooks.preToolRules.length}, post-tool=${runtimeHooks.postToolRules.length}.`);
		}
		if (runtimeCommands.preAgentCommands.length > 0) {
			contextParts.push(`Comandos executáveis automáticos: ${runtimeCommands.preAgentCommands.map(command => command.sourceName).join(', ')}.`);
		}
		if (runtimeHooks.preAgentInstructions.length > 0 || runtimeHooks.postAgentInstructions.length > 0) {
			contextParts.push(`Instruções automáticas de hook: pre-agent=${runtimeHooks.preAgentInstructions.length}, post-agent=${runtimeHooks.postAgentInstructions.length}.`);
		}

		return {
			allowedTools,
			systemPromptAddon: systemPromptParts.length > 0
				? `## Capacidades do Agente\n${systemPromptParts.join('\n\n')}`
				: undefined,
			contextAddon: contextParts.length > 0 ? contextParts.join('\n') : undefined,
			preAgentCommands: [...runtimeHooks.preAgentCommands, ...runtimeCommands.preAgentCommands],
			postAgentCommands: [...runtimeHooks.postAgentCommands, ...runtimeCommands.postAgentCommands],
			preAgentInstructions: runtimeHooks.preAgentInstructions,
			postAgentInstructions: runtimeHooks.postAgentInstructions,
			preToolRules: runtimeHooks.preToolRules,
			postToolRules: runtimeHooks.postToolRules,
			warnings: [...runtimeHooks.warnings, ...runtimeCommands.warnings],
		};
	}

	private async resolveRuntimeHooks(
		hooks: INeocodeSwarmHookConfig[],
		toolExecutor: INeocodeToolExecutor,
	): Promise<{
		preAgentCommands: ICapabilityRuntimeCommand[];
		postAgentCommands: ICapabilityRuntimeCommand[];
		preToolRules: ICapabilityToolRule[];
		postToolRules: ICapabilityToolRule[];
		preAgentInstructions: ICapabilityPhaseInstruction[];
		postAgentInstructions: ICapabilityPhaseInstruction[];
		warnings: string[];
	}> {
		const preAgentCommands: ICapabilityRuntimeCommand[] = [];
		const postAgentCommands: ICapabilityRuntimeCommand[] = [];
		const preToolRules: ICapabilityToolRule[] = [];
		const postToolRules: ICapabilityToolRule[] = [];
		const preAgentInstructions: ICapabilityPhaseInstruction[] = [];
		const postAgentInstructions: ICapabilityPhaseInstruction[] = [];
		const warnings: string[] = [];

		for (const hook of hooks) {
			if (!hook.scriptPath) {
				warnings.push(`Hook "${hook.name}" sem scriptPath configurado.`);
				continue;
			}

			const hookPath = this.normalizeCapabilityPath(hook.scriptPath);
			const rawHookConfig = await this.readCapabilityFile(hookPath, toolExecutor);
			if (!rawHookConfig) {
				warnings.push(`Não foi possível ler hook "${hook.name}" em ${hookPath}.`);
				continue;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(rawHookConfig) as Record<string, unknown>;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				warnings.push(`Hook "${hook.name}" possui JSON inválido (${msg}).`);
				continue;
			}

			const hookEvents = parsed.hooks;
			if (!hookEvents || typeof hookEvents !== 'object') {
				warnings.push(`Hook "${hook.name}" não possui seção "hooks".`);
				continue;
			}

			for (const [eventName, eventValue] of Object.entries(hookEvents as Record<string, unknown>)) {
				if (!Array.isArray(eventValue)) {
					continue;
				}
				for (const entry of eventValue) {
					if (!entry || typeof entry !== 'object') {
						continue;
					}
					const matcher = typeof (entry as { matcher?: unknown }).matcher === 'string'
						? (entry as { matcher: string }).matcher
						: undefined;
					const nestedHooks = Array.isArray((entry as { hooks?: unknown }).hooks)
						? (entry as { hooks: unknown[] }).hooks
						: [];
					for (const nestedHook of nestedHooks) {
						if (!nestedHook || typeof nestedHook !== 'object') {
							continue;
						}
						const dispatched = this.dispatchHookByType({
							hookName: hook.name,
							hookPath,
							eventName,
							matcher,
							rawHook: nestedHook as Record<string, unknown>,
						});
						preAgentCommands.push(...dispatched.preAgentCommands);
						postAgentCommands.push(...dispatched.postAgentCommands);
						preToolRules.push(...dispatched.preToolRules);
						postToolRules.push(...dispatched.postToolRules);
						preAgentInstructions.push(...dispatched.preAgentInstructions);
						postAgentInstructions.push(...dispatched.postAgentInstructions);
						warnings.push(...dispatched.warnings);
					}
				}
			}
		}

		return {
			preAgentCommands,
			postAgentCommands,
			preToolRules,
			postToolRules,
			preAgentInstructions,
			postAgentInstructions,
			warnings,
		};
	}

	private async resolveRuntimeCommands(
		commands: INeocodeSwarmCommandConfig[],
		toolExecutor: INeocodeToolExecutor,
	): Promise<{
		preAgentCommands: ICapabilityRuntimeCommand[];
		postAgentCommands: ICapabilityRuntimeCommand[];
		instructionSnippets: Array<{ title: string; content: string }>;
		warnings: string[];
	}> {
		const preAgentCommands: ICapabilityRuntimeCommand[] = [];
		const postAgentCommands: ICapabilityRuntimeCommand[] = [];
		const instructionSnippets: Array<{ title: string; content: string }> = [];
		const warnings: string[] = [];

		for (const command of commands) {
			if (!command.executablePath) {
				warnings.push(`Comando "${command.name}" sem executablePath configurado.`);
				continue;
			}

			const commandPath = this.normalizeCapabilityPath(command.executablePath);
			const executableCommand = this.buildExecutableCommandFromPath(commandPath);
			if (executableCommand) {
				preAgentCommands.push({
					sourceType: 'command',
					sourceName: command.name,
					command: executableCommand,
				});
				continue;
			}

			const extension = extname(commandPath).toLowerCase();
			if (INSTRUCTION_COMMAND_EXTENSIONS.has(extension)) {
				const instructionContent = await this.readCapabilityFile(commandPath, toolExecutor);
				if (instructionContent) {
					instructionSnippets.push({
						title: command.name,
						content: this.truncateCapabilityInstruction(instructionContent),
					});
				} else {
					warnings.push(`Não foi possível carregar instruções de "${command.name}" (${commandPath}).`);
				}
				continue;
			}

			warnings.push(`Comando "${command.name}" usa extensão não suportada para execução automática (${extension || 'sem extensão'}).`);
		}

		return { preAgentCommands, postAgentCommands, instructionSnippets, warnings };
	}

	private dispatchHookByType(options: {
		hookName: string;
		hookPath: string;
		eventName: string;
		matcher?: string;
		rawHook: Record<string, unknown>;
	}): IHookDispatchResult {
		const result: IHookDispatchResult = {
			preAgentCommands: [],
			postAgentCommands: [],
			preToolRules: [],
			postToolRules: [],
			preAgentInstructions: [],
			postAgentInstructions: [],
			warnings: [],
		};
		const phase = this.resolveHookEventPhase(options.eventName);
		if (!phase) {
			result.warnings.push(`Hook "${options.hookName}" usa evento não suportado: ${options.eventName}.`);
			return result;
		}

		const type = typeof options.rawHook.type === 'string'
			? options.rawHook.type.toLowerCase()
			: 'command';

		if (type === 'command') {
			const commandValue = options.rawHook.command;
			if (typeof commandValue !== 'string' || commandValue.trim().length === 0) {
				result.warnings.push(`Hook "${options.hookName}" com type=command sem campo "command" válido.`);
				return result;
			}
			const command = this.resolveHookCommandTemplate(commandValue, options.hookPath);
			this.attachHookRuleByPhase(result, phase, {
				sourceName: options.hookName,
				matcher: options.matcher,
				action: 'command',
				command,
			});
			return result;
		}

		if (type === 'instruction' || type === 'prompt' || type === 'text' || type === 'message' || type === 'note') {
			const instruction = this.extractHookInstruction(options.rawHook);
			if (!instruction) {
				result.warnings.push(`Hook "${options.hookName}" com type=${type} sem conteúdo textual.`);
				return result;
			}
			this.attachHookRuleByPhase(result, phase, {
				sourceName: options.hookName,
				matcher: options.matcher,
				action: 'instruction',
				instruction,
			});
			return result;
		}

		if (type === 'block' || type === 'deny' || type === 'forbid' || type === 'disallow') {
			const reason = this.extractHookBlockReason(options.rawHook) ?? `Bloqueado pelo hook "${options.hookName}".`;
			if (phase !== 'pre-tool') {
				result.warnings.push(`Hook "${options.hookName}" type=${type} só é aplicado em PreToolUse.`);
				return result;
			}
			result.preToolRules.push({
				sourceName: options.hookName,
				matcher: options.matcher,
				action: 'block',
				reason,
			});
			return result;
		}

		result.warnings.push(`Hook "${options.hookName}" com type não suportado: ${type}.`);
		return result;
	}

	private resolveHookEventPhase(eventName: string): 'pre-agent' | 'post-agent' | 'pre-tool' | 'post-tool' | undefined {
		const normalized = eventName.toLowerCase();
		if (normalized === 'sessionstart' || normalized === 'userpromptsubmit') {
			return 'pre-agent';
		}
		if (normalized === 'stop' || normalized === 'sessionend') {
			return 'post-agent';
		}
		if (normalized === 'pretooluse') {
			return 'pre-tool';
		}
		if (normalized === 'posttooluse') {
			return 'post-tool';
		}
		return undefined;
	}

	private attachHookRuleByPhase(
		result: IHookDispatchResult,
		phase: 'pre-agent' | 'post-agent' | 'pre-tool' | 'post-tool',
		rule: ICapabilityToolRule,
	): void {
		if (phase === 'pre-agent') {
			if (rule.action === 'command' && rule.command) {
				result.preAgentCommands.push({ sourceType: 'hook', sourceName: rule.sourceName, command: rule.command });
			} else if (rule.action === 'instruction' && rule.instruction) {
				result.preAgentInstructions.push({ sourceType: 'hook', sourceName: rule.sourceName, content: rule.instruction });
			}
			return;
		}
		if (phase === 'post-agent') {
			if (rule.action === 'command' && rule.command) {
				result.postAgentCommands.push({ sourceType: 'hook', sourceName: rule.sourceName, command: rule.command });
			} else if (rule.action === 'instruction' && rule.instruction) {
				result.postAgentInstructions.push({ sourceType: 'hook', sourceName: rule.sourceName, content: rule.instruction });
			}
			return;
		}
		if (phase === 'pre-tool') {
			result.preToolRules.push(rule);
			return;
		}
		result.postToolRules.push(rule);
	}

	private extractHookInstruction(rawHook: Record<string, unknown>): string | undefined {
		const candidates = [
			rawHook.instruction,
			rawHook.content,
			rawHook.text,
			rawHook.message,
		];
		for (const candidate of candidates) {
			if (typeof candidate === 'string' && candidate.trim().length > 0) {
				return this.truncateCapabilityInstruction(candidate.trim());
			}
		}
		return undefined;
	}

	private extractHookBlockReason(rawHook: Record<string, unknown>): string | undefined {
		const candidates = [
			rawHook.reason,
			rawHook.message,
			rawHook.description,
			rawHook.text,
		];
		for (const candidate of candidates) {
			if (typeof candidate === 'string' && candidate.trim().length > 0) {
				return candidate.trim();
			}
		}
		return undefined;
	}

	private resolveAgentSkills(
		agentConfig: INeocodeSwarmAgentConfig,
		capabilities: INeocodeSwarmCapabilitiesConfig,
	): INeocodeSwarmSkillConfig[] {
		const byId = new Map<string, INeocodeSwarmSkillConfig>();

		for (const embeddedSkill of agentConfig.skills ?? []) {
			const key = embeddedSkill.id || embeddedSkill.name;
			if (key) {
				byId.set(key, embeddedSkill);
			}
		}

		for (const skillId of agentConfig.skillIds ?? []) {
			const resolved = capabilities.skills.find(skill => skill.id === skillId);
			if (resolved) {
				byId.set(resolved.id || resolved.name, resolved);
			}
		}

		return Array.from(byId.values());
	}

	private resolveAgentPersonalities(
		agentConfig: INeocodeSwarmAgentConfig,
		capabilities: INeocodeSwarmCapabilitiesConfig,
	): INeocodeSwarmPersonalityConfig[] {
		return (agentConfig.personalityIds ?? [])
			.map(id => capabilities.personalities.find(personality => personality.id === id))
			.filter((personality): personality is INeocodeSwarmPersonalityConfig => !!personality);
	}

	private resolveAgentHooks(
		agentConfig: INeocodeSwarmAgentConfig,
		capabilities: INeocodeSwarmCapabilitiesConfig,
	): INeocodeSwarmHookConfig[] {
		return (agentConfig.hookIds ?? [])
			.map(id => capabilities.hooks.find(hook => hook.id === id))
			.filter((hook): hook is INeocodeSwarmHookConfig => !!hook);
	}

	private resolveAgentCommands(
		agentConfig: INeocodeSwarmAgentConfig,
		capabilities: INeocodeSwarmCapabilitiesConfig,
	): INeocodeSwarmCommandConfig[] {
		return (agentConfig.commandIds ?? [])
			.map(id => capabilities.commands.find(command => command.id === id))
			.filter((command): command is INeocodeSwarmCommandConfig => !!command);
	}

	private resolveAllowedToolsFromSkills(skills: INeocodeSwarmSkillConfig[]): Set<string> | undefined {
		if (skills.length === 0) {
			return undefined;
		}

		const allowedTools = new Set<string>();
		let hasRestrictiveSkillType = false;

		for (const skill of skills) {
			const mappedTools = SKILL_TYPE_TOOL_MAP[skill.type];
			if (!mappedTools) {
				continue;
			}
			hasRestrictiveSkillType = true;
			for (const toolName of mappedTools) {
				allowedTools.add(toolName);
			}
		}

		if (!hasRestrictiveSkillType || allowedTools.size === 0) {
			return undefined;
		}
		return allowedTools;
	}

	private createCapabilityAwareToolExecutor(
		toolExecutor: INeocodeToolExecutor,
		capabilityProfile: IAgentCapabilityProfile,
		agentId: string,
		onUpdate: (update: IAgentProgressUpdate) => void,
		token: CancellationToken,
	): INeocodeToolExecutor {
		const allowedTools = capabilityProfile.allowedTools;
		const filteredTools = !allowedTools || allowedTools.size === 0
			? toolExecutor.getTools()
			: toolExecutor.getTools().filter(tool => allowedTools.has(tool.name));
		return {
			getTools: () => filteredTools,
			execute: async (call: INeocodeToolCall): Promise<INeocodeToolResult> => {
				if (token.isCancellationRequested) {
						return {
							id: call.id,
							content: `Execução cancelada antes de chamar a ferramenta: ${call.name}`,
							isError: true,
						};
					}
				if (allowedTools && allowedTools.size > 0 && !allowedTools.has(call.name)) {
					return {
						id: call.id,
						content: `Tool bloqueada pelas capacidades do agente: ${call.name}`,
						isError: true,
					};
				}

				const blockedReason = this.getBlockedToolReason(capabilityProfile.preToolRules, call.name);
				if (blockedReason) {
					return {
						id: call.id,
						content: `Tool bloqueada por hook: ${blockedReason}`,
						isError: true,
					};
				}

				await this.runToolRules(capabilityProfile.preToolRules, call.name, agentId, toolExecutor, onUpdate, token, 'pre-tool');
				let result: INeocodeToolResult;
				try {
					result = await toolExecutor.execute(call);
				} finally {
					await this.runToolRules(capabilityProfile.postToolRules, call.name, agentId, toolExecutor, onUpdate, token, 'post-tool');
				}
				return result;
			},
		};
	}

	private async readCapabilityFile(
		path: string,
		toolExecutor: INeocodeToolExecutor,
	): Promise<string | undefined> {
		if (!toolExecutor.getTools().some(tool => tool.name === 'read_file')) {
			return undefined;
		}
		const result = await toolExecutor.execute({
			id: this.createInternalToolCallId('cap-read'),
			name: 'read_file',
			arguments: { path },
		});
		if (result.isError) {
			return undefined;
		}
		return result.content;
	}

	private normalizeCapabilityPath(path: string): string {
		return path.replace(/\\/g, '/').replace(/^\.\//, '');
	}

	private resolveHookCommandTemplate(command: string, hookPath: string): string {
		const normalizedHookPath = this.normalizeCapabilityPath(hookPath);
		const lowerPath = normalizedHookPath.toLowerCase();
		const hooksMarker = '/hooks/hooks.json';
		const markerIndex = lowerPath.lastIndexOf(hooksMarker);
		const pluginRoot = markerIndex >= 0
			? normalizedHookPath.slice(0, markerIndex)
			: dirname(normalizedHookPath).replace(/\\/g, '/');
		const extensionPath = dirname(normalizedHookPath).replace(/\\/g, '/');

		return command
			.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot)
			.replace(/\$\{extensionPath\}/g, extensionPath)
			.replace(/\$\{workspaceFolder\}/g, '.');
	}

	private buildExecutableCommandFromPath(path: string): string | undefined {
		const extension = extname(path).toLowerCase();
		const quotedPath = this.quoteShellArg(path);

		switch (extension) {
			case '.sh':
			case '.bash':
			case '.zsh':
				return `bash ${quotedPath}`;
			case '.ps1':
				return `pwsh -File ${quotedPath}`;
			case '.py':
				return `python3 ${quotedPath}`;
			case '.js':
			case '.mjs':
			case '.cjs':
				return `node ${quotedPath}`;
			default:
				if (EXECUTABLE_COMMAND_EXTENSIONS.has(extension)) {
					return undefined;
				}
				if (!extension) {
					return quotedPath;
				}
				return undefined;
		}
	}

	private truncateCapabilityInstruction(content: string): string {
		if (content.length <= MAX_CAPABILITY_INSTRUCTION_CHARS) {
			return content;
		}
		return `${content.slice(0, MAX_CAPABILITY_INSTRUCTION_CHARS)}\n\n...[instrução truncada]`;
	}

	private quoteShellArg(value: string): string {
		return `'${value.replace(/'/g, `'\\''`)}'`;
	}

	private createInternalToolCallId(prefix: string): string {
		return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
	}

	private async runCapabilityPhaseCommands(
		commands: ICapabilityRuntimeCommand[],
		agentId: string,
		toolExecutor: INeocodeToolExecutor,
		onUpdate: (update: IAgentProgressUpdate) => void,
		token: CancellationToken,
		phase: 'pre-agent' | 'post-agent',
	): Promise<void> {
		for (const command of commands) {
			if (token.isCancellationRequested) {
				return;
			}
				await this.executeRuntimeCommand(
					toolExecutor,
					agentId,
					onUpdate,
					phase,
					command.sourceType,
					command.sourceName,
					command.command,
				);
			}
		}

	private async runCapabilityPhaseInstructions(
		instructions: ICapabilityPhaseInstruction[],
		agentId: string,
		onUpdate: (update: IAgentProgressUpdate) => void,
		phase: 'pre-agent' | 'post-agent',
	): Promise<void> {
		for (const instruction of instructions) {
			onUpdate({
				agentId,
				status: 'working',
				log: {
					type: 'message',
					content: `ℹ️ ${phase}:${instruction.sourceType}:${instruction.sourceName} — ${instruction.content}`,
					timestamp: Date.now(),
				},
			});
		}
	}

	private getBlockedToolReason(rules: ICapabilityToolRule[], toolName: string): string | undefined {
		for (const rule of rules) {
			if (rule.action !== 'block') {
				continue;
			}
			if (!this.toolMatchesHookMatcher(rule.matcher, toolName)) {
				continue;
			}
			return rule.reason ?? `hook ${rule.sourceName}`;
		}
		return undefined;
	}

	private async runToolRules(
		rules: ICapabilityToolRule[],
		toolName: string,
		agentId: string,
		toolExecutor: INeocodeToolExecutor,
		onUpdate: (update: IAgentProgressUpdate) => void,
		token: CancellationToken,
		phase: 'pre-tool' | 'post-tool',
	): Promise<void> {
		for (const rule of rules) {
			if (token.isCancellationRequested) {
				return;
			}
			if (!this.toolMatchesHookMatcher(rule.matcher, toolName)) {
				continue;
			}
			if (rule.action === 'instruction' && rule.instruction) {
				onUpdate({
					agentId,
					status: 'working',
					log: {
						type: 'message',
						content: `ℹ️ ${phase}:hook:${rule.sourceName} — ${rule.instruction}`,
						timestamp: Date.now(),
					},
				});
				continue;
			}
			if (rule.action !== 'command' || !rule.command) {
				continue;
			}
			await this.executeRuntimeCommand(
				toolExecutor,
				agentId,
				onUpdate,
				phase,
				'hook',
				rule.sourceName,
				rule.command,
				toolName,
			);
		}
	}

	private toolMatchesHookMatcher(matcher: string | undefined, toolName: string): boolean {
		if (!matcher || matcher.trim().length === 0) {
			return true;
		}

		const candidates = [toolName, ...(TOOL_NAME_ALIASES[toolName] ?? [])];
		try {
			const regex = new RegExp(matcher, 'i');
			return candidates.some(candidate => regex.test(candidate));
		} catch {
			const lowered = matcher.toLowerCase();
			return candidates.some(candidate => candidate.toLowerCase().includes(lowered));
		}
	}

	private async executeRuntimeCommand(
		toolExecutor: INeocodeToolExecutor,
		agentId: string,
		onUpdate: (update: IAgentProgressUpdate) => void,
		phase: 'pre-agent' | 'post-agent' | 'pre-tool' | 'post-tool',
		sourceType: 'hook' | 'command',
		sourceName: string,
		command: string,
		toolName?: string,
	): Promise<void> {
		if (!toolExecutor.getTools().some(tool => tool.name === 'run_terminal')) {
			onUpdate({
				agentId,
				status: 'working',
				log: {
					type: 'message',
					content: `⚠️ ${phase}: run_terminal indisponível para ${sourceType} "${sourceName}".`,
					timestamp: Date.now(),
				},
			});
			return;
		}

		const startedAt = Date.now();
		const result = await toolExecutor.execute({
			id: this.createInternalToolCallId('cap-run'),
			name: 'run_terminal',
			arguments: {
				command,
				working_dir: '.',
				timeout_seconds: CAPABILITY_PHASE_TIMEOUT_SECONDS,
			},
		});

		onUpdate({
			agentId,
			status: 'working',
			log: {
				type: 'tool',
				content: `${phase}:${sourceType}:${sourceName}`,
				timestamp: Date.now(),
				details: {
					arguments: {
						phase,
						sourceType,
						sourceName,
						toolName,
						command,
					},
					result: this.trimRuntimeCommandOutput(result.content),
					isError: result.isError ?? false,
					durationMs: Date.now() - startedAt,
				},
			},
		});
	}

	private trimRuntimeCommandOutput(output: string): string {
		const MAX_OUTPUT = 4000;
		if (output.length <= MAX_OUTPUT) {
			return output;
		}
		return `${output.slice(0, MAX_OUTPUT)}\n\n...[output truncado]`;
	}

	private emitAgentUpdate(
		update: IAgentProgressUpdate,
		plan: ISwarmAgentPlan,
		onProgress: (parts: IChatProgress[]) => void,
	): void {
		if (!update.log) { return; }

		const { log } = update;
		const prefix = `${plan.emoji} **${plan.name}**`;
		const tokensSuffix = update.tokenUsage
			? ` • tokens: ${update.tokenUsage.totalTokens} (in ${update.tokenUsage.promptTokens}/out ${update.tokenUsage.completionTokens})`
			: '';

		if (update.status === 'done') {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n${prefix} ✅ _Missão cumprida_${tokensSuffix}\n`),
			}]);
		} else if (log.type === 'tool') {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n> ${prefix} 🔧 Executando: \`${log.content}\`\n`),
			}]);
		} else if (log.type === 'thinking') {
			onProgress([{
				kind: 'progressMessage',
				content: new MarkdownString(`_${prefix} 💭 ${log.content}_`),
			}]);
		} else if (log.type === 'error') {
			onProgress([{
				kind: 'markdownContent',
				content: new MarkdownString(`\n${prefix} ❌ **Falha:** _${log.content}_\n`),
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
