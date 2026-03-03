/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarkerService, IMarkerData, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
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
export const INeoCodeCodeReviewService = createDecorator<INeoCodeCodeReviewService>('neoCodeCodeReviewService');

export interface INeoCodeCodeReviewService {
	readonly _serviceBrand: undefined;
	reviewFile(uri: URI, content: string, languageId: string): Promise<void>;
	clearReview(uri: URI): void;
	clearAllReviews(): void;
	readonly isReviewing: boolean;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const MARKER_OWNER = 'neocode-ai-review';

// ─── AI Response Types ───────────────────────────────────────────────────────
interface IAIReviewIssue {
	line: number;
	endLine?: number;
	severity: 'error' | 'warning' | 'info';
	message: string;
	suggestion?: string;
}

interface IAIReviewResponse {
	issues: IAIReviewIssue[];
}

// ─── Service Implementation ──────────────────────────────────────────────────
export class NeoCodeCodeReviewService extends Disposable implements INeoCodeCodeReviewService {
	declare readonly _serviceBrand: undefined;

	private _isReviewing = false;
	get isReviewing(): boolean { return this._isReviewing; }

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
		@INeocodeSwarmStorageService private readonly storageService: INeocodeSwarmStorageService,
		@INeocodeSwarmSecretService private readonly secretService: INeocodeSwarmSecretService,
		@IGeminiAuthService private readonly geminiAuthService: IGeminiAuthService,
		@IQwenAuthService private readonly qwenAuthService: IQwenAuthService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
	}

	async reviewFile(uri: URI, content: string, languageId: string): Promise<void> {
		if (this._isReviewing) { return; }
		this._isReviewing = true;

		const disposables = new DisposableStore();

		try {
			console.log(`[neocode review] Iniciando revisão de ${uri.fsPath}`);

			// ── 1. Carregar config e resolver provider ─────────────────────────
			const config = this.storageService.load();
			const enabledProviders = config?.providers?.filter(p => p.enabled) ?? [];

			if (enabledProviders.length === 0) {
				throw new Error('Nenhum provedor habilitado configurado.');
			}

			const preferredProvider = enabledProviders.find(p => p.id === config.orchestrator.providerId)
				|| enabledProviders[0];

			// ── 2. Montar a prompt ─────────────────────────────────────────────
			const truncatedContent = content.slice(0, 12000);
			const prompt = this.buildReviewPrompt(truncatedContent, uri.fsPath, languageId);
			const systemPrompt = 'Você é um revisor de código sênior. Responda EXCLUSIVAMENTE com um JSON válido no formato especificado. Não inclua texto, markdown, ou explicações fora do JSON.';

			// ── 3. Chamar IA ───────────────────────────────────────────────────
			let rawResponse = '';

			// Path A: Anthropic CLI
			if (preferredProvider.type === 'anthropic' && (preferredProvider.authMethod === 'login' || preferredProvider.authMethod === 'cliToken')) {
				rawResponse = await this.callViaCLI(disposables, 'claude', preferredProvider, prompt, systemPrompt);

				// Path B: OpenAI CLI
			} else if (preferredProvider.type === 'openai' && preferredProvider.authMethod === 'login') {
				rawResponse = await this.callViaCLI(disposables, 'codex', preferredProvider, prompt, systemPrompt);

				// Path C: QwenRuntimeAdapter (bearer/oauth)
			} else {
				rawResponse = await this.callViaAdapter(disposables, enabledProviders, preferredProvider, prompt, systemPrompt);
			}

			console.log(`[neocode review] Resposta bruta (${rawResponse.length} chars)`);

			// ── 4. Parsear resposta e gerar markers ─────────────────────────────
			const markers = this.parseAIResponse(rawResponse, uri);
			this.markerService.changeOne(MARKER_OWNER, uri, markers);

			console.log(`[neocode review] ${markers.length} diagnósticos criados para ${uri.fsPath}`);

		} catch (err: any) {
			console.error('[neocode review] Erro:', err.message);
			throw err;
		} finally {
			disposables.dispose();
			this._isReviewing = false;
		}
	}

	clearReview(uri: URI): void {
		this.markerService.remove(MARKER_OWNER, [uri]);
	}

	clearAllReviews(): void {
		const existingMarkers = this.markerService.read({ owner: MARKER_OWNER });
		const uris = [...new Set(existingMarkers.map(m => m.resource))];
		if (uris.length > 0) {
			this.markerService.remove(MARKER_OWNER, uris);
		}
	}

