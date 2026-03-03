/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { VSBuffer } from '../../../../base/common/buffer.js';
import { match as globMatch } from '../../../../base/common/glob.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService } from '../../terminal/browser/terminal.js';
import {
	INeocodeToolCall,
	INeocodeToolDefinition,
	INeocodeToolExecutor,
	INeocodeToolResult
} from '../../neocode/qwen/common/qwenTypes.js';

// ─── Unified diff types (for apply_patch) ─────────────────────────────────────

interface IDiffHunkLine {
	type: 'context' | 'added' | 'removed';
	content: string;
}

interface IDiffHunk {
	lines: IDiffHunkLine[];
}

interface IFileDiff {
	oldPath: string;
	newPath: string;
	isNew: boolean;
	isDeleted: boolean;
	hunks: IDiffHunk[];
}

/** Max results returned by search/glob tools. */
const MAX_SEARCH_RESULTS = 100;
/** Max recursion depth for directory traversal. */
const MAX_SEARCH_DEPTH = 6;
/** Max file size to read in search (4 MB). */
const MAX_FILE_SIZE_BYTES = 4 * 1024 * 1024;
/** Directories always skipped during traversal. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.next', '.cache', '__pycache__', '.venv', 'target', 'build']);
const DEFAULT_TERMINAL_TIMEOUT_SECONDS = 30;
const MIN_TERMINAL_TIMEOUT_SECONDS = 1;
const MAX_TERMINAL_TIMEOUT_SECONDS = 300;
const MAX_TERMINAL_OUTPUT_CHARS = 120_000;

/**
 * Implements all code-editing tools available to swarm agents.
 * Each tool corresponds to a function the AI model can call.
 */
