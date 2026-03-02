/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ISwarmExecutionPlan } from '../common/neocodeSwarmTypes.js';

const MIN_AGENT_COUNT = 1;
const MAX_AGENT_COUNT = 20;
const MIN_TIME_BUDGET_MINUTES = 1;

export interface ISwarmExecutionPreferences {
	agentCount: number;
	timeMode: 'defined' | 'indeterminate';
	timeBudgetMinutes?: number;
	plan?: ISwarmExecutionPlan;
}

type ISwarmPlanPreviewResolver = (preferences: Readonly<ISwarmExecutionPreferences>) => Promise<ISwarmExecutionPlan>;

enum ModalStep {
	TIME_MODE = 1,
	TIME_VALUE = 2,
	AGENT_COUNT = 3,
	SUMMARY = 4
}

export class NeocodeSwarmCustomModal extends Disposable {
	private overlay: HTMLElement | undefined;
	private container: HTMLElement | undefined;
	private body: HTMLElement | undefined;
	private footer: HTMLElement | undefined;
	private titleEl: HTMLElement | undefined;

	private currentStep: ModalStep = ModalStep.TIME_MODE;
	private preferences: ISwarmExecutionPreferences;
	private summaryPlan: ISwarmExecutionPlan | undefined;
	private summaryLoading = false;
	private summaryError: string | undefined;
	private summaryRequestId = 0;

	private resolve: ((value: ISwarmExecutionPreferences | undefined) => void) | undefined;

	constructor(
		initialAgentCount: number,
		initialTimeBudgetMinutes: number,
		private readonly planPreviewResolver: ISwarmPlanPreviewResolver
	) {
		super();
		this.preferences = {
			agentCount: this.normalizeAgentCount(initialAgentCount),
			timeMode: 'defined',
			timeBudgetMinutes: this.normalizeDefinedTime(initialTimeBudgetMinutes)
		};
	}

	async show(): Promise<ISwarmExecutionPreferences | undefined> {
		return new Promise(resolve => {
			this.resolve = resolve;
			this.create();
			this.renderStep();
		});
	}

	private create(): void {
		this.overlay = dom.append(document.body, dom.$('.neo-swarm-modal-overlay'));
		this._register(dom.addDisposableListener(this.overlay, dom.EventType.CLICK, (e) => {
			if (e.target === this.overlay) { this.cancel(); }
		}));

		this.container = dom.append(this.overlay, dom.$('.neo-swarm-modal-container'));

		const header = dom.append(this.container, dom.$('.neo-swarm-modal-header'));
		dom.append(header, dom.$('.icon', undefined, '🤖'));
		this.titleEl = dom.append(header, dom.$('h2', undefined, localize('neoSwarm.modal.title', "Configurar Enxame")));

		this.body = dom.append(this.container, dom.$('.neo-swarm-modal-body'));
		this.footer = dom.append(this.container, dom.$('.neo-swarm-modal-footer'));
	}

	private renderStep(): void {
		if (!this.body || !this.footer || !this.titleEl) { return; }

		dom.clearNode(this.body);
		dom.clearNode(this.footer);

		const stepContainer = dom.append(this.body, dom.$('.neo-step-content'));

		switch (this.currentStep) {
			case ModalStep.TIME_MODE:
				this.renderTimeModeStep(stepContainer);
				break;
			case ModalStep.TIME_VALUE:
				this.renderTimeValueStep(stepContainer);
				break;
			case ModalStep.AGENT_COUNT:
				this.renderAgentCountStep(stepContainer);
				break;
			case ModalStep.SUMMARY:
				this.renderSummaryStep(stepContainer);
				break;
		}

		this.renderFooter();
	}

