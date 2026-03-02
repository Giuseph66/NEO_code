/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const NEO_SWARM_CLI_EXEC_CHANNEL = 'neocodeSwarmCliExec';

export interface INeocodeSwarmCliExecOptions {
	command: string;
	args: string[];
	cwd?: string;
	timeoutMs?: number;
	stdin?: string;
	/** Extra environment variables to inject into the subprocess. Merged on top of the enriched process env. */
	env?: Record<string, string>;
}

export interface INeocodeSwarmCliExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
	timedOut: boolean;
}

export interface INeocodeSwarmCliExecService {
	exec(options: INeocodeSwarmCliExecOptions): Promise<INeocodeSwarmCliExecResult>;
}
