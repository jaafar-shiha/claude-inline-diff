#!/usr/bin/env node
// Claude Code hook for the Claude Inline Diff extension. It handles two events:
//
//   PreToolUse (Edit|Write|MultiEdit)  saves a copy of a file right before Claude's first edit to it,
//                                      so the extension can show what changed, and remembers which
//                                      files this chat (session) edited.
//   Stop                               when Claude finishes a reply, lists the files this chat edited
//                                      with their review status (accepted, rejected, still pending).
//   SessionStart                       in a project set up for review, asks Claude to explain each
//                                      change (what and why) right before making it, so the chat
//                                      reads as an ordered story of the edits.
//
// Run as `node snapshot.js --pending <project>` (from the git pre-commit hook the extension installs),
// it stops a commit that includes files with Claude changes nobody has reviewed yet.
//
// The extension installs this script once, as ~/.claude/hooks/claude-inline-diff-snapshot.js, and
// registers it in ~/.claude/settings.json, so it runs for every Claude Code session
// (VS Code, terminal, desktop app) whatever folder that session started in.
// Only projects set up in VS Code (they have a .claude/inline-diff folder) are tracked.
//
// It must never block Claude, so it always exits with code 0.

const { execFileSync } = require('child_process');
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

// Claude Code's config folder: ~/.claude, or wherever CLAUDE_CONFIG_DIR points.
function claudeDir() {
	return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

function sessionPath(sessionId) {
	return path.join(claudeDir(), 'inline-diff', 'sessions', `${sessionId.replace(/[^\w.-]/g, '_')}.json`);
}

// ---- PreToolUse ----

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
// Enough characters to be a sentence, not a stray "Now:".
const MIN_EXPLANATION = 15;
// After this many edits sent back in a row, let the next one through, so Claude can never get stuck.
const MAX_SENT_BACK = 2;

function readTail(file, bytes) {
	try {
		const fd = fs.openSync(file, 'r');
		try {
			const size = fs.fstatSync(fd).size;
			const start = Math.max(0, size - bytes);
			const buffer = Buffer.alloc(size - start);
			fs.readSync(fd, buffer, 0, buffer.length, start);
			return buffer.toString('utf8');
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return undefined;
	}
}

function isUserPrompt(entry) {
	if (entry.type !== 'user' || entry.isMeta) {
		return false;
	}
	const content = entry.message && entry.message.content;
	return typeof content === 'string'
		|| (Array.isArray(content) && !content.some(b => b && b.type === 'tool_result'));
}

// The explanation Claude gave since its previous edit or the user's last message:
//   { visible: true }            it wrote reply text, which the chat already shows;
//   { visible: false, text }     it explained only in its thinking, which the chat hides;
//   undefined                    it didn't explain.
// The transcript has one line per content block. Edits in the same message as this one (made together)
// share an explanation. When the transcript can't be read, it counts as explained: never block on doubt.
function explanationBeforeEdit(transcriptPath, toolUseId) {
	const text = transcriptPath ? readTail(transcriptPath, 2 * 1024 * 1024) : undefined;
	if (text === undefined) {
		return { visible: true };
	}
	const entries = text.split('\n').flatMap(line => {
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	});
	const messageOf = id => entries.find(e => e.type === 'assistant' && Array.isArray(e.message?.content)
		&& e.message.content.some(b => b && b.type === 'tool_use' && b.id === id))?.message.id;
	const currentMessage = toolUseId ? messageOf(toolUseId) : undefined;
	let thought;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (isUserPrompt(entry)) {
			break;
		}
		if (entry.type !== 'assistant' || !Array.isArray(entry.message?.content)) {
			continue;
		}
		let earlierEdit = false;
		for (const block of [...entry.message.content].reverse()) {
			if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim().length >= MIN_EXPLANATION) {
				return { visible: true };
			}
			if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.trim().length >= MIN_EXPLANATION) {
				thought ??= block.thinking.trim(); // the latest thought, closest to the edit
			}
			if (block?.type === 'tool_use' && EDIT_TOOLS.has(block.name) && block.id !== toolUseId
				&& (currentMessage === undefined || entry.message.id !== currentMessage)) {
				earlierEdit = true; // an earlier edit: anything before it explained that one
				break;
			}
		}
		if (earlierEdit) {
			break;
		}
	}
	return thought ? { visible: false, text: thought } : undefined;
}

// Shows an explanation Claude only thought, in the chat right before its edit.
function noteForChat(key, thought) {
	const MAX = 600;
	const text = thought.replace(/\s+/g, ' ').trim();
	return `✎ ${key}: ${text.length > MAX ? `${text.slice(0, MAX - 1)}…` : text}`;
}

