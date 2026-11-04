import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// On-disk state shared with hooks/snapshot.js, under <project>/.claude/inline-diff:
//   manifest.json           { "<relative path>": { existed, time } } for every file Claude touched
//   snapshots/<rel path>.snapshot   the file as it was before Claude's first edit
//                           (the suffix keeps Gradle, the Dart analyzer etc. from treating it as source)
//   history.json            { "<relative path>": { accepted, rejected, time } }: how each file's
//                           last review went, counted in changes; the hook's end-of-reply summary reads it
// The folder itself marks the project as set up for review.
//
// The hook script is installed once for the user, so it runs for every Claude Code session
// (VS Code, terminal, desktop app), whatever folder the session started in.

const HOOK_FILE = 'claude-inline-diff-snapshot.js';
// Older versions installed the hook per project, in .claude/settings.local.json.
const LEGACY_HOOK_MARKER = 'inline-diff/snapshot.js';

export interface Entry {
	root: string;
	key: string;
	absPath: string;
	existed: boolean;
}

interface Outcome {
	accepted: number;
	rejected: number;
	time: number;
}

interface ManifestRecord {
	existed: boolean;
	time: number;
}

export function stateDir(root: string): string {
	return path.join(root, '.claude', 'inline-diff');
}

function manifestPath(root: string): string {
	return path.join(stateDir(root), 'manifest.json');
}

function snapshotsDir(root: string): string {
	return path.join(stateDir(root), 'snapshots');
}

function snapshotPath(entry: Entry): string {
	return path.join(snapshotsDir(entry.root), ...entry.key.split('/')) + '.snapshot';
}

function legacySnapshotPath(entry: Entry): string {
	return path.join(snapshotsDir(entry.root), ...entry.key.split('/'));
}

function historyPath(root: string): string {
	return path.join(stateDir(root), 'history.json');
}

function readState<T>(file: string): Record<string, T> {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

function writeState(file: string, value: unknown): void {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, file);
}

function readManifest(root: string): Record<string, ManifestRecord> {
	return readState(manifestPath(root));
}

function writeManifest(root: string, manifest: Record<string, ManifestRecord>): void {
	writeState(manifestPath(root), manifest);
}

// Counts accepted and rejected changes, for the summary at the end of each Claude reply.
export function recordOutcome(entry: Entry, accepted: number, rejected: number): void {
	if (accepted + rejected === 0) {
		return;
	}
	const file = historyPath(entry.root);
	const history = readState<Outcome>(file);
	const last = history[entry.key];
	history[entry.key] = {
		accepted: (last?.accepted ?? 0) + accepted,
		rejected: (last?.rejected ?? 0) + rejected,
		time: Date.now(),
	};
	writeState(file, history);
}

export function readEntries(root: string): Entry[] {
	const manifest = readManifest(root);
	return Object.entries(manifest).map(([key, record]) => ({
		root,
		key,
		absPath: path.join(root, ...key.split('/')),
		existed: record.existed,
	}));
}

// The file before Claude's first edit, or undefined if its copy is missing: then there's
// nothing reliable to compare with, and showing the whole file as added would be wrong.
export function readBase(entry: Entry): string | undefined {
	if (!entry.existed) {
		return '';
	}
	// Older versions saved the copy without the .snapshot suffix.
	for (const file of [snapshotPath(entry), legacySnapshotPath(entry)]) {
		try {
			return fs.readFileSync(file, 'utf8');
		} catch {
			// try the next name
		}
	}
	return undefined;
}

// Replaces the "before" copy, e.g. after the user accepts part of Claude's change.
export function writeBase(entry: Entry, text: string): void {
	const file = snapshotPath(entry);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
	if (!entry.existed) {
		const manifest = readManifest(entry.root);
		manifest[entry.key] = { existed: true, time: manifest[entry.key]?.time ?? Date.now() };
		writeManifest(entry.root, manifest);
		entry.existed = true;
	}
}

// Ends the review of a file: forgets its "before" copy.
export function removeEntry(entry: Entry): void {
	const manifest = readManifest(entry.root);
	delete manifest[entry.key];
	writeManifest(entry.root, manifest);
	fs.rmSync(snapshotPath(entry), { force: true });
	fs.rmSync(legacySnapshotPath(entry), { force: true });
}

// ---- setup ----

