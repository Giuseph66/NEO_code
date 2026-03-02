/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import {
	ISwarmExecutionPlan,
	ISwarmAgentState,
	ISwarmActivitySession,
} from '../common/neocodeSwarmTypes.js';
import { IAgentProgressUpdate } from './neocodeSwarmAgentRunner.js';

export const INeocodeSwarmActivityService = createDecorator<INeocodeSwarmActivityService>('neocodeSwarmActivityService');

export interface INeocodeSwarmActivityService {
	readonly _serviceBrand: undefined;

	/** Fired whenever any session state changes. */
	readonly onDidChange: Event<ISwarmActivitySession>;
	/** Fired when a new session with agents starts (triggers panel auto-open). */
	readonly onDidStartSession: Event<ISwarmActivitySession>;

	startSession(sessionId: string, plan: ISwarmExecutionPlan): void;
	updateAgent(sessionId: string, update: IAgentProgressUpdate): void;
	setOrchestratorStatus(sessionId: string, status: string): void;
	completeSession(sessionId: string): void;
	getCurrentSession(): ISwarmActivitySession | undefined;
}

export class NeocodeSwarmActivityService extends Disposable implements INeocodeSwarmActivityService {
	readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<ISwarmActivitySession>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidStartSession = this._register(new Emitter<ISwarmActivitySession>());
	readonly onDidStartSession = this._onDidStartSession.event;

	private _currentSession: ISwarmActivitySession | undefined;

	constructor() {
		super();
	}

	startSession(sessionId: string, plan: ISwarmExecutionPlan): void {
		const agentStates = new Map<string, ISwarmAgentState>();
		for (const agentPlan of plan.agents) {
			agentStates.set(agentPlan.id, {
				plan: agentPlan,
				status: 'pending',
				logs: [],
			});
		}

		this._currentSession = {
			sessionId,
			plan,
			agentStates,
			orchestratorStatus: '🚀 Despachando agentes...',
			startTime: Date.now(),
			complete: false,
		};

		this._onDidChange.fire(this._currentSession);
		this._onDidStartSession.fire(this._currentSession);
	}

	updateAgent(sessionId: string, update: IAgentProgressUpdate): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }

		const state = this._currentSession.agentStates.get(update.agentId);
		if (!state) { return; }

		state.status = update.status;
		if (update.log) {
			state.logs.push(update.log);
			// Keep only the last 50 log entries per agent to avoid memory growth
			if (state.logs.length > 50) {
				state.logs.splice(0, state.logs.length - 50);
			}
		}

		if (update.status === 'done') {
			const content = state.logs
				.filter(l => l.type === 'message')
				.map(l => l.content)
				.join('\n');
			state.result = content;
		} else if (update.status === 'error') {
			const errorLog = state.logs.find(l => l.type === 'error');
			state.error = errorLog?.content;
		}

		this._onDidChange.fire(this._currentSession);
	}

	setOrchestratorStatus(sessionId: string, status: string): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		this._currentSession.orchestratorStatus = status;
		this._onDidChange.fire(this._currentSession);
	}

	completeSession(sessionId: string): void {
		if (this._currentSession?.sessionId !== sessionId) { return; }
		this._currentSession.complete = true;
		this._currentSession.endTime = Date.now();
		this._onDidChange.fire(this._currentSession);
	}

	getCurrentSession(): ISwarmActivitySession | undefined {
		return this._currentSession;
	}
}