	// ─── Private: Build Review Prompt ────────────────────────────────────────
	private buildReviewPrompt(content: string, filePath: string, languageId: string): string {
		return `Analise o arquivo \`${filePath}\` (linguagem: ${languageId}). Foque em:
- Más práticas de engenharia de software (Clean Code, SOLID, Design Patterns)
- Vulnerabilidades de segurança (SQL injection, XSS, dados sensíveis expostos)
- Performance (complexidade O(N²) disfarçada, loops desnecessários, memória)
- Débitos técnicos e code smells
- Naming conventions incorretas

Ignore: formatação pura (espaçamento, aspas, indentação, trailing commas).

Responda ESTRITAMENTE em JSON:
{ "issues": [ { "line": <número da linha>, "endLine": <número da linha final (opcional)>, "severity": "error"|"warning"|"info", "message": "<explicação concisa do problema>", "suggestion": "<correção sugerida (opcional)>" } ] }

Se o código estiver limpo, retorne: { "issues": [] }

--- CÓDIGO ---
${content}`;
	}

	// ─── Private: Call via CLI (claude / codex) ──────────────────────────────
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
				id: `code-review-${Date.now()}`,
				name: 'run_terminal',
				arguments: { command, timeout_seconds: 120 },
			});
			return result.content;
		};

		const tmpFile = `/tmp/neo-code-review-${Date.now()}.txt`;
		const fullPrompt = `System:\n${systemPrompt}\n\nUser:\n${prompt}`;
		await runCmd(`cat > ${tmpFile} << 'NEOREVIEWEOF'\n${fullPrompt}\nNEOREVIEWEOF`);

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
			throw new Error(`${cliName} CLI falhou (exit ${exitCode}): ${stdout || output}`);
		}

		return stdout;
	}

	// ─── Private: Call via QwenRuntimeAdapter ────────────────────────────────
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
			throw new Error('API key ausente. Configure e salve a credencial no painel "Configurar Enxame".');
		}

		const providerConfig = buildProviderConfig(resolvedProvider);
		const env = buildEnvFromProvider(resolvedProvider, resolvedApiKey, resolvedExtraEnv);

		const adapter = disposables.add(this.instantiationService.createInstance(QwenRuntimeAdapter));
		const stream = adapter.runTask(
			providerConfig,
			{ env, maskedEnv: {} },
			{
				prompt,
				systemPrompt,
				includePartialMessages: false,
				maxToolCallRounds: 0,
			},
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

	// ─── Private: Parse AI Response → IMarkerData[] ─────────────────────────
	private parseAIResponse(raw: string, _uri: URI): IMarkerData[] {
		// Tentar extrair JSON de possível markdown/text wrapper
		let jsonStr = raw.trim();

		// Remover blocos ```json ... ```
		const jsonBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
		if (jsonBlockMatch) {
			jsonStr = jsonBlockMatch[1].trim();
		}

		// Tentar encontrar o objeto JSON se tiver texto em volta
		const jsonObjMatch = jsonStr.match(/\{[\s\S]*"issues"[\s\S]*\}/);
		if (jsonObjMatch) {
			jsonStr = jsonObjMatch[0];
		}

		let parsed: IAIReviewResponse;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			console.warn('[neocode review] Falha ao parsear JSON da IA:', jsonStr.slice(0, 200));
			return [];
		}

		if (!parsed.issues || !Array.isArray(parsed.issues)) {
			return [];
		}

		return parsed.issues
			.filter(issue => issue.line && issue.message)
			.map(issue => ({
				severity: mapSeverity(issue.severity),
				message: issue.suggestion
					? `${issue.message}\n💡 Sugestão: ${issue.suggestion}`
					: issue.message,
				source: 'NeoCode AI Review',
				startLineNumber: Math.max(1, issue.line),
				startColumn: 1,
				endLineNumber: issue.endLine ?? issue.line,
				endColumn: Number.MAX_SAFE_INTEGER,
				code: 'neocode-review',
			}));
	}
}

// ─── Shared Helpers ──────────────────────────────────────────────────────────

function mapSeverity(severity: string): MarkerSeverity {
	switch (severity) {
		case 'error': return MarkerSeverity.Error;
		case 'warning': return MarkerSeverity.Warning;
		case 'info': return MarkerSeverity.Info;
		default: return MarkerSeverity.Warning;
	}
}

/**
 * Resolve credencial de um provider para uso com QwenRuntimeAdapter.
 */
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