export class NeocodeSwarmToolExecutor extends Disposable implements INeocodeToolExecutor {
	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@ILogService private readonly logService: ILogService,
		@ITerminalService private readonly terminalService: ITerminalService,
	) {
		super();
	}

	// ─── INeocodeToolExecutor ────────────────────────────────────────────────

	getTools(): INeocodeToolDefinition[] {
		return [
			{
				name: 'read_file',
				description:
					'Read the contents of a file. Always call this before editing a file so you have the current content. ' +
					'Use start_line and end_line to read specific sections of large files.',
				parameters: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'File path (relative to workspace root, or absolute).'
						},
						start_line: {
							type: 'number',
							description: 'First line to return, 1-based (optional).'
						},
						end_line: {
							type: 'number',
							description: 'Last line to return, 1-based inclusive (optional).'
						}
					},
					required: ['path']
				}
			},
			{
				name: 'write_file',
				description:
					'Create a new file or completely overwrite an existing one with the given content. ' +
					'Prefer edit_file for small targeted changes.',
				parameters: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'File path (relative to workspace root, or absolute).'
						},
						content: {
							type: 'string',
							description: 'Full file content to write.'
						}
					},
					required: ['path', 'content']
				}
			},
			{
				name: 'edit_file',
				description:
					'Replace an exact substring in a file with a new string. ' +
					'The old_string must match the current file content exactly (preserving indentation and whitespace). ' +
					'Read the file first if you are unsure of the exact content. ' +
					'For multiple independent edits in the same file, call this tool multiple times.',
				parameters: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'File path (relative to workspace root, or absolute).'
						},
						old_string: {
							type: 'string',
							description: 'The exact text to replace (must occur exactly once in the file).'
						},
						new_string: {
							type: 'string',
							description: 'The replacement text.'
						}
					},
					required: ['path', 'old_string', 'new_string']
				}
			},
			{
				name: 'list_dir',
				description:
					'List files and sub-directories inside a directory. ' +
					'Use "." to list the workspace root.',
				parameters: {
					type: 'object',
					properties: {
						path: {
							type: 'string',
							description: 'Directory to list (relative to workspace root, or absolute). Use "." for root.'
						}
					},
					required: ['path']
				}
			},
			{
				name: 'search_files',
				description:
					'Search for a text pattern (literal or regex) across files in a directory. ' +
					'Returns matching file paths with line numbers and the matching line content. ' +
					'Narrow the search with a specific path and file_glob when possible.',
				parameters: {
					type: 'object',
					properties: {
						pattern: {
							type: 'string',
							description: 'Text or regular expression pattern to search for.'
						},
						path: {
							type: 'string',
							description: 'Directory to search in (default: workspace root).'
						},
						file_glob: {
							type: 'string',
							description: 'Glob pattern to restrict which files are searched (e.g. "*.ts", "**/*.json").'
						},
						case_sensitive: {
							type: 'boolean',
							description: 'Whether the search is case-sensitive (default: false).'
						}
					},
					required: ['pattern']
				}
			},
			{
				name: 'glob_files',
				description:
					'Find files whose path matches a glob pattern. ' +
					'Returns a list of matching paths relative to the workspace root.',
				parameters: {
					type: 'object',
					properties: {
						pattern: {
							type: 'string',
							description: 'Glob pattern, e.g. "src/**/*.ts" or "**/*.json".'
						},
						path: {
							type: 'string',
							description: 'Base directory to search from (default: workspace root).'
						}
					},
					required: ['pattern']
				}
				},
				{
					name: 'run_terminal',
					description:
						'Execute a shell command and return its combined stdout/stderr output. ' +
						'Use for running builds, tests, package installs, git operations, or any shell task. ' +
						'Supports optional timeout_seconds (default 30s, max 300s).',
					parameters: {
						type: 'object',
						properties: {
							command: {
								type: 'string',
								description: 'Shell command to execute.'
							},
							working_dir: {
								type: 'string',
								description: 'Working directory (relative to workspace root, or absolute). Defaults to workspace root.'
							},
							timeout_seconds: {
								type: 'number',
								description: 'Command timeout in seconds (1-300). Default: 30.'
							}
						},
						required: ['command']
					}
				},
			{
				name: 'web_fetch',
				description:
					'Fetch content from a URL and return it as plain text. ' +
					'HTML is automatically stripped of scripts, styles and tags. ' +
					'Useful for reading documentation, API specs, or any web resource.',
				parameters: {
					type: 'object',
					properties: {
						url: {
							type: 'string',
							description: 'The URL to fetch (must be http or https).'
						}
					},
					required: ['url']
				}
			},
			{
				name: 'apply_patch',
				description:
					'Apply a unified diff patch to files in the workspace. ' +
					'Use standard git unified diff format (--- a/file, +++ b/file, @@ hunks). ' +
					'Supports creating new files (/dev/null as old path) and modifying existing files.',
				parameters: {
					type: 'object',
					properties: {
						patch_content: {
							type: 'string',
							description: "Unified diff patch content (output of 'git diff' or 'diff -u')."
						}
					},
					required: ['patch_content']
				}
			}
		];
	}

	async execute(call: INeocodeToolCall): Promise<INeocodeToolResult> {
		this.logService.info(`[neocode tools] execute tool=${call.name} args=${JSON.stringify(call.arguments)}`);

		try {
			const args = call.arguments;
			let content: string;

			switch (call.name) {
				case 'read_file':
					content = await this.readFile(
						String(args['path']),
						args['start_line'] as number | undefined,
						args['end_line'] as number | undefined
					);
					break;

				case 'write_file':
					content = await this.writeFile(
						String(args['path']),
						String(args['content'])
					);
					break;

				case 'edit_file':
					content = await this.editFile(
						String(args['path']),
						String(args['old_string']),
						String(args['new_string'])
					);
					break;

				case 'list_dir':
					content = await this.listDir(String(args['path']));
					break;

				case 'search_files':
					content = await this.searchFiles(
						String(args['pattern']),
						args['path'] as string | undefined,
						args['file_glob'] as string | undefined,
						args['case_sensitive'] as boolean | undefined
					);
					break;

				case 'glob_files':
					content = await this.globFiles(
						String(args['pattern']),
						args['path'] as string | undefined
					);
					break;

					case 'run_terminal':
						content = await this.runTerminal(
							String(args['command']),
							args['working_dir'] as string | undefined,
							args['timeout_seconds'] as number | undefined
						);
						break;

				case 'web_fetch':
					content = await this.webFetch(String(args['url']));
					break;

				case 'apply_patch':
					content = await this.applyPatch(String(args['patch_content']));
					break;

				default:
					return { id: call.id, content: `Unknown tool: ${call.name}`, isError: true };
			}

			this.logService.debug(`[neocode tools] tool=${call.name} result length=${content.length}`);
			return { id: call.id, content };
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			this.logService.error(`[neocode tools] tool=${call.name} failed: ${msg}`);
			return { id: call.id, content: `Error: ${msg}`, isError: true };
		}
	}

	// ─── Tool implementations ────────────────────────────────────────────────

	private async readFile(path: string, startLine?: number, endLine?: number): Promise<string> {
		const uri = this.resolveUri(path);
		const stat = await this.fileService.stat(uri);

		if (stat.size > MAX_FILE_SIZE_BYTES) {
			throw new Error(`File too large to read (${stat.size} bytes). Use start_line / end_line to read sections.`);
		}

		const content = await this.fileService.readFile(uri);
		const text = content.value.toString();

		if (startLine !== undefined || endLine !== undefined) {
			const lines = text.split('\n');
			const start = Math.max(0, (startLine ?? 1) - 1);
			const end = Math.min(lines.length, endLine ?? lines.length);
			return lines.slice(start, end).join('\n');
		}

		return text;
	}

	private async writeFile(path: string, content: string): Promise<string> {
		const uri = this.resolveUri(path);
		await this.fileService.writeFile(uri, VSBuffer.fromString(content));
		return `Successfully wrote ${content.length} characters to ${path}`;
	}

	private async editFile(path: string, oldString: string, newString: string): Promise<string> {
		const uri = this.resolveUri(path);
		const fileContent = await this.fileService.readFile(uri);
		const text = fileContent.value.toString();

		// Strategy 1: Exact match
		let index = text.indexOf(oldString);
		if (index !== -1) {
			const count = this.countOccurrences(text, oldString);
			if (count > 1) {
				throw new Error(
					`The old_string occurs ${count} times in the file. Make it more unique by including surrounding context.`
				);
			}
			const newText = text.slice(0, index) + newString + text.slice(index + oldString.length);
			await this.fileService.writeFile(uri, VSBuffer.fromString(newText));
			return `Successfully edited ${path}: replaced ${oldString.length} chars with ${newString.length} chars`;
		}

		// Strategy 2: Normalize line endings (CRLF → LF)
		const normalizedText = text.replace(/\r\n/g, '\n');
		const normalizedOld = oldString.replace(/\r\n/g, '\n');
		index = normalizedText.indexOf(normalizedOld);
		if (index !== -1) {
			const count = this.countOccurrences(normalizedText, normalizedOld);
			if (count > 1) {
				throw new Error(
					`The old_string occurs ${count} times in the file. Make it more unique by including surrounding context.`
				);
			}
			const newText = normalizedText.slice(0, index) + newString + normalizedText.slice(index + normalizedOld.length);
			await this.fileService.writeFile(uri, VSBuffer.fromString(newText));
			return `Successfully edited ${path} (normalized line endings)`;
		}

		// Strategy 3: Normalize tabs → 4 spaces
		const tabNormalizedText = normalizedText.replace(/\t/g, '    ');
		const tabNormalizedOld = normalizedOld.replace(/\t/g, '    ');
		index = tabNormalizedText.indexOf(tabNormalizedOld);
		if (index !== -1) {
			const count = this.countOccurrences(tabNormalizedText, tabNormalizedOld);
			if (count > 1) {
				throw new Error(
					`The old_string occurs ${count} times in the file. Make it more unique by including surrounding context.`
				);
			}
			const newText = tabNormalizedText.slice(0, index) + newString + tabNormalizedText.slice(index + tabNormalizedOld.length);
			await this.fileService.writeFile(uri, VSBuffer.fromString(newText));
			return `Successfully edited ${path} (normalized whitespace)`;
		}

		throw new Error(
			`Could not find the old_string in ${path}.\n` +
			`Make sure you read the file first and copy the exact text to replace.\n` +
			`Searched for:\n${oldString}`
		);
	}

	private async listDir(path: string): Promise<string> {
		const uri = path === '.' || path === '' || path === '/'
			? this.workspaceRoot()
			: this.resolveUri(path);

		const stat = await this.fileService.resolve(uri, { resolveMetadata: false });

		if (!stat.isDirectory) {
			throw new Error(`${path} is not a directory`);
		}

		if (!stat.children || stat.children.length === 0) {
			return '(empty directory)';
		}

		const entries = stat.children
			.map(child => `${child.isDirectory ? 'd' : 'f'}  ${child.name}`)
			.sort();

		return entries.join('\n');
	}

	private async searchFiles(
		pattern: string,
		searchPath?: string,
		fileGlob?: string,
		caseSensitive?: boolean
	): Promise<string> {
		const baseUri = searchPath ? this.resolveUri(searchPath) : this.workspaceRoot();
		const flags = caseSensitive ? 'g' : 'gi';

		let regex: RegExp;
		try {
			regex = new RegExp(pattern, flags);
		} catch {
			// Treat as a literal string if not valid regex
			const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			regex = new RegExp(escaped, flags);
		}

		const results: string[] = [];
		await this.searchInDir(baseUri, regex, fileGlob, results, 0);

		if (results.length === 0) {
			return `No matches found for: ${pattern}`;
		}

		const header = results.length >= MAX_SEARCH_RESULTS
			? `(showing first ${MAX_SEARCH_RESULTS} results)\n`
			: '';
		return header + results.join('\n');
	}

	private async searchInDir(
		uri: URI,
		regex: RegExp,
		fileGlob: string | undefined,
		results: string[],
		depth: number
	): Promise<void> {
		if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) {
			return;
		}

		let stat;
		try {
			stat = await this.fileService.resolve(uri, { resolveMetadata: false });
		} catch {
			return;
		}

		if (!stat.children) {
			return;
		}

		for (const child of stat.children) {
			if (results.length >= MAX_SEARCH_RESULTS) {
				break;
			}

			if (child.isDirectory) {
				if (SKIP_DIRS.has(child.name.toLowerCase())) {
					continue;
				}
				await this.searchInDir(child.resource, regex, fileGlob, results, depth + 1);
			} else {
				if (fileGlob && !this.simpleGlobMatch(child.name, fileGlob)) {
					continue;
				}

				try {
					const fileStat = await this.fileService.stat(child.resource);
					if (fileStat.size > MAX_FILE_SIZE_BYTES) {
						continue;
					}

					const content = await this.fileService.readFile(child.resource);
					const text = content.value.toString();
					const lines = text.split('\n');

					for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
						regex.lastIndex = 0;
						if (regex.test(lines[i])) {
							results.push(`${child.resource.fsPath}:${i + 1}: ${lines[i].trimEnd()}`);
						}
					}
				} catch {
					// Skip unreadable files (binary, permission errors, etc.)
				}
			}
		}
	}

	private async globFiles(pattern: string, searchPath?: string): Promise<string> {
		const baseUri = searchPath ? this.resolveUri(searchPath) : this.workspaceRoot();
		const results: string[] = [];
		const workspaceRoot = this.workspaceRoot();

		await this.globInDir(baseUri, pattern, workspaceRoot, results, 0);

		if (results.length === 0) {
			return `No files found matching: ${pattern}`;
		}

		const header = results.length >= MAX_SEARCH_RESULTS
			? `(showing first ${MAX_SEARCH_RESULTS} results)\n`
			: '';
		return header + results.join('\n');
	}

	private async globInDir(
		uri: URI,
		pattern: string,
		workspaceRoot: URI,
		results: string[],
		depth: number
	): Promise<void> {
		if (depth > MAX_SEARCH_DEPTH || results.length >= MAX_SEARCH_RESULTS) {
			return;
		}

		let stat;
		try {
			stat = await this.fileService.resolve(uri, { resolveMetadata: false });
		} catch {
			return;
		}

		if (!stat.children) {
			return;
		}

		for (const child of stat.children) {
			if (results.length >= MAX_SEARCH_RESULTS) {
				break;
			}

			if (child.isDirectory) {
				if (SKIP_DIRS.has(child.name.toLowerCase())) {
					continue;
				}
				await this.globInDir(child.resource, pattern, workspaceRoot, results, depth + 1);
			} else {
				// Build a relative path for glob matching
				const relativePath = child.resource.path.startsWith(workspaceRoot.path)
					? child.resource.path.slice(workspaceRoot.path.length + 1)
					: child.resource.path;

				if (globMatch(pattern, relativePath) || globMatch(pattern, child.name)) {
					results.push(relativePath);
				}
			}
		}
	}

	// ─── run_terminal ───────────────────────────────────────────────────────────

	private async runTerminal(command: string, workingDir?: string, timeoutSeconds?: number): Promise<string> {
		const trimmedCommand = command.trim();
		if (!trimmedCommand) {
			return 'Error: command cannot be empty.';
		}

		const normalizedTimeoutSeconds = this.normalizeTerminalTimeoutSeconds(timeoutSeconds);
		const timeoutMs = normalizedTimeoutSeconds * 1000;
		const cwd = workingDir
			? (workingDir.startsWith('/') || /^[A-Za-z]:[/\\]/.test(workingDir)
				? workingDir
				: URI.joinPath(this.workspaceRoot(), workingDir).fsPath)
			: this.workspaceRoot().fsPath;

		try {
			type ExecError = { code?: number; killed?: boolean; signal?: string; message: string };
			type ExecCallback = (err: ExecError | null, stdout: string, stderr: string) => void;
			type ExecFn = (cmd: string, opts: { cwd?: string; maxBuffer?: number; timeout?: number }, cb: ExecCallback) => void;
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const cp = require('child_process') as { exec: ExecFn };
			return await new Promise<string>(resolve => {
				const startedAt = Date.now();
				cp.exec(trimmedCommand, { cwd, maxBuffer: 10 * 1024 * 1024, timeout: timeoutMs }, (error, stdout, stderr) => {
					const durationMs = Date.now() - startedAt;
					const timedOut = !!(error && error.killed && error.signal);
					const formatted = this.formatTerminalOutput({
						command: trimmedCommand,
						cwd,
						timeoutSeconds: normalizedTimeoutSeconds,
						durationMs,
						exitCode: error?.code,
						stdout,
						stderr,
						timedOut,
						errorMessage: error?.message,
					});
					resolve(formatted);
				});
			});
		} catch {
			// Web/sandboxed mode: use integrated terminal with file output redirection
			return this.runViaTerminal(trimmedCommand, cwd, normalizedTimeoutSeconds);
		}
	}

	private async runViaTerminal(command: string, cwd: string, timeoutSeconds: number): Promise<string> {
		const outFile = `/tmp/neo-cmd-${Date.now()}.txt`;
		const timeoutMs = timeoutSeconds * 1000;
		try {
			const existingTerminal = this.terminalService.instances.find(t => t.title === 'NeoCode Agent');
			const terminal = existingTerminal ?? await this.terminalService.createTerminal({
				config: { name: 'NeoCode Agent' },
				cwd: URI.file(cwd),
			});
			const startedAt = Date.now();
			await terminal.sendText(`(cd "${cwd}" && ${command}) > "${outFile}" 2>&1; echo "NEOEXIT:$?" >> "${outFile}"`, true);

			const start = Date.now();
			while (Date.now() - start < timeoutMs) {
				await new Promise<void>(resolve => setTimeout(resolve, 500));
				try {
					const buf = await this.fileService.readFile(URI.file(outFile));
					const text = buf.value.toString();
					if (text.includes('NEOEXIT:')) {
						const exitMatch = text.match(/NEOEXIT:(\d+)/);
						const exitCode = exitMatch ? parseInt(exitMatch[1]) : 0;
						const output = text.replace(/NEOEXIT:\d+\n?$/, '').trimEnd();
						return this.formatTerminalOutput({
							command,
							cwd,
							timeoutSeconds,
							durationMs: Date.now() - startedAt,
							exitCode,
							stdout: output,
							stderr: '',
							timedOut: false,
						});
					}
				} catch { /* file not yet written */ }
			}
		} catch { /* terminal creation failed */ }
		return this.formatTerminalOutput({
			command,
			cwd,
			timeoutSeconds,
			durationMs: timeoutMs,
			exitCode: 124,
			stdout: '',
			stderr: '',
			timedOut: true,
			errorMessage: `Command timed out after ${timeoutSeconds} seconds. Check the "NeoCode Agent" terminal for status.`,
		});
	}

	private normalizeTerminalTimeoutSeconds(timeoutSeconds: number | undefined): number {
		if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds)) {
			return DEFAULT_TERMINAL_TIMEOUT_SECONDS;
		}
		const rounded = Math.floor(timeoutSeconds);
		return Math.max(MIN_TERMINAL_TIMEOUT_SECONDS, Math.min(MAX_TERMINAL_TIMEOUT_SECONDS, rounded));
	}

	private truncateTerminalOutput(value: string): string {
		if (value.length <= MAX_TERMINAL_OUTPUT_CHARS) {
			return value;
		}
		return `${value.slice(0, MAX_TERMINAL_OUTPUT_CHARS)}\n...[output truncated]`;
	}

	private formatTerminalOutput(payload: {
		command: string;
		cwd: string;
		timeoutSeconds: number;
		durationMs: number;
		exitCode?: number;
		stdout: string;
		stderr: string;
		timedOut: boolean;
		errorMessage?: string;
	}): string {
		const stdout = this.truncateTerminalOutput(payload.stdout.trimEnd());
		const stderr = this.truncateTerminalOutput(payload.stderr.trimEnd());
		const header = [
			`Command: ${payload.command}`,
			`CWD: ${payload.cwd}`,
			`Timeout: ${payload.timeoutSeconds}s`,
			`Duration: ${(payload.durationMs / 1000).toFixed(2)}s`,
			`Exit Code: ${payload.exitCode ?? (payload.timedOut ? 124 : 0)}`,
			payload.timedOut ? 'Timed Out: yes' : 'Timed Out: no',
		].join('\n');

		const sections: string[] = [header];
		if (stdout) {
			sections.push(`STDOUT:\n${stdout}`);
		}
		if (stderr) {
			sections.push(`STDERR:\n${stderr}`);
		}
		if (!stdout && !stderr) {
			sections.push('Output: (no output)');
		}
		if (payload.errorMessage && payload.errorMessage.trim().length > 0) {
			sections.push(`Error: ${payload.errorMessage.trim()}`);
		}
		return sections.join('\n\n');
	}

	// ─── web_fetch ───────────────────────────────────────────────────────────────

	private async webFetch(url: string): Promise<string> {
		const MAX_CONTENT = 50000;
		try {
			const response = await fetch(url, { headers: { 'User-Agent': 'NeoCode-Agent/1.0' } });
			if (!response.ok) {
				return `HTTP ${response.status}: ${response.statusText}`;
			}
			const contentType = response.headers.get('content-type') ?? '';
			let text = await response.text();
			if (contentType.includes('text/html')) {
				text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
				text = text.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
				text = text.replace(/<[^>]+>/g, ' ');
				text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
			}
			if (text.length > MAX_CONTENT) {
				text = text.slice(0, MAX_CONTENT) + `\n...(truncated, total ${text.length} chars)`;
			}
			return text;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return `Failed to fetch ${url}: ${msg}`;
		}
	}

	// ─── apply_patch ─────────────────────────────────────────────────────────────

	private async applyPatch(patchContent: string): Promise<string> {
		const diffs = this.parseUnifiedDiff(patchContent);
		if (diffs.length === 0) {
			return 'No file diffs found in patch content.';
		}
		const results: string[] = [];
		for (const diff of diffs) {
			try {
				if (diff.isDeleted) {
					const uri = this.resolveUri(diff.oldPath);
					await this.fileService.del(uri);
					results.push(`Deleted: ${diff.oldPath}`);
				} else if (diff.isNew) {
					const uri = this.resolveUri(diff.newPath);
					const lines = diff.hunks
						.flatMap(h => h.lines.filter(l => l.type !== 'removed').map(l => l.content));
					await this.fileService.writeFile(uri, VSBuffer.fromString(lines.join('\n')));
					results.push(`Created: ${diff.newPath}`);
				} else {
					const uri = this.resolveUri(diff.oldPath);
					const fileContent = await this.fileService.readFile(uri);
					const newText = this.applyHunks(fileContent.value.toString(), diff.hunks);
					await this.fileService.writeFile(uri, VSBuffer.fromString(newText));
					results.push(`Patched: ${diff.oldPath}`);
				}
			} catch (error) {
				const msg = error instanceof Error ? error.message : String(error);
				results.push(`Failed (${diff.oldPath || diff.newPath}): ${msg}`);
			}
		}
		return results.join('\n');
	}

	private parseUnifiedDiff(patch: string): IFileDiff[] {
		const diffs: IFileDiff[] = [];
		const lines = patch.split('\n');
		let i = 0;

		while (i < lines.length) {
			// Skip until we find a --- header
			if (!lines[i].startsWith('--- ')) {
				i++;
				continue;
			}
			const oldPathRaw = lines[i].slice(4).split('\t')[0].trim();
			const oldPath = oldPathRaw.startsWith('a/') ? oldPathRaw.slice(2) : oldPathRaw;
			i++;

			if (i >= lines.length || !lines[i].startsWith('+++ ')) {
				continue;
			}
			const newPathRaw = lines[i].slice(4).split('\t')[0].trim();
			const newPath = newPathRaw.startsWith('b/') ? newPathRaw.slice(2) : newPathRaw;
			i++;

			const isNew = oldPathRaw === '/dev/null';
			const isDeleted = newPathRaw === '/dev/null';
			const hunks: IDiffHunk[] = [];

			while (i < lines.length && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) {
				if (!lines[i].startsWith('@@')) {
					i++;
					continue;
				}
				i++; // skip @@ header
				const hunkLines: IDiffHunkLine[] = [];
				while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ') && !lines[i].startsWith('diff --git ')) {
					const line = lines[i];
					if (line.startsWith('+')) {
						hunkLines.push({ type: 'added', content: line.slice(1) });
					} else if (line.startsWith('-')) {
						hunkLines.push({ type: 'removed', content: line.slice(1) });
					} else {
						hunkLines.push({ type: 'context', content: line.startsWith(' ') ? line.slice(1) : line });
					}
					i++;
				}
				hunks.push({ lines: hunkLines });
			}

			diffs.push({ oldPath, newPath, isNew, isDeleted, hunks });
		}
		return diffs;
	}

	private applyHunks(text: string, hunks: IDiffHunk[]): string {
		const resultLines = text.split('\n');

		for (const hunk of hunks) {
			// Build the old sequence (context + removed lines)
			const oldChunk = hunk.lines.filter(l => l.type !== 'added').map(l => l.content);
			// Build the new sequence (context + added lines)
			const newChunk = hunk.lines.filter(l => l.type !== 'removed').map(l => l.content);

			if (oldChunk.length === 0) {
				// Pure insertion - append to end
				resultLines.push(...newChunk);
				continue;
			}

			// Find where oldChunk appears in the current resultLines
			let foundAt = -1;
			for (let i = 0; i <= resultLines.length - oldChunk.length; i++) {
				let match = true;
				for (let j = 0; j < oldChunk.length; j++) {
					if (resultLines[i + j] !== oldChunk[j]) {
						match = false;
						break;
					}
				}
				if (match) {
					foundAt = i;
					break;
				}
			}

			if (foundAt === -1) {
				throw new Error(
					`Could not find hunk context in file. Looked for:\n${oldChunk.slice(0, 3).join('\n')}`
				);
			}

			resultLines.splice(foundAt, oldChunk.length, ...newChunk);
		}

		return resultLines.join('\n');
	}

	// ─── Utilities ───────────────────────────────────────────────────────────

	private resolveUri(path: string): URI {
		// Absolute path
		if (path.startsWith('/') || /^[A-Za-z]:[/\\]/.test(path)) {
			return URI.file(path);
		}
		// Relative: resolve from workspace root
		return URI.joinPath(this.workspaceRoot(), path);
	}

	private workspaceRoot(): URI {
		const folders = this.workspaceService.getWorkspace().folders;
		if (folders.length > 0) {
			return folders[0].uri;
		}
		return URI.file('/');
	}

	private countOccurrences(text: string, substring: string): number {
		let count = 0;
		let index = 0;
		while ((index = text.indexOf(substring, index)) !== -1) {
			count++;
			index += substring.length;
		}
		return count;
	}

	/**
	 * Simple glob matching for a single filename component (not full path).
	 * Supports * and ? wildcards.
	 */
	private simpleGlobMatch(filename: string, glob: string): boolean {
		// If the glob contains path separators, try matching full path
		if (glob.includes('/')) {
			return globMatch(glob, filename);
		}
		// Extract the last segment of the glob pattern (e.g. "*.ts" from "**/*.ts")
		const parts = glob.split('/');
		const lastPart = parts[parts.length - 1];
		const regexStr = lastPart
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*/g, '.*')
			.replace(/\?/g, '.');
		try {
			return new RegExp(`^${regexStr}$`, 'i').test(filename);
		} catch {
			return false;
		}
	}
}