// What to do about the explanation before an edit: { deny: reason } sends the edit back to Claude,
// { note } lets it through with the explanation shown in the chat, {} just lets it through.
function checkExplanation(event, file, sessionId) {
	const at = locate(file);
	if (!EDIT_TOOLS.has(event.tool_name) || !at || !explainEditsEnabled()) {
		return {};
	}
	const sessionFile = sessionId ? sessionPath(sessionId) : undefined;
	const session = sessionFile ? readJson(sessionFile) : {};
	const explanation = explanationBeforeEdit(event.transcript_path, event.tool_use_id);
	if (explanation || (session.sentBack ?? 0) >= MAX_SENT_BACK) {
		if (sessionFile && session.sentBack) {
			session.sentBack = 0;
			writeJson(sessionFile, session);
		}
		return explanation && !explanation.visible ? { note: noteForChat(at.key, explanation.text) } : {};
	}
	if (sessionFile) {
		session.sentBack = (session.sentBack ?? 0) + 1;
		writeJson(sessionFile, session);
	}
	const name = at.key;
	return { deny: `Claude Inline Diff: this edit was not applied, because no explanation was written before it. `
		+ `Anything in your thinking is hidden from the user and doesn't count. `
		+ `Output a visible text message now, 1-3 short sentences saying what you're about to change in ${name} and why `
		+ `(if it adds a variable, function or condition whose purpose isn't obvious, say what it's for), `
		+ `then call the tool again with the same edit.` };
}

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

// ---- SessionStart ----

const EXPLAIN_EDITS = `Claude Inline Diff is on in this project: the user reviews your file changes afterwards by reading this chat in order, like a story. So narrate your edits:
- Right before each Edit, Write or MultiEdit call, write 1-3 short sentences as a visible text message in your reply, saying what you're about to change (in plain words, naming the file) and why: the goal of this particular change, not just the overall task.
- When the change adds a variable, field, function or condition whose purpose isn't obvious, say what it holds or does and why it's needed. Add a tiny concrete example when that makes it clearer, e.g. "\`signature\` is the request we last sent, as JSON; if the next request has the same signature, we skip sending it again."
- Your thinking doesn't count: it's hidden from the user. The explanation must be ordinary reply text, output right before the tool call.
- Keep it brief and plain. Edits made together in one step can share one explanation. Put these explanations in the chat, not in code comments.
An edit with no explanation before it is sent back to you to explain first.`;

// The user's choice from the VS Code setting claudeInlineDiff.explainEditsInChat, written by the extension.
function explainEditsEnabled() {
	return readJson(path.join(claudeDir(), 'inline-diff', 'settings.json')).explainEdits !== false;
}

function sessionStart(cwd) {
	if (!cwd || !findProjectRoot(path.join(cwd, '_')) || !explainEditsEnabled()) {
		return undefined;
	}
	return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: EXPLAIN_EDITS } };
}

// ---- git pre-commit ----

function realpath(file) {
	try {
		return fs.realpathSync(file);
	} catch {
		return path.resolve(file);
	}
}

// Exit code for the pre-commit hook: 1 when a staged file still has unreviewed Claude changes.
// Any failure of its own lets the commit through, so a bug here never blocks the user's work.
function checkCommit(root) {
	try {
		const manifest = readJson(path.join(root, '.claude', 'inline-diff', 'manifest.json'));
		const pending = Object.keys(manifest).filter(key => status(path.join(root, key))?.icon === '⏳');
		if (pending.length === 0) {
			return 0;
		}
		const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
		const top = git(['rev-parse', '--show-toplevel']).trim();
		const staged = new Set(git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
			.map(name => realpath(path.join(top, name))));
		const blocked = pending.filter(key => staged.has(realpath(path.join(root, key))));
		if (blocked.length === 0) {
			return 0;
		}
		process.stderr.write([
			`Claude Inline Diff: commit stopped. ${plural(blocked.length, 'staged file')} ${blocked.length === 1 ? 'has' : 'have'} Claude changes you haven't reviewed:`,
			...blocked.map(key => `  ${key}`),
			'Accept or reject them in VS Code, then commit again. To commit anyway: git commit --no-verify',
			'',
		].join('\n'));
		return 1;
	} catch {
		return 0;
	}
}

// ---- main ----

if (process.argv[2] === '--pending') {
	process.exit(checkCommit(path.resolve(process.argv[3] || process.cwd())));
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => (input += chunk));
process.stdin.on('end', () => {
	try {
		const event = JSON.parse(input);
		const sessionId = typeof event.session_id === 'string' ? event.session_id : undefined;
		if (event.hook_event_name === 'SessionStart') {
			const output = sessionStart(typeof event.cwd === 'string' ? event.cwd : undefined);
			if (output) {
				process.stdout.write(JSON.stringify(output));
			}
		} else if (event.hook_event_name === 'Stop') {
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
				const file = path.resolve(event.cwd || process.cwd(), filePath);
				const check = checkExplanation(event, file, sessionId);
				if (check.deny) {
					// Sent back unchanged, so no snapshot: the file isn't touched this time.
					process.stdout.write(JSON.stringify({
						hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: check.deny },
					}));
				} else {
					snapshot(file, sessionId);
					if (check.note) {
						process.stdout.write(JSON.stringify({ systemMessage: check.note }));
					}
				}
			}
		}
	} catch (err) {
		process.stderr.write(`claude-inline-diff hook failed: ${err}\n`);
	}
	process.exit(0);
});