	private renderTimeModeStep(container: HTMLElement): void {
		this.titleEl!.textContent = localize('neoSwarm.step1.title', "Passo 1: Modo de Tempo");
		dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.step1.desc', "Escolha como o enxame deve gerenciar o tempo de execução.")));

		const grid = dom.append(container, dom.$('.neo-option-grid'));

		const definedCard = dom.append(grid, dom.$('.neo-option-card', { 'data-mode': 'defined' }));
		if (this.preferences.timeMode === 'defined') { definedCard.classList.add('selected'); }
		dom.append(definedCard, dom.$('.icon', undefined, '🕒'));
		dom.append(definedCard, dom.$('h3', undefined, localize('neoSwarm.mode.defined', "Tempo Definido")));
		dom.append(definedCard, dom.$('p', undefined, localize('neoSwarm.mode.defined.desc', "Você define exatamente quanto tempo o enxame pode trabalhar.")));
		this._register(dom.addDisposableListener(definedCard, dom.EventType.CLICK, () => {
			this.preferences.timeMode = 'defined';
			this.next();
		}));

		const indeterminateCard = dom.append(grid, dom.$('.neo-option-card', { 'data-mode': 'indeterminate' }));
		if (this.preferences.timeMode === 'indeterminate') { indeterminateCard.classList.add('selected'); }
		dom.append(indeterminateCard, dom.$('.icon', undefined, '♾️'));
		dom.append(indeterminateCard, dom.$('h3', undefined, localize('neoSwarm.mode.indeterminate', "Tempo Indeterminado")));
		dom.append(indeterminateCard, dom.$('p', undefined, localize('neoSwarm.mode.indeterminate.desc', "O enxame trabalha até considerar a tarefa concluída.")));
		this._register(dom.addDisposableListener(indeterminateCard, dom.EventType.CLICK, () => {
			this.preferences.timeMode = 'indeterminate';
			this.next();
		}));
	}

	private renderTimeValueStep(container: HTMLElement): void {
		this.titleEl!.textContent = localize('neoSwarm.step2.title', "Passo 2: Configuração de Tempo");

		if (this.preferences.timeMode === 'defined') {
			dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.step2.defined.desc', "Defina o orçamento de tempo para esta tarefa.")));

			const inputRow = dom.append(container, dom.$('.neo-input-row'));
			const minutes = this.normalizeDefinedTime(this.preferences.timeBudgetMinutes);
			const hours = Math.floor(minutes / 60);
			const mins = minutes % 60;

			const hoursGroup = dom.append(inputRow, dom.$('.neo-input-group', { style: 'flex: 1' }));
			dom.append(hoursGroup, dom.$('label', undefined, localize('neoSwarm.hours', "Horas")));
			const hoursInput = dom.append(hoursGroup, dom.$('input.neo-premium-input', {
				type: 'number',
				value: String(hours),
				min: '0',
				max: '23'
			})) as HTMLInputElement;

			const minsGroup = dom.append(inputRow, dom.$('.neo-input-group', { style: 'flex: 1' }));
			dom.append(minsGroup, dom.$('label', undefined, localize('neoSwarm.minutes', "Minutos")));
			const minsInput = dom.append(minsGroup, dom.$('input.neo-premium-input', {
				type: 'number',
				value: String(mins),
				min: '0',
				max: '59'
			})) as HTMLInputElement;

			const updateTime = () => {
				const h = Math.max(0, parseInt(hoursInput.value) || 0);
				const m = Math.max(0, Math.min(59, parseInt(minsInput.value) || 0));
				this.preferences.timeBudgetMinutes = this.normalizeDefinedTime((h * 60) + m);
			};

			this._register(dom.addDisposableListener(hoursInput, dom.EventType.INPUT, updateTime));
			this._register(dom.addDisposableListener(minsInput, dom.EventType.INPUT, updateTime));
		} else {
			dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.step2.indeterminate.desc', "Aviso sobre o modo de tempo indeterminado.")));
			const warningBox = dom.append(container, dom.$('.neo-warning-box'));
			dom.append(warningBox, dom.$('.icon', undefined, '⚠️'));
			dom.append(warningBox, dom.$('p', undefined, localize('neoSwarm.indeterminate.warning', "Tempo indeterminado significa que o agente vai trabalhar até onde ele achar que está concluída a tarefa, diferente de tempo definido que obriga o enxame a trabalhar o tempo que o usuário definir!")));
		}
	}

