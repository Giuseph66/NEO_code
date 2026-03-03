/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { NEO_SWARM_OPEN_SETTINGS_COMMAND_ID } from '../common/neocodeSwarmTypes.js';
import { NeocodeSwarmSettingsEditor, NeocodeSwarmSettingsEditorInput } from './neocodeSwarmSettingsEditor.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { INeocodeSwarmSecretService, INeocodeSwarmStorageService } from '../common/neocodeSwarmStorage.js';
import { NeocodeSwarmSecretService } from './neocodeSwarmSecretService.js';
import { NeocodeSwarmStorageService } from './neocodeSwarmStorageService.js';
import { NeocodeSwarmChatParticipant } from './neocodeSwarmChatParticipant.js';
import { NeocodeExternalEditWatcher } from './neocodeExternalEditWatcher.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import { NeocodeSwarmActivityService } from './neocodeSwarmActivityService.js';
import {
	NeocodeSwarmActivityEditorInput,
	NeocodeSwarmActivityEditorPane,
	createActivityEditorInput,
} from './neocodeSwarmActivityPanel.js';
import { ISCMService, ISCMRepository } from '../../../contrib/scm/common/scm.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { QwenRuntimeAdapter } from '../../neocode/qwen/browser/qwenRuntimeAdapter.js';
import { INeocodeSwarmProviderConfig } from '../common/neocodeSwarmTypes.js';
import { buildProviderConfig, buildEnvFromProvider } from './neocodeSwarmOrchestrator.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { NeocodeSwarmToolExecutor } from './neocodeSwarmToolExecutor.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IGeminiAuthService } from '../../neocode/gemini/common/geminiTypes.js';
import { IQwenAuthService } from '../../neocode/qwen/common/qwenTypes.js';
import { INeoCodeCodeReviewService, NeoCodeCodeReviewService } from './neocodeSwarmCodeReview.js';
import { NeoCodeHistoryInsights } from './neocodeSwarmHistoryInsights.js';
import { INeoCodeConflictResolverService, NeoCodeConflictResolverService } from './neocodeSwarmConflictResolver.js';
import { IChatWidgetService } from '../../chat/browser/chat.js';
import { IChatExecuteActionContext } from '../../chat/browser/actions/chatExecuteActions.js';
import { NeocodeSwarmVoiceInlinePanel } from './neocodeSwarmVoiceInlinePanel.js';
import { NeocodeSwarmVoiceTranscriptionService } from './neocodeSwarmVoiceTranscriptionService.js';
import { NeocodeSwarmBranchModal, IStashInfo } from './neocodeSwarmBranchModal.js';


const NEOCODE_SETTINGS_MENU = MenuId.for('NeoCodeSettingsMenu');
const NEOCODE_GLOBAL_SETTINGS_MENU = MenuId.for('NeoCodeGlobalSettingsMenu');

// ─── Singleton services ───────────────────────────────────────────────────

registerSingleton(INeocodeSwarmSecretService, NeocodeSwarmSecretService, InstantiationType.Delayed);
registerSingleton(INeocodeSwarmStorageService, NeocodeSwarmStorageService, InstantiationType.Delayed);
registerSingleton(INeocodeSwarmActivityService, NeocodeSwarmActivityService, InstantiationType.Delayed);
registerSingleton(INeoCodeCodeReviewService, NeoCodeCodeReviewService, InstantiationType.Delayed);
registerSingleton(INeoCodeConflictResolverService, NeoCodeConflictResolverService, InstantiationType.Delayed);

// ─── Workbench contributions ──────────────────────────────────────────────

registerWorkbenchContribution2(NeocodeSwarmChatParticipant.ID, NeocodeSwarmChatParticipant, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(NeocodeExternalEditWatcher.ID, NeocodeExternalEditWatcher, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(NeoCodeHistoryInsights.ID, NeoCodeHistoryInsights, WorkbenchPhase.AfterRestored);

// ─── Status Bar ──────────────────────────────────────────────────────────────

class NeoCodeCodeReviewStatusBarContribution extends Disposable {
	static readonly ID = 'workbench.contrib.neocodeCodeReviewStatusBar';

	constructor(
		@IStatusbarService statusbarService: IStatusbarService
	) {
		super();
		this._register(statusbarService.addEntry({
			name: 'NeoCode Review',
			text: '$(beaker) NeoCode Review',
			ariaLabel: 'NeoCode Review',
			tooltip: 'Abrir opções de Revisão de Código IA',
			command: 'neocode.reviewQuickPick',
		}, 'neocode.reviewStatusBar', StatusbarAlignment.RIGHT, 100));
	}
}
registerWorkbenchContribution2(NeoCodeCodeReviewStatusBarContribution.ID, NeoCodeCodeReviewStatusBarContribution, WorkbenchPhase.AfterRestored);

// ─── Menus ────────────────────────────────────────────────────────────────

MenuRegistry.appendMenuItem(MenuId.MenubarPreferencesMenu, {
	title: localize('neoCodeMenu', "NeoCode"),
	submenu: NEOCODE_SETTINGS_MENU,
	group: '4_configuration',
	order: 6,
});

MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	title: localize('neoCodeMenuGlobal', "NeoCode"),
	submenu: NEOCODE_GLOBAL_SETTINGS_MENU,
	group: '3_configuration',
	order: 6,
});

// ─── Settings editor pane ─────────────────────────────────────────────────

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NeocodeSwarmSettingsEditor,
		NeocodeSwarmSettingsEditor.ID,
		localize('neocodeSwarmSettingsEditor', "Editor de Configuracoes do Enxame"),
	),
	[new SyncDescriptor(NeocodeSwarmSettingsEditorInput)],
);

class NeocodeSwarmSettingsEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof NeocodeSwarmSettingsEditorInput;
	}
	serialize(_editorInput: EditorInput): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return instantiationService.createInstance(NeocodeSwarmSettingsEditorInput);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NeocodeSwarmSettingsEditorInput.ID,
	NeocodeSwarmSettingsEditorSerializer,
);

// ─── Activity panel pane ──────────────────────────────────────────────────

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NeocodeSwarmActivityEditorPane,
		NeocodeSwarmActivityEditorPane.ID,
		localize('neocodeSwarmActivityEditor', "NeoCode Swarm Activity"),
	),
	[new SyncDescriptor(NeocodeSwarmActivityEditorInput)],
);

class NeocodeSwarmActivityEditorSerializer implements IEditorSerializer {
	canSerialize(editorInput: EditorInput): boolean {
		return editorInput instanceof NeocodeSwarmActivityEditorInput;
	}
	serialize(_editorInput: EditorInput): string {
		return '';
	}
	deserialize(instantiationService: IInstantiationService): EditorInput {
		return createActivityEditorInput(instantiationService);
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(
	NeocodeSwarmActivityEditorInput.ID,
	NeocodeSwarmActivityEditorSerializer,
);

// ─── Actions ──────────────────────────────────────────────────────────────

registerAction2(class OpenNeoSwarmSettingsAction extends Action2 {
	constructor() {
		super({
			id: NEO_SWARM_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('neocodeOpenSwarmSettings', "NeoCode: Configurar Enxame de Agentes"),
			category: Categories.Preferences,
			icon: Codicon.settingsGear,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 1 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 1 },
				{ id: MenuId.TitleBar, group: '5_neocode', order: 1 },
				{ id: MenuId.LayoutControlMenu, group: 'neocode', order: 1 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		await editorService.openEditor(instantiationService.createInstance(NeocodeSwarmSettingsEditorInput), { pinned: true });
	}
});

registerAction2(class OpenNeoSwarmActivityAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.openSwarmActivity',
			title: localize2('neocodeOpenSwarmActivity', "NeoCode: Abrir Painel de Atividade do Enxame"),
			category: Categories.Preferences,
			icon: Codicon.dashboard,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: NEOCODE_GLOBAL_SETTINGS_MENU, group: '1_neocode', order: 2 },
				{ id: NEOCODE_SETTINGS_MENU, group: '1_neocode', order: 2 },
				{ id: MenuId.TitleBar, group: '5_neocode', order: 2 },
				{ id: MenuId.LayoutControlMenu, group: 'neocode', order: 2 },
				{ id: MenuId.ChatViewSessionTitleToolbar, group: 'navigation', order: 99 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);
		const input = createActivityEditorInput(instantiationService);
		await editorService.openEditor(input, { pinned: false, revealIfOpened: true });
	}
});

registerAction2(class NeoCodeVoiceInputAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.voiceInput',
			title: localize2('neocodeVoiceInput', "NeoCode: Gravar Audio para Chat"),
			category: Categories.View,
			icon: Codicon.mic,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.ChatExecute, group: 'navigation', order: 99 },
			],
		});
	}

	async run(accessor: ServicesAccessor, context?: IChatExecuteActionContext): Promise<void> {
		const chatWidgetService = accessor.get(IChatWidgetService);
		const notificationService = accessor.get(INotificationService);
		const instantiationService = accessor.get(IInstantiationService);

		const widget = context?.widget ?? chatWidgetService.lastFocusedWidget;
		if (!widget) {
			notificationService.warn(localize('neoVoice.noChatWidget', "Abra um chat do NeoCode antes de usar o microfone."));
			return;
		}
		const voiceHost = widget.input.inputContainerElement ?? widget.domNode;
		if (!voiceHost) {
			notificationService.warn(localize('neoVoice.noChatInputHost', "Nao foi possivel abrir o gravador dentro do chat atual."));
			return;
		}
		if (voiceHost.querySelector('.neo-voice-inline-panel')) {
			notificationService.info(localize('neoVoice.panelAlreadyOpen', "O gravador de audio ja esta aberto neste chat."));
			return;
		}

		const transcriptionService = instantiationService.createInstance(NeocodeSwarmVoiceTranscriptionService);
		const panel = new NeocodeSwarmVoiceInlinePanel(
			audioBlob => transcriptionService.transcribeAudio(audioBlob),
			2 * 60 * 1000
		);

		const result = await panel.show(voiceHost);
		if (!result) {
			return;
		}

		const text = result.transcription.trim();
		if (!text) {
			notificationService.warn(localize('neoVoice.emptyResult', "A transcricao nao retornou texto."));
			return;
		}

		if (result.sendImmediately) {
			widget.focusInput();
			await widget.acceptInput(text, { isVoiceInput: true });
			return;
		}

		const currentInput = widget.getInput();
		const separator = currentInput.length > 0 && !currentInput.endsWith('\n') ? '\n' : '';
		widget.setInput(`${currentInput}${separator}${text}`);
		widget.focusInput();
		notificationService.info(localize('neoVoice.insertedInChat', "Transcricao inserida no chat."));
	}
});

registerAction2(class NeoCodeBranchManagerAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.branchManager',
			title: localize2('neocodeBranchManager', "NeoCode: Gerenciador de Branches"),
			category: Categories.View,
			icon: Codicon.gitBranch,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const instantiationService = accessor.get(IInstantiationService);
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const notificationService = accessor.get(INotificationService);
		const executor = instantiationService.createInstance(NeocodeSwarmToolExecutor);
		const context = resolveRepoContext(args, scmService, workspaceService);
		if (!context) {
			notificationService.error(localize('neoBranch.noRepo', "Nenhum repositório Git encontrado."));
			return;
		}

		const cwd = context.cwd;

		const loadData = async () => {
			const branchOut = await this.runGit(executor, cwd, 'branch -a');
			const stashOut = await this.runGit(executor, cwd, 'stash list');

			const lines = branchOut.split('\n');
			const localBranches: string[] = [];
			const remoteBranches: string[] = [];
			let currentBranch = '';

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed) { continue; }

				const isCurrent = trimmed.startsWith('*');
				const name = trimmed.replace(/^\*\s*/, '').trim();

				if (name.includes('remotes/')) {
					remoteBranches.push(name.replace('remotes/', ''));
				} else {
					localBranches.push(name);
					if (isCurrent) { currentBranch = name; }
				}
			}

			const stashes: IStashInfo[] = stashOut.split('\n')
				.filter(l => l.trim())
				.map(l => {
					const match = l.match(/^(stash@\{\d+\}): (.*)$/);
					return match ? { id: match[1], message: match[2] } : { id: '?', message: l };
				});

			return { localBranches, remoteBranches, currentBranch, stashes };
		};

		// Criar o modal imediatamente em estado de loading para feedback instantâneo
		const modal = new NeocodeSwarmBranchModal({
			currentBranch: '',
			localBranches: [],
			remoteBranches: [],
			stashes: [],
			isLoading: true,
			onCheckout: async (branch) => {
				const isRemote = branch.startsWith('origin/');
				const cmd = isRemote ? `checkout -b ${branch.replace('origin/', '')} --track ${branch}` : `checkout ${branch}`;
				const res = await this.runGit(executor, cwd, cmd);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.checkedOut', "Checkout realizado: {0}", branch));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onCreate: async (name) => {
				const res = await this.runGit(executor, cwd, `checkout -b ${name}`);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.created', "Branch criada: {0}", name));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onMerge: async (branch) => {
				const res = await this.runGit(executor, cwd, `merge ${branch}`);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.merged', "Merge realizado: {0}", branch));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onDelete: async (branch) => {
				const res = await this.runGit(executor, cwd, `branch -d ${branch}`);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.deleted', "Branch removida: {0}", branch));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onStashPop: async (id) => {
				const res = await this.runGit(executor, cwd, `stash pop ${id}`);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.stashPopped', "Stash aplicado: {0}", id));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onStashDrop: async (id) => {
				const res = await this.runGit(executor, cwd, `stash drop ${id}`);
				if (res.includes('Error:')) {
					notificationService.error(res);
				} else {
					notificationService.info(localize('neoBranch.stashDropped', "Stash removido: {0}", id));
					const newData = await loadData();
					modal.updateOptions(newData);
				}
			},
			onRefresh: async () => {
				const newData = await loadData();
				modal.updateOptions(newData);
			}
		});

		void modal.show();

		// Carregar os dados reais em background
		loadData().then(data => {
			modal.updateOptions({ ...data, isLoading: false });
		}).catch(err => {
			notificationService.error(localize('neoBranch.loadError', "Erro ao carregar dados do Git: {0}", err.message));
			modal.dispose();
			executor.dispose();
		});
	}

	private async runGit(executor: NeocodeSwarmToolExecutor, cwd: string, command: string): Promise<string> {
		const result = await executor.execute({
			id: 'git-cmd',
			name: 'run_terminal',
			arguments: {
				command: `git ${command}`,
				working_dir: cwd
			}
		});

		// Limpar o output do ToolExecutor (remover headers de Command, CWD, etc)
		const out = result.content;
		const stdoutMarker = 'STDOUT:\n';
		const stdoutIdx = out.indexOf(stdoutMarker);
		if (stdoutIdx !== -1) {
			return out.slice(stdoutIdx + stdoutMarker.length).trim();
		}

		// Se não tiver o marcador STDOUT (ex: erro ou comando sem output), tenta remover o header manually
		return out.replace(/^Command:.*?\nCWD:.*?\nTimeout:.*?\nDuration:.*?\nExit Code:.*?\nTimed Out:.*?\n\n/s, '').trim();
	}
});

// ─── Shared helpers for git actions ─────────────────────────────────────────

function resolveRepoContext(
	args: any[],
	scmService: ISCMService,
	workspaceService: IWorkspaceContextService,
): { repo: ISCMRepository; cwd: string } | undefined {
	let repo: ISCMRepository | undefined;
	for (const arg of args) {
		if (arg && arg.provider && arg.input) {
			repo = arg as ISCMRepository;
			break;
		}
		if (typeof arg === 'string') {
			repo = Array.from(scmService.repositories).find(r => r.provider.rootUri?.fsPath === arg);
			if (repo) { break; }
		}
	}
	if (!repo) {
		const repos = Array.from(scmService.repositories);
		if (repos.length > 0) { repo = repos[0]; }
	}
	const cwd = repo?.provider?.rootUri?.fsPath
		?? workspaceService.getWorkspace().folders[0]?.uri.fsPath
		?? '';
	return cwd && repo ? { repo, cwd } : undefined;
}

