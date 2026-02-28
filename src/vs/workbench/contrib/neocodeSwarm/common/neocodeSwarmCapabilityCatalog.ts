/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import rawCommands from './capabilities/commands.js';
import rawHooks from './capabilities/hooks.js';
import rawPersonalities from './capabilities/personalities.js';
import rawSkills from './capabilities/skills.js';

type CapabilitySkillType = 'terminal' | 'filesystem' | 'search' | 'codebase' | 'custom';

export interface INeocodeSwarmPersonalitySeed {
	name: string;
	summary: string;
	sourcePath: string;
}

export interface INeocodeSwarmSkillSeed {
	name: string;
	type: CapabilitySkillType;
	description: string;
	instructionPath: string;
}

export interface INeocodeSwarmHookSeed {
	name: string;
	description: string;
	scriptPath: string;
}

export interface INeocodeSwarmCommandSeed {
	name: string;
	description: string;
	executablePath: string;
}

export const DEFAULT_PERSONALITY_SEEDS: readonly INeocodeSwarmPersonalitySeed[] = rawPersonalities as readonly INeocodeSwarmPersonalitySeed[];
export const DEFAULT_SKILL_SEEDS: readonly INeocodeSwarmSkillSeed[] = rawSkills as readonly INeocodeSwarmSkillSeed[];
export const DEFAULT_HOOK_SEEDS: readonly INeocodeSwarmHookSeed[] = rawHooks as readonly INeocodeSwarmHookSeed[];
export const DEFAULT_COMMAND_SEEDS: readonly INeocodeSwarmCommandSeed[] = rawCommands as readonly INeocodeSwarmCommandSeed[];
