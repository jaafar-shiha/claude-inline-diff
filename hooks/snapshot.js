#!/usr/bin/env node
// Claude Code PreToolUse hook: saves a copy of a file right before Claude edits it,
// so the Claude Inline Diff extension can show what changed.
//
// The extension installs this script once, as ~/.claude/hooks/claude-inline-diff-snapshot.js, and
// registers it in ~/.claude/settings.json, so it runs for every Claude Code session
// (VS Code, terminal, desktop app) whatever folder that session started in.
// Only projects set up in VS Code (they have a .claude/inline-diff folder) are tracked.
//
// It must never block Claude, so it always exits with code 0.

const fs = require('fs');
const path = require('path');

// The nearest folder above the file that has .claude/inline-diff, or undefined.
function findProjectRoot(file) {
	let dir = path.dirname(file);
	for (;;) {
		if (fs.existsSync(path.join(dir, '.claude', 'inline-diff'))) {
			return dir;
		}
		const parent = path.dirname(dir);
		if (parent === dir) {
			return undefined;
		}
		dir = parent;
	}
}

function readManifest(manifestPath) {
	try {
		return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	} catch {
		return {};
	}
}

function writeManifest(manifestPath, manifest) {
	const tmp = `${manifestPath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
	fs.renameSync(tmp, manifestPath);
}

function snapshot(file) {
	const projectRoot = findProjectRoot(file);
	if (!projectRoot) {
		return; // not a project set up for review
	}
	const stateDir = path.join(projectRoot, '.claude', 'inline-diff');
	if (file.startsWith(stateDir + path.sep)) {
		return; // our own state files
	}

	const relative = path.relative(projectRoot, file);
	const key = relative.split(path.sep).join('/');
	const manifestPath = path.join(stateDir, 'manifest.json');
	const manifest = readManifest(manifestPath);
	if (!manifest[key]) {
		// Only the first time: keep the copy from before Claude's first edit.
		const existed = fs.existsSync(file);
		if (existed) {
			// The .snapshot suffix keeps tools (Gradle, Dart analyzer, ...) from treating the copy as source.
			const target = path.join(stateDir, 'snapshots', `${relative}.snapshot`);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(file, target);
		}
		manifest[key] = { existed, time: Date.now() };
		writeManifest(manifestPath, manifest);
	}
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
	try {
		const event = JSON.parse(input);
		const filePath = event.tool_input && event.tool_input.file_path;
		if (typeof filePath === 'string' && filePath) {
			snapshot(path.resolve(event.cwd || process.cwd(), filePath));
		}
	} catch (err) {
		process.stderr.write(`claude-inline-diff snapshot failed: ${err}\n`);
	}
	process.exit(0);
});