/**
 * Build the system prompt used when tools are active.
 * Includes the workspace root so the model knows where it's working.
 */
export function buildCodeEditingSystemPrompt(workspaceRootPath: string): string {
	return `You are an expert code editing assistant working in the workspace at: ${workspaceRootPath}

You have access to file system tools to read, write and edit code:

- **read_file**: Always read a file before editing it so you have the exact current content.
- **write_file**: Create new files or fully replace existing ones.
- **edit_file**: Replace an exact substring in a file. Preferred for targeted changes.
- **list_dir**: Explore the project structure. Start with "." for the root.
- **search_files**: Search for patterns across the codebase (like grep).
- **glob_files**: Find files by glob pattern (e.g. "src/**/*.ts").
- **run_terminal**: Execute shell commands (build, test, install, git, etc.).
- **web_fetch**: Fetch documentation or any URL as plain text.
- **apply_patch**: Apply a unified diff patch to one or more files.

Guidelines:
1. Read files before editing — never guess file content.
2. Use edit_file for small targeted changes; use write_file only for new files or full rewrites.
3. For each edit, the old_string must match EXACTLY (including indentation). Copy it directly from read_file output.
4. When unsure about project structure, use list_dir and glob_files to explore.
5. Use run_terminal to verify changes (compile, lint, test) after editing.
6. After completing all edits, summarize what you changed and why.
7. If an edit fails because the old_string isn't found, re-read the file and try again with the correct text.`;
}