	private renderAgentCountStep(container: HTMLElement): void {
		this.titleEl!.textContent = localize('neoSwarm.step3.title', "Passo 3: Quantidade de Agentes");
		dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.step3.desc', "Quantos agentes especialistas devem atuar em paralelo?")));

		const inputGroup = dom.append(container, dom.$('.neo-input-group'));
		dom.append(inputGroup, dom.$('label', undefined, localize('neoSwarm.agents', "Agentes (1-20)")));
		const agentInput = dom.append(inputGroup, dom.$('input.neo-premium-input', {
			type: 'number',
			value: String(this.preferences.agentCount),
			min: String(MIN_AGENT_COUNT),
			max: String(MAX_AGENT_COUNT)
		})) as HTMLInputElement;

		this._register(dom.addDisposableListener(agentInput, dom.EventType.INPUT, () => {
			this.preferences.agentCount = this.normalizeAgentCount(parseInt(agentInput.value) || MIN_AGENT_COUNT);
		}));
	}

	private renderSummaryStep(container: HTMLElement): void {
		this.titleEl!.textContent = localize('neoSwarm.step4.title', "Resumo e Confirmação");

		const timeLabel = this.preferences.timeMode === 'indeterminate'
			? localize('neoSwarm.time.indeterminate', "Indeterminado")
			: this.formatTime(this.preferences.timeBudgetMinutes ?? MIN_TIME_BUDGET_MINUTES);

		const badges = dom.append(container, dom.$('.neo-summary-badges', { style: 'display: flex; gap: 12px; margin-bottom: 24px;' }));
		dom.append(badges, dom.$('.neo-agent-summary-badge', undefined, `👥 ${this.preferences.agentCount} Agentes`));
		dom.append(badges, dom.$('.neo-agent-summary-badge', undefined, `⏱️ ${timeLabel}`));

		if (this.summaryLoading) {
			dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.summary.loading', "Gerando plano de agentes com base na sua quantidade selecionada...")));
			return;
		}

		if (this.summaryError) {
			dom.append(container, dom.$('.neo-warning-box', undefined, `⚠️ ${this.summaryError}`));
			return;
		}

		if (!this.summaryPlan || this.summaryPlan.agents.length === 0) {
			dom.append(container, dom.$('.neo-step-desc', undefined, localize('neoSwarm.summary.empty', "Nenhum agente foi planejado ainda.")));
			return;
		}

		dom.append(container, dom.$('h3', { style: 'font-size: 14px; opacity: 0.6; text-transform: uppercase; letter-spacing: 1px;' }, localize('neoSwarm.tasks.title', "Tarefas Planejadas")));
		const grid = dom.append(container, dom.$('.neo-agent-grid'));

		for (const agent of this.summaryPlan.agents) {
			const card = dom.append(grid, dom.$('.neo-agent-task-card'));
			const header = dom.append(card, dom.$('.neo-agent-task-header'));
			dom.append(header, dom.$('.emoji', undefined, agent.emoji));
			dom.append(header, dom.$('.name', undefined, agent.name));
			dom.append(header, dom.$('.role', undefined, agent.role));
			dom.append(card, dom.$('.neo-agent-task-body', undefined, agent.task));
		}
	}

	private renderFooter(): void {
		if (!this.footer) { return; }

		const cancelBtn = dom.append(this.footer, dom.$('button.neo-modal-btn.danger', undefined, localize('neoSwarm.cancel', "Cancelar")));
		this._register(dom.addDisposableListener(cancelBtn, dom.EventType.CLICK, () => this.cancel()));

		dom.append(this.footer, dom.$('div', { style: 'flex: 1' }));

		if (this.currentStep > ModalStep.TIME_MODE) {
			const backBtn = dom.append(this.footer, dom.$('button.neo-modal-btn', undefined, localize('neoSwarm.back', "Voltar")));
			this._register(dom.addDisposableListener(backBtn, dom.EventType.CLICK, () => this.back()));
		}

		if (this.currentStep === ModalStep.SUMMARY && this.summaryError) {
			const retryBtn = dom.append(this.footer, dom.$('button.neo-modal-btn', undefined, localize('neoSwarm.retry', "Regerar plano")));
			this._register(dom.addDisposableListener(retryBtn, dom.EventType.CLICK, () => void this.loadSummaryPlan()));
		}

		const isLast = this.currentStep === ModalStep.SUMMARY;
		const canConfirmSummary = !!this.summaryPlan && !this.summaryLoading && !this.summaryError && this.summaryPlan.agents.length > 0;
		const label = isLast
			? (this.summaryLoading
				? localize('neoSwarm.loadingPlan', "Gerando plano...")
				: localize('neoSwarm.start', "Iniciar Enxame 🚀"))
			: localize('neoSwarm.next', "Próximo");

		const nextBtn = dom.append(this.footer, dom.$('button.neo-modal-btn.primary', undefined, label)) as HTMLButtonElement;
		if (isLast && !canConfirmSummary) {
			nextBtn.disabled = true;
		}

		this._register(dom.addDisposableListener(nextBtn, dom.EventType.CLICK, () => {
			if (isLast) {
				this.confirm();
			} else {
				this.next();
			}
		}));
	}

