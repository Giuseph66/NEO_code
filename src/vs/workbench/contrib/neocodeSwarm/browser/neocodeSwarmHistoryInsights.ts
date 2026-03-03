/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Emitter } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { ITimelineService, Timeline, TimelineChangeEvent, TimelineItem, TimelineOptions, TimelineProvider } from '../../timeline/common/timeline.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { NeocodeSwarmToolExecutor } from './neocodeSwarmToolExecutor.js';
import { INeocodeSwarmStorageService, INeocodeSwarmSecretService } from '../common/neocodeSwarmStorage.js';
import { INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';
import { IGeminiAuthService } from '../../neocode/gemini/common/geminiTypes.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { QwenRuntimeAdapter } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { buildProviderConfig, buildEnvFromProvider } from './neocodeSwarmOrchestrator.js';

// ─── Constants ───────────────────────────────────────────────────────────────
const PROVIDER_ID = 'neocode-git-insights';
const PROVIDER_LABEL = 'NeoCode Git Insights';

// ─── Git commit parsed from git log ──────────────────────────────────────────
interface IGitCommitEntry {
	hash: string;
	author: string;
	date: string;
	timestamp: number;
	subject: string;
}

// ─── Phase: agrupamento de commits ───────────────────────────────────────────
interface IHistoryPhase {
	label: string;
	commits: IGitCommitEntry[];
	startDate: number;
	endDate: number;
}

// ─── Main Contribution ──────────────────────────────────────────────────────
export class NeoCodeHistoryInsights extends Disposable implements IWorkbenchContribution, TimelineProvider {

	static readonly ID = 'workbench.contrib.neocodeHistoryInsights';

	readonly id = PROVIDER_ID;
	readonly label = PROVIDER_LABEL;
	readonly scheme = '*';

	private readonly _onDidChange = this._register(new Emitter<TimelineChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private readonly timelineProviderDisposable = this._register(new MutableDisposable());

	// Cache: uri.toString() → TimelineItem[]
	private readonly cache = new Map<string, { items: TimelineItem[]; timestamp: number }>();
	private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

	constructor(
		@ITimelineService private readonly timelineService: ITimelineService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
	) {
		super();
		this.timelineProviderDisposable.value = this.timelineService.registerTimelineProvider(this);
	}

	// ─── TimelineProvider ────────────────────────────────────────────────────
	async provideTimeline(uri: URI, _options: TimelineOptions, _token: CancellationToken): Promise<Timeline> {
		const cacheKey = uri.toString();

		// Check cache
		const cached = this.cache.get(cacheKey);
		if (cached && Date.now() - cached.timestamp < NeoCodeHistoryInsights.CACHE_TTL_MS) {
			return { source: this.id, items: cached.items };
		}

		const disposables = new DisposableStore();

		try {
			const toolExecutor = disposables.add(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));

			// ── 1. Obter git log do arquivo ─────────────────────────────────
			const filePath = uri.fsPath;
			const gitLogCmd = `git log --follow --format='%H|%an|%aI|%s' -n 50 -- "${filePath}"`;
			const logResult = await toolExecutor.execute({
				id: `history-log-${Date.now()}`,
				name: 'run_terminal',
				arguments: { command: gitLogCmd, timeout_seconds: 30 },
			});

			const stdout = extractStdout(logResult.content);
			const commits = parseGitLog(stdout);

			if (commits.length === 0) {
				return { source: this.id, items: [] };
			}

			// ── 2. Agrupar commits em fases ─────────────────────────────────
			const phases = groupCommitsIntoPhases(commits);

			// ── 3. Gerar labels com IA (silencioso, não bloqueia) ────────────
			let phaseLabels: string[] | undefined;
			try {
				phaseLabels = await this.generatePhaseLabels(disposables, phases);
			} catch {
				// Se IA falhar, usa labels padrão
			}

			// ── 4. Converter para TimelineItems ─────────────────────────────
			const items: TimelineItem[] = [];

			for (let i = 0; i < phases.length; i++) {
				const phase = phases[i];
				const aiLabel = phaseLabels?.[i];
				const phaseTitle = aiLabel || `Fase ${i + 1}: ${phase.commits.length} commits`;

				const startDate = new Date(phase.startDate).toLocaleDateString('pt-BR');
				const endDate = new Date(phase.endDate).toLocaleDateString('pt-BR');
				const commitList = phase.commits.map(c => `- \`${c.hash.substring(0, 7)}\` ${c.subject} _(${c.author})_`).join('\n');

				const tooltip = new MarkdownString(
					`### 🤖 ${phaseTitle}\n\n` +
					`📅 ${startDate} — ${endDate}\n` +
					`📊 ${phase.commits.length} commits\n\n` +
					`${commitList}`,
					{ supportThemeIcons: true }
				);

				items.push({
					handle: `phase-${i}-${phase.commits[0].hash}`,
					source: this.id,
					label: `🤖 ${phaseTitle}`,
					description: `${startDate} — ${endDate} (${phase.commits.length} commits)`,
					tooltip,
					timestamp: phase.endDate,
					themeIcon: Codicon.gitCommit,
				});
			}

			// Cache results
			this.cache.set(cacheKey, { items, timestamp: Date.now() });

			return { source: this.id, items };

		} catch (err) {
			console.error('[neocode history] Erro ao carregar timeline:', err);
			return { source: this.id, items: [] };
		} finally {
			disposables.dispose();
		}
	}

	// ─── AI Blame: Explicar por que trecho existe ────────────────────────────
	async explainBlame(filePath: string, lineNumber: number): Promise<string> {
		const disposables = new DisposableStore();

		try {
			const toolExecutor = disposables.add(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));

			const runCmd = async (command: string): Promise<string> => {
				const result = await toolExecutor.execute({
					id: `blame-${Date.now()}`,
					name: 'run_terminal',
					arguments: { command, timeout_seconds: 30 },
				});
				return extractStdout(result.content);
			};

			// 1. Git blame para obter o hash do commit da linha
			const blameOutput = await runCmd(`git blame -L ${lineNumber},${lineNumber} --porcelain "${filePath}"`);
			const hashMatch = blameOutput.match(/^([0-9a-f]{40})/);
			if (!hashMatch) {
				return 'Não foi possível identificar o commit associado a esta linha.';
			}

			const commitHash = hashMatch[1];
			if (commitHash === '0000000000000000000000000000000000000000') {
				return 'Esta linha ainda não foi commitada (alteração local não salva no Git).';
			}

			// 2. Git show para obter o diff completo do commit
			const commitInfo = await runCmd(`git show --stat --format='Commit: %H%nAuthor: %an <%ae>%nDate: %aI%nMessage: %s%n%n%b' ${commitHash}`);
			const diffSnippet = commitInfo.slice(0, 6000);

			// 3. Enviar à IA para obter explicação
			const prompt = `Analise o commit abaixo e explique de forma breve e direta ("por quê" esta mudança foi feita).
Contexto: O usuário está na linha ${lineNumber} do arquivo "${filePath}".

${diffSnippet}

Responda em no máximo 3 parágrafos, em português brasileiro. Comece com o motivo ou contexto (ex: "Esta lógica foi introduzida para...").`;

			const systemPrompt = 'Você é um historiador de código. Explique a motivação e o contexto por trás de mudanças no código-fonte de forma objetiva.';

			const aiResponse = await this.callAI(disposables, prompt, systemPrompt);
			return aiResponse || 'A IA não retornou uma explicação para este commit.';

		} catch (err: any) {
			console.error('[neocode blame] Erro:', err.message);
			return `Erro ao analisar: ${err.message}`;
		} finally {
			disposables.dispose();
		}
	}

	// ─── Private: Gerar labels de fases via IA ───────────────────────────────
	private async generatePhaseLabels(disposables: DisposableStore, phases: IHistoryPhase[]): Promise<string[]> {
		if (phases.length === 0) { return []; }

		const phaseSummary = phases.map((phase, i) => {
			const subjects = phase.commits.map(c => c.subject).join('; ');
			return `Fase ${i + 1} (${phase.commits.length} commits): ${subjects}`;
		}).join('\n');

		const prompt = `Abaixo estão as "fases" de desenvolvimento de um arquivo, agrupadas por commits temporalmente próximos.
Para cada fase, crie um título curto e descritivo (máx 60 chars) que resuma a intenção da fase.

${phaseSummary}

Responda ESTRITAMENTE em JSON: { "labels": ["Título Fase 1", "Título Fase 2", ...] }`;

		const systemPrompt = 'Responda apenas com JSON válido. Sem texto extra.';

		const raw = await this.callAI(disposables, prompt, systemPrompt);

		// Parse JSON
		let jsonStr = raw.trim();
		const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
		if (jsonBlockMatch) { jsonStr = jsonBlockMatch[1].trim(); }
		const jsonObjMatch = jsonStr.match(/\{[\s\S]*"labels"[\s\S]*\}/);
		if (jsonObjMatch) { jsonStr = jsonObjMatch[0]; }

		try {
			const parsed = JSON.parse(jsonStr);
			return Array.isArray(parsed.labels) ? parsed.labels : [];
		} catch {
			return [];
		}
	}

	// ─── Private: Call AI (reusable) ─────────────────────────────────────────
	private async callAI(disposables: DisposableStore, prompt: string, systemPrompt: string): Promise<string> {
		const config = this.storageService.load();
		const enabledProviders = config?.providers?.filter(p => p.enabled) ?? [];

		if (enabledProviders.length === 0) {
			throw new Error('Nenhum provedor habilitado.');
		}

		const preferredProvider = enabledProviders.find(p => p.id === config.orchestrator.providerId)
			|| enabledProviders[0];

		// Path A: Anthropic CLI
		if (preferredProvider.type === 'anthropic' && (preferredProvider.authMethod === 'login' || preferredProvider.authMethod === 'cliToken')) {
			return this.callViaCLI(disposables, 'claude', preferredProvider, prompt, systemPrompt);
		}

		// Path B: OpenAI CLI
		if (preferredProvider.type === 'openai' && preferredProvider.authMethod === 'login') {
			return this.callViaCLI(disposables, 'codex', preferredProvider, prompt, systemPrompt);
		}

		// Path C: QwenRuntimeAdapter
		return this.callViaAdapter(disposables, enabledProviders, preferredProvider, prompt, systemPrompt);
	}

	private async callViaCLI(
		disposables: DisposableStore,
		cliName: 'claude' | 'codex',
		provider: INeocodeSwarmProviderConfig,
		prompt: string,
		systemPrompt: string,
	): Promise<string> {
		const toolExecutor = disposables.add(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));

		const runCmd = async (command: string): Promise<string> => {
			const result = await toolExecutor.execute({
				id: `history-ai-${Date.now()}`,
				name: 'run_terminal',
				arguments: { command, timeout_seconds: 120 },
			});
			return result.content;
		};

		const tmpFile = `/tmp/neo-history-${Date.now()}.txt`;
		const fullPrompt = `System:\n${systemPrompt}\n\nUser:\n${prompt}`;
		await runCmd(`cat > ${tmpFile} << 'NEOHISTORYEOF'\n${fullPrompt}\nNEOHISTORYEOF`);

		const model = provider.selectedModel ?? provider.models[0] ?? '';
		let cliCmd: string;

		if (cliName === 'claude') {
			const cliArgs = ['-p'];
			if (model && /^claude-/i.test(model)) {
				cliArgs.push('--model', model);
			}
			cliCmd = `cat ${tmpFile} | claude ${cliArgs.join(' ')}; rm -f ${tmpFile}`;
		} else {
			const cliArgs = ['exec', '-p'];
			if (model) {
				cliArgs.push('--model', model);
			}
			cliCmd = `cat ${tmpFile} | codex ${cliArgs.join(' ')}; rm -f ${tmpFile}`;
		}

		const output = await runCmd(cliCmd);
		const stdout = extractStdout(output);
		const exitCode = extractExitCode(output);

		if (exitCode !== 0 || !stdout.trim()) {
			throw new Error(`${cliName} CLI falhou (exit ${exitCode})`);
		}

		return stdout;
	}

	private async callViaAdapter(
		disposables: DisposableStore,
		enabledProviders: INeocodeSwarmProviderConfig[],
		preferredProvider: INeocodeSwarmProviderConfig,
		prompt: string,
		systemPrompt: string,
	): Promise<string> {
		const candidates = [preferredProvider, ...enabledProviders.filter(p => p.id !== preferredProvider.id)];

		let resolvedProvider = candidates[0];
		let resolvedApiKey: string | undefined;
		let resolvedExtraEnv: Record<string, string> | undefined;

		for (const candidate of candidates) {
			const cred = await resolveCredential(candidate, this.secretService, this.geminiAuthService, this.qwenAuthService);
			if (cred) {
				resolvedProvider = candidate;
				resolvedApiKey = cred.token;
				resolvedExtraEnv = cred.extraEnv;
				break;
			}
		}

		if (!resolvedApiKey) {
			throw new Error('API key ausente.');
		}

		const providerConfig = buildProviderConfig(resolvedProvider);
		const env = buildEnvFromProvider(resolvedProvider, resolvedApiKey, resolvedExtraEnv);

		const adapter = disposables.add(this.instantiationService.createInstance(QwenRuntimeAdapter));
		const stream = adapter.runTask(
			providerConfig,
			{ env, maskedEnv: {} },
			{ prompt, systemPrompt, includePartialMessages: false, maxToolCallRounds: 0 },
			CancellationToken.None,
		);

		let response = '';
		for await (const chunk of stream) {
			if (chunk.type === 'content' && chunk.value) {
				response += chunk.value;
			}
		}

		return response;
	}
}

