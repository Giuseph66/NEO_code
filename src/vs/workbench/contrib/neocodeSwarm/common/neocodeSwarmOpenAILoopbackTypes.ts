/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const NEO_SWARM_OPENAI_LOOPBACK_CHANNEL = 'neocodeSwarmOpenAILoopback';

export interface IOpenAILoopbackStartOptions {
	host: string;
	port: number;
	path: string;
	expectedState: string;
	timeoutMs: number;
}

export interface IOpenAILoopbackResult {
	kind: 'success' | 'error' | 'timeout';
	query?: string;
	error?: string;
}

export interface IOpenAILoopbackCallbackServerService {
	start(options: IOpenAILoopbackStartOptions): Promise<void>;
	waitForResult(): Promise<IOpenAILoopbackResult>;
	stop(): Promise<void>;
}