async function generateAiCommitMessage(
	diffText: string,
	toolExecutor: NeocodeSwarmToolExecutor,
	targetCwd: string,
	enabledProviders: INeocodeSwarmProviderConfig[],
	preferredProvider: INeocodeSwarmProviderConfig,
	secretService: INeocodeSwarmSecretService,
	geminiAuthService: IGeminiAuthService,
	qwenAuthService: IQwenAuthService,
	instantiationService: IInstantiationService,
	disposables: DisposableStore,
	onStatus: (msg: string) => void,
): Promise<string> {
	const commitPrompt = `Você é um gerador de \`git commit\` automático e experiente.
Abaixo está o diff das alterações (git diff --cached).
Escreva uma mensagem de commit seguindo o padrão **Conventional Commits** (feat, fix, refactor, chore, docs, test).
Se o diff for muito extenso, elabore o body (com quebra de linha após o título) descrevendo em bullet points as modificações principais.
Use português brasileiro de forma descritiva.
Retorne APENAS a mensagem pronta, sem bloco de código, aspas em volta ou explicações adicionais.

--- DIFF ---
${diffText.slice(0, 8000)}`;

	const systemPromptText = 'Você responde apenas com a mensagem final do commit. Nunca use \\`\\`\\` para delimitar. Não inclua opiniões ou prefácios (como \'Aqui está a mensagem:\'). Nenhuma formatação extra.';

	const runGitInternal = async (command: string, timeoutSeconds = 60) => {
		const result = await toolExecutor.execute({
			id: `smart-commit-${Date.now()}`,
			name: 'run_terminal',
			arguments: { command, working_dir: targetCwd, timeout_seconds: timeoutSeconds },
		});
		return { output: result.content, error: !!result.isError };
	};

	const writePromptFile = async (path: string, content: string) => {
		await toolExecutor.execute({
			id: `smart-commit-write-${Date.now()}`,
			name: 'write_file',
			arguments: { path, content },
		});
	};

	let generatedMessage = '';

	// ─── Path A: Anthropic CLI (claude -p) ──────────────────────────────
	if (preferredProvider.type === 'anthropic' && (preferredProvider.authMethod === 'login' || preferredProvider.authMethod === 'cliToken')) {
		const model = preferredProvider.selectedModel ?? preferredProvider.models[0] ?? '';
		const tmpFile = `/tmp/neo-smart-commit-${Date.now()}.txt`;
		await writePromptFile(tmpFile, `System:\n${systemPromptText}\n\nUser:\n${commitPrompt}`);
		const cliArgs = ['-p'];
		if (model && /^claude-/i.test(model)) { cliArgs.push('--model', model); }
		onStatus(`🤖 Gerando commit via Claude CLI (${model || 'default'})...`);
		const claudeResult = await runGitInternal(`cat ${tmpFile} | claude ${cliArgs.join(' ')}; rm -f ${tmpFile}`, 180);
		const claudeStdout = extractStdout(claudeResult.output);
		const claudeExitCode = extractExitCode(claudeResult.output);
		if (claudeExitCode !== 0 || !claudeStdout.trim()) {
			throw new Error(`Claude CLI falhou (exit ${claudeExitCode}): ${claudeStdout || claudeResult.output}`);
		}
		generatedMessage = claudeStdout;

		// ─── Path B: OpenAI Codex CLI ────────────────────────────────────────
	} else if (preferredProvider.type === 'openai' && preferredProvider.authMethod === 'login') {
		const model = preferredProvider.selectedModel ?? preferredProvider.models[0] ?? '';
		const tmpFile = `/tmp/neo-smart-commit-${Date.now()}.txt`;
		await writePromptFile(tmpFile, `${systemPromptText}\n\n${commitPrompt}`);
		const codexArgs = ['exec', '-p'];
		if (model) { codexArgs.push('--model', model); }
		onStatus(`🤖 Gerando commit via Codex CLI (${model || 'default'})...`);
		const codexResult = await runGitInternal(`cat ${tmpFile} | codex ${codexArgs.join(' ')}; rm -f ${tmpFile}`, 180);
		const codexStdout = extractStdout(codexResult.output);
		const codexExitCode = extractExitCode(codexResult.output);
		if (codexExitCode !== 0 || !codexStdout.trim()) {
			throw new Error(`Codex CLI falhou (exit ${codexExitCode}): ${codexStdout || codexResult.output}`);
		}
		generatedMessage = codexStdout;

		// ─── Path C: QwenRuntimeAdapter (bearer / oauth) ─────────────────────
	} else {
		const candidates = [preferredProvider, ...enabledProviders.filter(p => p.id !== preferredProvider.id)];
		let resolvedProvider = candidates[0];
		let resolvedApiKey: string | undefined;
		let resolvedExtraEnv: Record<string, string> | undefined;
		for (const candidate of candidates) {
			const cred = await resolveSmartCommitCredential(candidate, secretService, geminiAuthService, qwenAuthService);
			if (cred) { resolvedProvider = candidate; resolvedApiKey = cred.token; resolvedExtraEnv = cred.extraEnv; break; }
		}
		if (!resolvedApiKey) {
			throw new Error('API key ausente. Configure e salve a credencial no painel "Configurar Enxame".');
		}
		const providerConfig = buildProviderConfig(resolvedProvider);
		const env = buildEnvFromProvider(resolvedProvider, resolvedApiKey, resolvedExtraEnv);
		const adapter = disposables.add(instantiationService.createInstance(QwenRuntimeAdapter));
		const stream = adapter.runTask(providerConfig, { env, maskedEnv: {} }, {
			prompt: commitPrompt,
			systemPrompt: systemPromptText,
			includePartialMessages: false,
			maxToolCallRounds: 0,
		}, CancellationToken.None);
		for await (const chunk of stream) {
			if (chunk.type === 'content' && chunk.value) { generatedMessage += chunk.value; }
		}
	}

	return generatedMessage.trim().replace(/^['"]|['"]$/g, '');
}

// ─── SCM input box: generate message only ────────────────────────────────────
registerAction2(class NeoCodeSmartCommitAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.smartCommit',
			title: localize2('neocodeSmartCommit', "NeoCode: Gerar Mensagem de Commit com IA"),
			category: 'Git',
			icon: Codicon.sparkle,
			menu: [{
				id: MenuId.SCMInputBox,
				group: 'navigation',
				order: 1,
			}]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const secretService = accessor.get(INeocodeSwarmSecretService);
		const storageService = accessor.get(INeocodeSwarmStorageService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);
		const geminiAuthService = accessor.get(IGeminiAuthService);
		const qwenAuthService = accessor.get(IQwenAuthService);

		const ctx = resolveRepoContext(args, scmService, workspaceService);
		if (!ctx) {
			await dialogService.warn(localize('neocode.noGitRepo', "Nenhum repositório Git encontrado."));
			return;
		}
		const { repo, cwd } = ctx;
		const previousInputValue = repo.input.value;

		const disposables = new DisposableStore();
		const toolExecutor = disposables.add(instantiationService.createInstance(NeocodeSwarmToolExecutor));
		const runGit = async (command: string, timeoutSeconds = 60) => {
			const result = await toolExecutor.execute({
				id: `smart-commit-${Date.now()}`, name: 'run_terminal',
				arguments: { command, working_dir: cwd, timeout_seconds: timeoutSeconds },
			});
			return { output: result.content, error: !!result.isError };
		};

		try {
			repo.input.setValue('🤖 Adicionando arquivos ao stage...', false);
			const addResult = await runGit('git add .');
			if (addResult.error) { throw new Error(addResult.output); }

			repo.input.setValue('🤖 Lendo diff do stage...', false);
			const diffResult = await runGit('git diff --cached');
			const diffText = extractStdout(diffResult.output);

			if (!diffText?.trim()) {
				await dialogService.info(localize('neocode.noStagedChanges', "Não há alterações no stage."));
				repo.input.setValue(previousInputValue, false);
				return;
			}

			const config = storageService.load();
			const enabledProviders = config?.providers?.filter(p => p.enabled) ?? [];
			if (enabledProviders.length === 0) {
				throw new Error('Nenhum provedor habilitado. Configure o NeoCode Swarm.');
			}
			const preferredProvider = enabledProviders.find(p => p.id === config.orchestrator.providerId) ?? enabledProviders[0];

			repo.input.setValue('🤖 Gerando mensagem de commit com IA...', false);
			const message = await generateAiCommitMessage(
				diffText, toolExecutor, cwd, enabledProviders, preferredProvider,
				secretService, geminiAuthService, qwenAuthService, instantiationService, disposables,
				msg => repo.input.setValue(msg, false),
			);

			repo.input.setValue(message || previousInputValue, false);
			if (!message) { await dialogService.warn('A IA não retornou uma mensagem válida.'); }
		} catch (err: any) {
			repo.input.setValue(previousInputValue, false);
			await dialogService.error(err.message || 'Erro ao gerar mensagem de commit.');
		} finally {
			disposables.dispose();
		}
	}
});

