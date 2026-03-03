/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INeocodeSwarmSecretService, INeocodeSwarmStorageService } from '../common/neocodeSwarmStorage.js';
import { INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';
import { IGeminiAuthService } from '../../neocode/gemini/common/geminiTypes.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { QwenRuntimeAdapter } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { buildProviderConfig, buildEnvFromProvider } from './neocodeSwarmOrchestrator.js';
import { NeocodeSwarmToolExecutor } from './neocodeSwarmToolExecutor.js';

// ─── Service ID ──────────────────────────────────────────────────────────────
export const INeoCodeConflictResolverService = createDecorator<INeoCodeConflictResolverService>('neoCodeConflictResolverService');

export interface INeoCodeConflictResolverService {
	readonly _serviceBrand: undefined;
	resolveConflicts(uri: URI, content: string, languageId: string): Promise<string | undefined>;
	readonly isResolving: boolean;
}

// ─── Conflict block parsed from markers ──────────────────────────────────────
interface IConflictBlock {
	/** Full text of the conflict block (including markers) */
	fullMatch: string;
	/** "Ours" / Current Change (HEAD) */
	ours: string;
	/** "Theirs" / Incoming Change */
	theirs: string;
	/** Branch labels extracted from markers */
	oursLabel: string;
	theirsLabel: string;
	/** Start index in the file content */
	startIndex: number;
}

// ─── Service Implementation ──────────────────────────────────────────────────
export class NeoCodeConflictResolverService extends Disposable implements INeoCodeConflictResolverService {
	declare readonly _serviceBrand: undefined;

	private _isResolving = false;
	get isResolving(): boolean { return this._isResolving; }

	constructor(
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	/**
	 * Analisa e resolve TODOS os blocos de conflito de um arquivo.
	 * Retorna o conteúdo do arquivo completo com os conflitos resolvidos,
	 * ou undefined se não houver conflitos.
	 */
	async resolveConflicts(uri: URI, content: string, languageId: string): Promise<string | undefined> {
		if (this._isResolving) { return undefined; }
		this._isResolving = true;

		const disposables = new DisposableStore();

		try {
			// 1. Extrair blocos de conflito
			const conflicts = parseConflictBlocks(content);

			if (conflicts.length === 0) {
				return undefined; // Sem conflitos
			}

			console.log(`[neocode merge] Encontrados ${conflicts.length} conflito(s) em ${uri.fsPath}`);

			// 2. Tentar obter a versão "base" via git (3-way merge context)
			let baseContent = '';
			try {
				const toolExecutor = disposables.add(this.instantiationService.createInstance(NeocodeSwarmToolExecutor));
				const baseResult = await toolExecutor.execute({
					id: `merge-base-${Date.now()}`,
					name: 'run_terminal',
					arguments: {
						command: `git show :1:"${uri.fsPath}" 2>/dev/null || echo ""`,
						timeout_seconds: 10,
					},
				});
				baseContent = extractStdout(baseResult.content);
			} catch {
				// Base não disponível, seguir sem ela
			}

			// 3. Resolver cada conflito via IA
			let resolvedContent = content;

			for (const conflict of conflicts) {
				const resolution = await this.resolveOneConflict(disposables, conflict, baseContent, languageId, uri.fsPath);
				if (resolution) {
					resolvedContent = resolvedContent.replace(conflict.fullMatch, resolution);
				}
			}

			console.log(`[neocode merge] Resolvidos ${conflicts.length} conflito(s)`);
			return resolvedContent;

		} catch (err: any) {
			console.error('[neocode merge] Erro:', err.message);
			throw err;
		} finally {
			disposables.dispose();
			this._isResolving = false;
		}
	}

	// ─── Resolve um conflito individual ──────────────────────────────────────
	private async resolveOneConflict(
		disposables: DisposableStore,
		conflict: IConflictBlock,
		baseContent: string,
		languageId: string,
		filePath: string,
	): Promise<string | undefined> {
		const prompt = `Você é um especialista em resolução de conflitos de merge no Git.

Arquivo: \`${filePath}\` (linguagem: ${languageId})
Branch atual (HEAD): ${conflict.oursLabel || 'HEAD'}
Branch incoming: ${conflict.theirsLabel || 'Incoming'}

=== VERSÃO CURRENT (HEAD / Ours) ===
${conflict.ours}

=== VERSÃO INCOMING (Theirs) ===
${conflict.theirs}

${baseContent ? `=== VERSÃO BASE (último commit comum) ===\n${baseContent.slice(0, 3000)}\n` : ''}

TAREFA: Integre AMBAS as mudanças de forma inteligente, garantindo:
1. Sintaxe válida em ${languageId}
2. Sem duplicação de declarações, imports ou funções
3. Preservar a intenção de ambas as branches
4. Se uma branch adicionou funcionalidade e a outra refatorou, combine ambas

Retorne APENAS o código resolvido, sem marcadores de conflito, sem explicação, sem bloco \`\`\`.`;

		const systemPrompt = 'Você é um mediador de merge inteligente. Retorne APENAS o código resolvido final, sem explicações, blocos de código markdown, ou prefácios. O resultado será inserido diretamente no arquivo.';

		const rawResponse = await this.callAI(disposables, prompt, systemPrompt);

		if (!rawResponse?.trim()) { return undefined; }

		// Limpar possíveis blocos ```
		let resolved = rawResponse.trim();
		const codeBlockMatch = resolved.match(/```(?:\w+)?\s*\n([\s\S]*?)\n\s*```/);
		if (codeBlockMatch) {
			resolved = codeBlockMatch[1];
		}

		return resolved;
	}

	// ─── Call AI (reusable) ──────────────────────────────────────────────────
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
				id: `merge-ai-${Date.now()}`,
				name: 'run_terminal',
				arguments: { command, timeout_seconds: 120 },
			});
			return result.content;
		};

		const tmpFile = `/tmp/neo-merge-${Date.now()}.txt`;
		const fullPrompt = `System:\n${systemPrompt}\n\nUser:\n${prompt}`;
		await runCmd(`cat > ${tmpFile} << 'NEOMERGEEOF'\n${fullPrompt}\nNEOMERGEEOF`);

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
			if (model) { cliArgs.push('--model', model); }
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

// ─── Conflict Parser ─────────────────────────────────────────────────────────

/**
 * Parseia blocos de conflito do Git no formato:
 * <<<<<<< HEAD
 * ... (ours)
 * =======
 * ... (theirs)
 * >>>>>>> branch-name
 */
function parseConflictBlocks(content: string): IConflictBlock[] {
	const conflicts: IConflictBlock[] = [];
	const regex = /^(<{7}\s*(.+)\n)([\s\S]*?)^(={7}\n)([\s\S]*?)^(>{7}\s*(.+)\n?)/gm;

	let match: RegExpExecArray | null;
	while ((match = regex.exec(content)) !== null) {
		conflicts.push({
			fullMatch: match[0],
			ours: match[3].trimEnd(),
			theirs: match[5].trimEnd(),
			oursLabel: match[2].trim(),
			theirsLabel: match[7].trim(),
			startIndex: match.index,
		});
	}

	return conflicts;
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

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