// ─── Git log parser ──────────────────────────────────────────────────────────
function parseGitLog(stdout: string): IGitCommitEntry[] {
	const entries: IGitCommitEntry[] = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) { continue; }
		const parts = trimmed.split('|');
		if (parts.length < 4) { continue; }
		entries.push({
			hash: parts[0],
			author: parts[1],
			date: parts[2],
			timestamp: new Date(parts[2]).getTime(),
			subject: parts.slice(3).join('|'),
		});
	}
	return entries;
}

// ─── Group commits into phases by temporal proximity ─────────────────────────
function groupCommitsIntoPhases(commits: IGitCommitEntry[]): IHistoryPhase[] {
	if (commits.length === 0) { return []; }

	const sorted = [...commits].sort((a, b) => a.timestamp - b.timestamp);
	const phases: IHistoryPhase[] = [];
	let currentPhase: IHistoryPhase = {
		label: '',
		commits: [sorted[0]],
		startDate: sorted[0].timestamp,
		endDate: sorted[0].timestamp,
	};

	const PHASE_GAP_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

	for (let i = 1; i < sorted.length; i++) {
		const gap = sorted[i].timestamp - currentPhase.endDate;
		if (gap > PHASE_GAP_MS) {
			// New phase
			phases.push(currentPhase);
			currentPhase = {
				label: '',
				commits: [sorted[i]],
				startDate: sorted[i].timestamp,
				endDate: sorted[i].timestamp,
			};
		} else {
			currentPhase.commits.push(sorted[i]);
			currentPhase.endDate = sorted[i].timestamp;
		}
	}
	phases.push(currentPhase);

	return phases;
}