// ─── SCM title bar: Add + AI Commit + Push ───────────────────────────────────
registerAction2(class NeoCodeSmartAddCommitPushAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.smartAddCommitPush',
			title: localize2('neocodeSmartAddCommitPush', "NeoCode: Add + Smart Commit + Push"),
			category: 'Git',
			icon: Codicon.cloudUpload,
			menu: [{ id: MenuId.SCMInputBox, group: 'navigation', order: 10 }]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const secretService = accessor.get(INeocodeSwarmSecretService);
		const storageService = accessor.get(INeocodeSwarmStorageService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);
		const geminiAuthService = accessor.get(IGeminiAuthService);
		const qwenAuthService = accessor.get(IQwenAuthService);

		const ctx = resolveRepoContext(args, scmService, workspaceService);
		if (!ctx) { await dialogService.warn(localize('neocode.noGitRepo', "Nenhum repositório Git encontrado.")); return; }
		const { repo, cwd } = ctx;
		const previousInputValue = repo.input.value;

		const disposables = new DisposableStore();
		const toolExecutor = disposables.add(instantiationService.createInstance(NeocodeSwarmToolExecutor));
		const runGit = async (command: string, timeoutSeconds = 60) => {
			const result = await toolExecutor.execute({
				id: `smart-commit-${Date.now()}`, name: 'run_terminal',
				arguments: { command, working_dir: cwd, timeout_seconds: timeoutSeconds },
			});
			return { output: result.content, error: !!result.isError };
		};

		try {
			repo.input.setValue('🤖 Adicionando arquivos ao stage...', false);
			const addResult = await runGit('git add .');
			if (addResult.error) { throw new Error(addResult.output); }

			repo.input.setValue('🤖 Lendo diff...', false);
			const diffResult = await runGit('git diff --cached');
			const diffText = extractStdout(diffResult.output);
			if (!diffText?.trim()) {
				await dialogService.info(localize('neocode.noStagedChanges', "Não há alterações no stage."));
				repo.input.setValue(previousInputValue, false);
				return;
			}

			const config = storageService.load();
			const enabledProviders = config?.providers?.filter(p => p.enabled) ?? [];
			if (enabledProviders.length === 0) { throw new Error('Nenhum provedor habilitado. Configure o NeoCode Swarm.'); }
			const preferredProvider = enabledProviders.find(p => p.id === config.orchestrator.providerId) ?? enabledProviders[0];

			repo.input.setValue('🤖 Gerando mensagem de commit com IA...', false);
			const message = await generateAiCommitMessage(
				diffText, toolExecutor, cwd, enabledProviders, preferredProvider,
				secretService, geminiAuthService, qwenAuthService, instantiationService, disposables,
				msg => repo.input.setValue(msg, false),
			);
			if (!message) { repo.input.setValue(previousInputValue, false); await dialogService.warn('A IA não retornou uma mensagem válida.'); return; }

			const escapedMessage = message.replace(/'/g, `'\''`);
			repo.input.setValue(`🤖 Realizando commit...\n\n${message}`, false);
			const commitResult = await runGit(`git commit -m '${escapedMessage}'`);
			if (commitResult.error && !commitResult.output.includes('nothing to commit')) {
				throw new Error('Erro ao commitar: ' + commitResult.output);
			}

			repo.input.setValue('🤖 Fazendo push...', false);
			const pushResult = await runGit('git push');
			if (pushResult.error) { throw new Error('Erro ao fazer push: ' + pushResult.output); }

			repo.input.setValue('', false);
			await dialogService.info(localize('neocode.smartCommitSuccess', "Smart Commit e Push concluídos com sucesso!"));
		} catch (err: any) {
			repo.input.setValue(previousInputValue, false);
			await dialogService.error(err.message || 'Erro no Smart Add + Commit + Push.');
		} finally {
			disposables.dispose();
		}
	}
});

// ─── SCM title bar: Add + AI Commit (no push) ────────────────────────────────
registerAction2(class NeoCodeSmartAddCommitAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.smartAddCommit',
			title: localize2('neocodeSmartAddCommit', "NeoCode: Add + Smart Commit"),
			category: 'Git',
			icon: Codicon.gitCommit,
			menu: [{ id: MenuId.SCMInputBox, group: 'navigation', order: 11 }]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const secretService = accessor.get(INeocodeSwarmSecretService);
		const storageService = accessor.get(INeocodeSwarmStorageService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);
		const geminiAuthService = accessor.get(IGeminiAuthService);
		const qwenAuthService = accessor.get(IQwenAuthService);

		const ctx = resolveRepoContext(args, scmService, workspaceService);
		if (!ctx) { await dialogService.warn(localize('neocode.noGitRepo', "Nenhum repositório Git encontrado.")); return; }
		const { repo, cwd } = ctx;
		const previousInputValue = repo.input.value;

		const disposables = new DisposableStore();
		const toolExecutor = disposables.add(instantiationService.createInstance(NeocodeSwarmToolExecutor));
		const runGit = async (command: string, timeoutSeconds = 60) => {
			const result = await toolExecutor.execute({
				id: `smart-commit-${Date.now()}`, name: 'run_terminal',
				arguments: { command, working_dir: cwd, timeout_seconds: timeoutSeconds },
			});
			return { output: result.content, error: !!result.isError };
		};

		try {
			repo.input.setValue('🤖 Adicionando arquivos ao stage...', false);
			const addResult = await runGit('git add .');
			if (addResult.error) { throw new Error(addResult.output); }

			repo.input.setValue('🤖 Lendo diff...', false);
			const diffResult = await runGit('git diff --cached');
			const diffText = extractStdout(diffResult.output);
			if (!diffText?.trim()) {
				await dialogService.info(localize('neocode.noStagedChanges', "Não há alterações no stage."));
				repo.input.setValue(previousInputValue, false);
				return;
			}

			const config = storageService.load();
			const enabledProviders = config?.providers?.filter(p => p.enabled) ?? [];
			if (enabledProviders.length === 0) { throw new Error('Nenhum provedor habilitado. Configure o NeoCode Swarm.'); }
			const preferredProvider = enabledProviders.find(p => p.id === config.orchestrator.providerId) ?? enabledProviders[0];

			repo.input.setValue('🤖 Gerando mensagem de commit com IA...', false);
			const message = await generateAiCommitMessage(
				diffText, toolExecutor, cwd, enabledProviders, preferredProvider,
				secretService, geminiAuthService, qwenAuthService, instantiationService, disposables,
				msg => repo.input.setValue(msg, false),
			);
			if (!message) { repo.input.setValue(previousInputValue, false); await dialogService.warn('A IA não retornou uma mensagem válida.'); return; }

			const escapedMessage = message.replace(/'/g, `'\''`);
			repo.input.setValue(`🤖 Realizando commit...\n\n${message}`, false);
			const commitResult = await runGit(`git commit -m '${escapedMessage}'`);
			if (commitResult.error && !commitResult.output.includes('nothing to commit')) {
				throw new Error('Erro ao commitar: ' + commitResult.output);
			}

			repo.input.setValue('', false);
			await dialogService.info(localize('neocode.smartAddCommitSuccess', "Smart Add + Commit concluídos com sucesso!"));
		} catch (err: any) {
			repo.input.setValue(previousInputValue, false);
			await dialogService.error(err.message || 'Erro no Smart Add + Commit.');
		} finally {
			disposables.dispose();
		}
	}
});

// ─── SCM title bar: Commit + Push (uses input box message) ───────────────────
registerAction2(class NeoCodeCommitPushAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.commitAndPush',
			title: localize2('neocodeCommitAndPush', "NeoCode: Commit + Push"),
			category: 'Git',
			icon: Codicon.arrowCircleUp,
			menu: [{ id: MenuId.SCMInputBox, group: 'navigation', order: 12 }]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);

		const ctx = resolveRepoContext(args, scmService, workspaceService);
		if (!ctx) { await dialogService.warn(localize('neocode.noGitRepo', "Nenhum repositório Git encontrado.")); return; }
		const { repo, cwd } = ctx;
		const message = repo.input.value.trim();
		if (!message) { await dialogService.warn(localize('neocode.noCommitMessage', "Insira uma mensagem de commit antes de commitar.")); return; }

		const disposables = new DisposableStore();
		const toolExecutor = disposables.add(instantiationService.createInstance(NeocodeSwarmToolExecutor));
		const runGit = async (command: string) => {
			const result = await toolExecutor.execute({
				id: `git-${Date.now()}`, name: 'run_terminal',
				arguments: { command, working_dir: cwd, timeout_seconds: 60 },
			});
			return { output: result.content, error: !!result.isError };
		};

		try {
			const escapedMessage = message.replace(/'/g, `'\''`);
			const commitResult = await runGit(`git commit -m '${escapedMessage}'`);
			if (commitResult.error && !commitResult.output.includes('nothing to commit')) {
				throw new Error('Erro ao commitar: ' + commitResult.output);
			}
			const pushResult = await runGit('git push');
			if (pushResult.error) { throw new Error('Erro ao fazer push: ' + pushResult.output); }
			repo.input.setValue('', false);
			await dialogService.info(localize('neocode.commitPushSuccess', "Commit e Push concluídos com sucesso!"));
		} catch (err: any) {
			await dialogService.error(err.message || 'Erro no Commit + Push.');
		} finally {
			disposables.dispose();
		}
	}
});

// ─── SCM title bar: Push only ────────────────────────────────────────────────
registerAction2(class NeoCodePushAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.push',
			title: localize2('neocodePush', "NeoCode: Push"),
			category: 'Git',
			icon: Codicon.arrowUp,
			menu: [{ id: MenuId.SCMInputBox, group: 'navigation', order: 14 }]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const scmService = accessor.get(ISCMService);
		const workspaceService = accessor.get(IWorkspaceContextService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);

		const ctx = resolveRepoContext(args, scmService, workspaceService);
		if (!ctx) { await dialogService.warn(localize('neocode.noGitRepo', "Nenhum repositório Git encontrado.")); return; }
		const { cwd } = ctx;

		const disposables = new DisposableStore();
		const toolExecutor = disposables.add(instantiationService.createInstance(NeocodeSwarmToolExecutor));

		try {
			const result = await toolExecutor.execute({
				id: `git-push-${Date.now()}`, name: 'run_terminal',
				arguments: { command: 'git push', working_dir: cwd, timeout_seconds: 60 },
			});
			const exitCode = extractExitCode(result.content);
			if (exitCode !== 0) { throw new Error('Erro ao fazer push: ' + extractStdout(result.content)); }
			await dialogService.info(localize('neocode.pushSuccess', "Push concluído com sucesso!"));
		} catch (err: any) {
			await dialogService.error(err.message || 'Erro ao fazer push.');
		} finally {
			disposables.dispose();
		}
	}
});

// ─── Code Review Actions ──────────────────────────────────────────────────

registerAction2(class NeoCodeCodeReviewAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.codeReview',
			title: localize2('neocodeCodeReview', "NeoCode: AI Code Review"),
			category: Categories.Preferences,
			icon: Codicon.eye,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.EditorTitle, group: 'navigation', order: 99 },
				{ id: MenuId.EditorContext, group: 'neocode', order: 1 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const reviewService = accessor.get(INeoCodeCodeReviewService);
		const dialogService = accessor.get(IDialogService);
		const progressService = accessor.get(IProgressService);
		const commandService = accessor.get(ICommandService);

		const editor = editorService.activeTextEditorControl;
		if (!editor) {
			await dialogService.info('Nenhum editor de texto ativo.');
			return;
		}

		const model = editor.getModel();
		if (!model || !('uri' in model)) {
			await dialogService.info('Nenhum arquivo aberto para revisar.');
			return;
		}

		const textModel = model as { uri: import('../../../../base/common/uri.js').URI; getValue(): string; getLanguageId(): string };

		try {
			await progressService.withProgress({
				location: ProgressLocation.Notification,
				title: 'NeoCode: Analisando código com IA...',
				cancellable: false
			}, async () => {
				await reviewService.reviewFile(textModel.uri, textModel.getValue(), textModel.getLanguageId());
			});

			// Abrir a aba Problems automaticamente para mostrar os resultados
			await commandService.executeCommand('workbench.actions.view.problems');
		} catch (err: any) {
			await dialogService.error(`Erro na revisão: ${err.message}`);
		}
	}
});

registerAction2(class NeoCodeClearReviewAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.clearCodeReview',
			title: localize2('neocodeClearReview', "NeoCode: Limpar Revisão IA"),
			category: Categories.Preferences,
			icon: Codicon.clearAll,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const reviewService = accessor.get(INeoCodeCodeReviewService);
		reviewService.clearAllReviews();
	}
});

registerAction2(class NeoCodeReviewQuickPickAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.reviewQuickPick',
			title: localize2('neocodeReviewQuickPick', "NeoCode: Opções de Revisão de Código"),
			category: Categories.Preferences,
			f1: false, // Invocado via barra de status, não precisa na paleta principal
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);

		const pick = await quickInputService.pick([
			{ id: 'neocode.codeReview', label: '$(eye) Revisar Arquivo Atual', description: 'Usa IA para analisar o código aberto' },
			{ id: 'neocode.clearCodeReview', label: '$(clear-all) Limpar Resultados de Revisão', description: 'Remove os marcadores de IA' }
		], { placeHolder: 'Selecione uma ação de revisão de código' });

		if (pick && pick.id) {
			await commandService.executeCommand(pick.id);
		}
	}
});

// ─── History Insights Actions ─────────────────────────────────────────────

registerAction2(class NeoCodeAIBlameAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.aiBlame',
			title: localize2('neocodeAIBlame', "NeoCode: AI Blame Explanation"),
			category: Categories.Preferences,
			icon: Codicon.history,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.EditorContext, group: 'neocode', order: 2 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const dialogService = accessor.get(IDialogService);
		const instantiationService = accessor.get(IInstantiationService);

		const editor = editorService.activeTextEditorControl;
		if (!editor) {
			await dialogService.info('Nenhum editor de texto ativo.');
			return;
		}

		const model = editor.getModel();
		const position = editor.getPosition();
		if (!model || !('uri' in model) || !position) {
			await dialogService.info('Nenhum arquivo aberto ou cursor posicionado.');
			return;
		}

		const textModel = model as { uri: import('../../../../base/common/uri.js').URI };
		const lineNumber = position.lineNumber;

		try {
			// Obter a instância do NeoCodeHistoryInsights via instantiation
			const insightsService = instantiationService.createInstance(NeoCodeHistoryInsights);
			const explanation = await insightsService.explainBlame(textModel.uri.fsPath, lineNumber);
			insightsService.dispose();

			await dialogService.info(
				`🧠 AI Blame — Linha ${lineNumber}`,
				explanation
			);
		} catch (err: any) {
			await dialogService.error(`Erro na análise: ${err.message}`);
		}
	}
});

// ─── Conflict Resolution Actions ─────────────────────────────────────────

registerAction2(class NeoCodeSmartResolveAction extends Action2 {
	constructor() {
		super({
			id: 'neocode.smartResolve',
			title: localize2('neocodeSmartResolve', "NeoCode: 🤖 Smart Resolve (Resolver Conflitos com IA)"),
			category: Categories.Preferences,
			icon: Codicon.merge,
			f1: true,
			menu: [
				{ id: MenuId.CommandPalette },
				{ id: MenuId.EditorTitle, group: 'navigation', order: 98 },
				{ id: MenuId.EditorContext, group: 'neocode', order: 3 },
			],
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const resolverService = accessor.get(INeoCodeConflictResolverService);
		const dialogService = accessor.get(IDialogService);

		const editor = editorService.activeTextEditorControl;
		if (!editor) {
			await dialogService.info('Nenhum editor de texto ativo.');
			return;
		}

		const model = editor.getModel();
		if (!model || !('uri' in model)) {
			await dialogService.info('Nenhum arquivo aberto.');
			return;
		}

		const textModel = model as { uri: import('../../../../base/common/uri.js').URI; getValue(): string; getLanguageId(): string; setValue(value: string): void };
		const content = textModel.getValue();

		// Verificar se há conflitos
		if (!content.includes('<<<<<<<')) {
			await dialogService.info('Nenhum conflito de merge encontrado neste arquivo.');
			return;
		}

		try {
			const resolved = await resolverService.resolveConflicts(textModel.uri, content, textModel.getLanguageId());

			if (resolved && resolved !== content) {
				textModel.setValue(resolved);
				await dialogService.info('✅ Conflitos resolvidos com IA! Revise o resultado e salve o arquivo.');
			} else {
				await dialogService.warn('A IA não conseguiu resolver os conflitos automaticamente.');
			}
		} catch (err: any) {
			await dialogService.error(`Erro ao resolver conflitos: ${err.message}`);
		}
	}
});

/**
 * Resolve credencial de um provider para uso no Smart Commit.
 * Replica a mesma lógica do chatParticipant.resolveCredential()
 * mas retornando apenas credentials compatíveis com QwenRuntimeAdapter (bearer tokens).
 */
async function resolveSmartCommitCredential(
	provider: INeocodeSwarmProviderConfig,
	secretService: INeocodeSwarmSecretService,
	geminiAuthService: IGeminiAuthService,
	qwenAuthService: IQwenAuthService,
): Promise<{ token: string; extraEnv?: Record<string, string> } | undefined> {
	// Gemini: OAuth Bearer token via GeminiAuthService
	if (provider.type === 'gemini') {
		try {
			const runtimeEnv = await geminiAuthService.buildRuntimeEnv();
			const token = runtimeEnv.env['GEMINI_API_KEY'] ?? runtimeEnv.env['GOOGLE_API_KEY'];
			if (token?.trim()) { return { token }; }
		} catch { /* fall through */ }
	}

	// Qwen Code: OAuth session via IQwenAuthService
	if (provider.type === 'qwen-code' && provider.authMethod === 'qwen-oauth') {
		try {
			const envData = await qwenAuthService.buildRuntimeEnv();
			const qwenConfig = qwenAuthService.loadConfig();
			const rawToken = envData.env[qwenConfig.envVarName];
			if (rawToken?.trim()) { return { token: rawToken, extraEnv: envData.env }; }
		} catch { /* fall through */ }
	}

	// Plain API key (any provider) — tenta secretService
	const scope = provider.type === 'custom' ? provider.id : provider.type;
	for (const kind of ['apiKey', 'loginToken', 'cliToken'] as const) {
		for (const storageKey of scope !== provider.id ? [scope, provider.id] : [scope]) {
			const val = await secretService.getProviderSecret(storageKey, kind);
			if (!val?.trim()) { continue; }
			if (val.trim().startsWith('{')) { continue; } // Skip JSON bundles
			return { token: val };
		}
	}

	return undefined;
}

/**
 * Extrai apenas o conteúdo do STDOUT da saída formatada do NeocodeSwarmToolExecutor.
 * O formato é: "Command: ...\nSTDOUT:\n<content>\nSTDERR:\n<content>\nExit Code: N"
 */
function extractStdout(toolOutput: string): string {
	// Formato do ToolExecutor: linhas entre "STDOUT:" e "STDERR:" (ou "Exit Code:")
	const match = toolOutput.match(/STDOUT:\n([\s\S]*?)(?:\nSTDERR:|\nExit Code:|\nTimed Out:|$)/);
	if (match) { return match[1].trimEnd(); }

	// Fallback: tentar formato "stdout:\n" (tudo minúsculo)
	const matchLower = toolOutput.match(/stdout:\n([\s\S]*?)(?:\nstderr:|\nexit code:|\ntimed out:|$)/i);
	if (matchLower) { return matchLower[1].trimEnd(); }

	return toolOutput;
}

/**
 * Extrai o exit code da saída formatada do NeocodeSwarmToolExecutor.
 */
function extractExitCode(toolOutput: string): number {
	const match = toolOutput.match(/Exit Code:\s*(\d+)/i);
	return match ? parseInt(match[1], 10) : -1;
}