// Claude Code's config folder: ~/.claude, or wherever CLAUDE_CONFIG_DIR points.
function claudeDir(): string {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function globalScriptPath(): string {
	return path.join(claudeDir(), 'hooks', HOOK_FILE);
}

function readJson(file: string): any {
	if (!fs.existsSync(file)) {
		return {};
	}
	const text = fs.readFileSync(file, 'utf8');
	try {
		return text.trim() ? JSON.parse(text) : {};
	} catch {
		throw new Error(`${file} is not valid JSON. Fix it and run the setup again.`);
	}
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
}

export function isProjectSetUp(root: string): boolean {
	return fs.existsSync(stateDir(root));
}

function isGlobalHookInstalled(): boolean {
	try {
		return fs.readFileSync(path.join(claudeDir(), 'settings.json'), 'utf8').includes(HOOK_FILE);
	} catch {
		return false;
	}
}

// Copies the hook script to ~/.claude/hooks, so updates to the extension reach it.
export function copyHookScript(bundledScript: string): void {
	if (isGlobalHookInstalled()) {
		fs.mkdirSync(path.dirname(globalScriptPath()), { recursive: true });
		fs.copyFileSync(bundledScript, globalScriptPath());
	}
}

// Registers the hook in ~/.claude/settings.json, once for all projects: before Claude's file edits
// (snapshots) and when Claude finishes a reply (the summary of edited files).
function installGlobalHook(bundledScript: string): void {
	fs.mkdirSync(path.dirname(globalScriptPath()), { recursive: true });
	fs.copyFileSync(bundledScript, globalScriptPath());

	const file = path.join(claudeDir(), 'settings.json');
	const settings = readJson(file);
	settings.hooks ??= {};
	const command = { type: 'command', command: `node ${JSON.stringify(globalScriptPath())}` };
	let changed = false;
	for (const [event, group] of [
		['PreToolUse', { matcher: 'Edit|Write|MultiEdit', hooks: [command] }],
		['Stop', { hooks: [command] }],
	] as const) {
		settings.hooks[event] ??= [];
		if (!JSON.stringify(settings.hooks[event]).includes(HOOK_FILE)) {
			settings.hooks[event].push(group);
			changed = true;
		}
	}
	if (changed) {
		writeJson(file, settings);
	}
}

// Removes the per-project hook older versions added, so edits aren't snapshotted twice.
function removeLegacyProjectHook(root: string): void {
	fs.rmSync(path.join(stateDir(root), 'snapshot.js'), { force: true });
	const file = path.join(root, '.claude', 'settings.local.json');
	if (!fs.existsSync(file)) {
		return;
	}
	const settings = readJson(file);
	const groups: any[] = settings.hooks?.PreToolUse ?? [];
	const kept = groups.filter(g => !JSON.stringify(g).includes(LEGACY_HOOK_MARKER));
	if (kept.length === groups.length) {
		return;
	}
	if (kept.length > 0) {
		settings.hooks.PreToolUse = kept;
	} else {
		delete settings.hooks.PreToolUse;
		if (Object.keys(settings.hooks).length === 0) {
			delete settings.hooks;
		}
	}
	writeJson(file, settings);
}

// Older versions saved copies under their real names, so tools picked them up (Gradle even
// built in there). Renames the copies still under review and deletes everything else.
function migrateSnapshots(root: string): void {
	const dir = snapshotsDir(root);
	if (!fs.existsSync(dir)) {
		return;
	}
	for (const entry of readEntries(root)) {
		const legacy = legacySnapshotPath(entry);
		if (fs.existsSync(legacy) && fs.statSync(legacy).isFile() && !fs.existsSync(snapshotPath(entry))) {
			fs.renameSync(legacy, snapshotPath(entry));
		}
	}
	const prune = (folder: string): void => {
		for (const item of fs.readdirSync(folder, { withFileTypes: true })) {
			const full = path.join(folder, item.name);
			if (item.isDirectory()) {
				prune(full);
				if (fs.readdirSync(full).length === 0) {
					fs.rmdirSync(full);
				}
			} else if (!item.name.endsWith('.snapshot')) {
				fs.rmSync(full, { force: true });
			}
		}
	};
	prune(dir);
}

// Makes a project track Claude's edits, from any Claude Code session.
export function setUpProject(root: string, bundledScript: string): void {
	installGlobalHook(bundledScript);
	fs.mkdirSync(stateDir(root), { recursive: true });
	// Keep snapshots out of git.
	fs.writeFileSync(path.join(stateDir(root), '.gitignore'), '*\n');
	removeLegacyProjectHook(root);
	migrateSnapshots(root);
}