// ─── Credential Resolver (shared) ────────────────────────────────────────────
async function resolveCredential(
	provider: INeocodeSwarmProviderConfig,
	secretService: INeocodeSwarmSecretService,
	geminiAuthService: IGeminiAuthService,
	qwenAuthService: IQwenAuthService,
): Promise<{ token: string; extraEnv?: Record<string, string> } | undefined> {
	if (provider.type === 'gemini') {
		try {
			const runtimeEnv = await geminiAuthService.buildRuntimeEnv();
			const token = runtimeEnv.env['GEMINI_API_KEY'] ?? runtimeEnv.env['GOOGLE_API_KEY'];
			if (token?.trim()) { return { token }; }
		} catch { /* fall through */ }
	}

	if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
		try {
			const envData = await qwenAuthService.buildRuntimeEnv();
			const qwenConfig = qwenAuthService.loadConfig();
			const rawToken = envData.env[qwenConfig.envVarName];
			if (rawToken?.trim()) { return { token: rawToken, extraEnv: envData.env }; }
		} catch { /* fall through */ }
	}

	const scope = provider.type === 'custom' ? provider.id : provider.type;
	for (const kind of ['apiKey', 'loginToken', 'cliToken'] as const) {
		for (const storageKey of scope !== provider.id ? [scope, provider.id] : [scope]) {
			const val = await secretService.getProviderSecret(storageKey, kind);
			if (!val?.trim()) { continue; }
			if (val.trim().startsWith('{')) { continue; }
			return { token: val };
		}
	}

	return undefined;
}

function extractStdout(toolOutput: string): string {
	const match = toolOutput.match(/STDOUT:\n([\s\S]*?)(?:\nSTDERR:|\nExit Code:|\nTimed Out:|$)/);
	if (match) { return match[1].trimEnd(); }
	const matchLower = toolOutput.match(/stdout:\n([\s\S]*?)(?:\nstderr:|\nexit code:|\ntimed out:|$)/i);
	if (matchLower) { return matchLower[1].trimEnd(); }
	return toolOutput;
}

function extractExitCode(toolOutput: string): number {
	const match = toolOutput.match(/Exit Code:\s*(\d+)/i);
	return match ? parseInt(match[1], 10) : -1;
}