	private next(): void {
		if (this.currentStep >= ModalStep.SUMMARY) { return; }

		if (this.currentStep === ModalStep.TIME_VALUE && this.preferences.timeMode === 'defined') {
			this.preferences.timeBudgetMinutes = this.normalizeDefinedTime(this.preferences.timeBudgetMinutes);
		}

		this.currentStep++;
		this.renderStep();

		if (this.currentStep === ModalStep.SUMMARY) {
			void this.loadSummaryPlan();
		}
	}

	private back(): void {
		if (this.currentStep <= ModalStep.TIME_MODE) { return; }

		if (this.currentStep === ModalStep.SUMMARY) {
			this.summaryPlan = undefined;
			this.summaryError = undefined;
			this.summaryLoading = false;
		}

		this.currentStep--;
		this.renderStep();
	}

	private async loadSummaryPlan(): Promise<void> {
		const requestId = ++this.summaryRequestId;
		this.summaryLoading = true;
		this.summaryError = undefined;
		this.summaryPlan = undefined;
		this.renderStep();

		try {
			const preview = await this.planPreviewResolver({
				agentCount: this.normalizeAgentCount(this.preferences.agentCount),
				timeMode: this.preferences.timeMode,
				timeBudgetMinutes: this.preferences.timeMode === 'defined'
					? this.normalizeDefinedTime(this.preferences.timeBudgetMinutes)
					: undefined,
			});
			if (requestId !== this.summaryRequestId || this.currentStep !== ModalStep.SUMMARY) { return; }
			this.summaryPlan = preview;
		} catch (err) {
			if (requestId !== this.summaryRequestId || this.currentStep !== ModalStep.SUMMARY) { return; }
			const message = err instanceof Error ? err.message : String(err);
			this.summaryError = localize('neoSwarm.summary.error', "Falha ao gerar o plano: {0}", message);
		} finally {
			if (requestId !== this.summaryRequestId || this.currentStep !== ModalStep.SUMMARY) { return; }
			this.summaryLoading = false;
			this.renderStep();
		}
	}

	private confirm(): void {
		if (!this.summaryPlan || this.summaryLoading || this.summaryError) { return; }

		this.resolve?.({
			agentCount: this.normalizeAgentCount(this.preferences.agentCount),
			timeMode: this.preferences.timeMode,
			timeBudgetMinutes: this.preferences.timeMode === 'defined'
				? this.normalizeDefinedTime(this.preferences.timeBudgetMinutes)
				: undefined,
			plan: this.summaryPlan
		});
		this.dispose();
	}

	private cancel(): void {
		this.resolve?.(undefined);
		this.dispose();
	}

	override dispose(): void {
		super.dispose();
		this.summaryRequestId++;
		this.overlay?.remove();
	}

	private normalizeAgentCount(value: number): number {
		return Math.max(MIN_AGENT_COUNT, Math.min(MAX_AGENT_COUNT, value || MIN_AGENT_COUNT));
	}

	private normalizeDefinedTime(value: number | undefined): number {
		return Math.max(MIN_TIME_BUDGET_MINUTES, value || MIN_TIME_BUDGET_MINUTES);
	}

	private formatTime(minutes: number): string {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		if (h > 0) { return `${h}h ${m}min`; }
		return `${m}min`;
	}
}
