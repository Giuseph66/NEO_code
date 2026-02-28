export default [
	{ name: 'claude-explanatory-output-style', description: 'Adds educational explanation instructions on session start.', scriptPath: 'models/claude-code/plugins/explanatory-output-style/hooks/hooks.json' },
	{ name: 'claude-hookify', description: 'User-defined behavior guardrails via Hookify rules.', scriptPath: 'models/claude-code/plugins/hookify/hooks/hooks.json' },
	{ name: 'claude-learning-output-style', description: 'Learning mode response style at session start.', scriptPath: 'models/claude-code/plugins/learning-output-style/hooks/hooks.json' },
	{ name: 'claude-ralph-wiggum', description: 'Ralph loop stop hook to avoid infinite loops.', scriptPath: 'models/claude-code/plugins/ralph-wiggum/hooks/hooks.json' },
	{ name: 'claude-security-guidance', description: 'Security reminder before risky file edit/write tool usage.', scriptPath: 'models/claude-code/plugins/security-guidance/hooks/hooks.json' },
	{ name: 'gemini-example-session-start', description: 'Example extension hook executed at session start.', scriptPath: 'models/gemini-cli/packages/cli/src/commands/extensions/examples/hooks/hooks/hooks.json' }
] as const;
