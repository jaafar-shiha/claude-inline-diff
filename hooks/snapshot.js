#!/usr/bin/env node
// Claude Code hook for the Claude Inline Diff extension. It handles two events:
//
//   PreToolUse (Edit|Write|MultiEdit)  saves a copy of a file right before Claude's first edit to it,
//                                      so the extension can show what changed, and remembers which
//                                      files this chat (session) edited.
//   Stop                               when Claude finishes a reply, lists the files this chat edited
//                                      with their review status (accepted, rejected, still pending).
//
// The extension installs this script once, as ~/.claude/hooks/claude-inline-diff-snapshot.js, and
// registers it in ~/.claude/settings.json, so it runs for every Claude Code session
// (VS Code, terminal, desktop app) whatever folder that session started in.
// Only projects set up in VS Code (they have a .claude/inline-diff folder) are tracked.
//
// It must never block Claude, so it always exits with code 0.

const fs = require('fs');
const os = require('os');
const path = require('path');

// Chats older than this are forgotten.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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

function readJson(file) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch {
		return {};
	}
}

function writeJson(file, value) {
	const tmp = `${file}.${process.pid}.tmp`;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
	fs.renameSync(tmp, file);
}

function readText(file) {
	try {
		return fs.readFileSync(file, 'utf8');
	} catch {
		return undefined;
	}
}

// Where a file under review is kept track of, or undefined if its project isn't set up.
function locate(file) {
	const projectRoot = findProjectRoot(file);
	if (!projectRoot) {
		return undefined;
	}
	const stateDir = path.join(projectRoot, '.claude', 'inline-diff');
	if (file.startsWith(stateDir + path.sep)) {
		return undefined; // our own state files
	}
	const relative = path.relative(projectRoot, file);
	return {
		relative,
		key: relative.split(path.sep).join('/'),
		stateDir,
		manifestPath: path.join(stateDir, 'manifest.json'),
		historyPath: path.join(stateDir, 'history.json'),
	};
}

function sessionPath(sessionId) {
	// Claude Code's config folder: ~/.claude, or wherever CLAUDE_CONFIG_DIR points.
	const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
	return path.join(claudeDir, 'inline-diff', 'sessions', `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

// ---- PreToolUse ----

function snapshot(file, sessionId) {
	const at = locate(file);
	if (!at) {
		return; // not a project set up for review
	}
	const manifest = readJson(at.manifestPath);
	if (!manifest[at.key]) {
		// Only the first time: keep the copy from before Claude's first edit.
		const existed = fs.existsSync(file);
		if (existed) {
			// The .snapshot suffix keeps tools (Gradle, Dart analyzer, ...) from treating the copy as source.
			const target = path.join(at.stateDir, 'snapshots', `${at.relative}.snapshot`);
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(file, target);
		}
		manifest[at.key] = { existed, time: Date.now() };
		writeJson(at.manifestPath, manifest);

		// A new review starts: forget how the last one ended.
		const history = readJson(at.historyPath);
		if (history[at.key]) {
			delete history[at.key];
			writeJson(at.historyPath, history);
		}
	}

	if (sessionId) {
		const sessionFile = sessionPath(sessionId);
		const session = readJson(sessionFile);
		session.files = { ...session.files, [file]: Date.now() };
		writeJson(sessionFile, session);
	}
}

// ---- Stop ----

// The review status of a file this chat edited, or undefined when there's nothing to report.
function status(file) {
	const at = locate(file);
	if (!at) {
		return undefined;
	}
	const record = readJson(at.manifestPath)[at.key];
	if (record) {
		const snapshotFile = path.join(at.stateDir, 'snapshots', at.relative);
		const before = record.existed ? readText(`${snapshotFile}.snapshot`) ?? readText(snapshotFile) : undefined;
		if (before !== undefined && before === readText(file)) {
			return undefined; // Claude's edits cancel out
		}
		return { key: at.key, icon: '⏳', text: 'waiting for review' };
	}
	const outcome = readJson(at.historyPath)[at.key];
	if (!outcome) {
		return undefined;
	}
	const { accepted = 0, rejected = 0 } = outcome;
	if (rejected === 0) {
		return { key: at.key, icon: '✅', text: 'accepted' };
	}
	if (accepted === 0) {
		return { key: at.key, icon: '❌', text: 'rejected' };
	}
	return { key: at.key, icon: '✅❌', text: `partly accepted: ${accepted} kept, ${rejected} undone` };
}

function plural(n, word) {
	return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function summary(sessionId) {
	const sessionFile = sessionPath(sessionId);
	const session = readJson(sessionFile);
	const edits = Object.entries(session.files ?? {});
	const rows = edits.map(([file]) => status(file)).filter(Boolean);
	const pending = rows.filter(r => r.icon === '⏳').length;
	const editedSinceLast = edits.some(([, time]) => time > (session.lastSummary ?? 0));
	// Stay quiet after replies that edited nothing and left nothing to review.
	if (rows.length === 0 || (pending === 0 && !editedSinceLast)) {
		return undefined;
	}
	session.lastSummary = Date.now();
	writeJson(sessionFile, session);

	const order = { '⏳': 0, '✅❌': 1, '❌': 2, '✅': 3 };
	rows.sort((a, b) => order[a.icon] - order[b.icon] || a.key.localeCompare(b.key));
	const lines = [`Claude Inline Diff: ${plural(rows.length, 'file')} edited in this chat`];
	lines.push(...rows.map(r => `${r.icon} ${r.key} (${r.text})`));
	if (pending > 0) {
		lines.push(`${plural(pending, 'file')} still to review in VS Code.`);
	}
	return lines.join('\n');
}

function forgetOldSessions() {
	const dir = path.dirname(sessionPath('x'));
	let names = [];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return;
	}
	for (const name of names) {
		const full = path.join(dir, name);
		try {
			if (Date.now() - fs.statSync(full).mtimeMs > SESSION_MAX_AGE_MS) {
				fs.rmSync(full, { force: true });
			}
		} catch {
			// gone already
		}
	}
}

// ---- main ----

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
	try {
		const event = JSON.parse(input);
		const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
		if (event.hook_event_name === 'Stop') {
			if (sessionId) {
				const message = summary(sessionId);
				if (message) {
					process.stdout.write(JSON.stringify({ systemMessage: message }));
				}
			}
			forgetOldSessions();
		} else {
			const filePath = event.tool_input && event.tool_input.file_path;
			if (typeof filePath === 'string' && filePath) {
				snapshot(path.resolve(event.cwd || process.cwd(), filePath), sessionId);
			}
		}
	} catch (err) {
		process.stderr.write(`claude-inline-diff hook failed: ${err}\n`);
	}
	process.exit(0);
});
