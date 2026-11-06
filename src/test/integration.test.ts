import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

// Runs inside VS Code (npm test). Plays what Claude Code does: the hook runs, then the file changes.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor<T>(what: string, fn: () => Promise<T | undefined> | T | undefined): Promise<T> {
	for (let i = 0; i < 50; i++) {
		const value = await fn();
		if (value !== undefined) {
			return value;
		}
		await sleep(200);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function changeLenses(uri: vscode.Uri): Promise<vscode.CodeLens[]> {
	const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', uri) ?? [];
	return lenses.filter(l => l.command?.command === 'claudeInlineDiff.acceptHunk' || l.command?.command === 'claudeInlineDiff.rejectHunk');
}

async function run(lens: vscode.CodeLens): Promise<void> {
	await vscode.commands.executeCommand(lens.command!.command, ...lens.command!.arguments!);
}

suite('editor integration', () => {
	const root = vscode.workspace.workspaceFolders![0].uri.fsPath;
	const hook = path.resolve(__dirname, '..', '..', 'hooks', 'snapshot.js');

	// What Claude Code does for an Edit: run the PreToolUse hook, then write the file.
	function claudeEdits(file: string, text: string, sessionId = 'other-chat') {
		execFileSync('node', [hook], {
			input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sessionId, cwd: root, tool_name: 'Edit', tool_input: { file_path: file } }),
		});
		fs.writeFileSync(file, text);
	}

	// What Claude Code does when it finishes a reply: run the Stop hook. Returns the message it shows.
	function claudeStops(sessionId: string): string | undefined {
		const out = execFileSync('node', [hook], { input: JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId, cwd: root }) }).toString();
		return out ? JSON.parse(out).systemMessage : undefined;
	}

	async function openWithChanges(file: string): Promise<{ doc: vscode.TextDocument; lenses: vscode.CodeLens[] }> {
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);
		const lenses = await waitFor('Accept/Reject buttons', async () => {
			const found = await changeLenses(doc.uri);
			return found.length > 0 ? found : undefined;
		});
		return { doc, lenses };
	}

	const accept = (lenses: vscode.CodeLens[]) => lenses.find(l => l.command!.command === 'claudeInlineDiff.acceptHunk')!;
	const reject = (lenses: vscode.CodeLens[]) => lenses.find(l => l.command!.command === 'claudeInlineDiff.rejectHunk')!;

	suiteSetup(async () => {
		const config = process.env.CLAUDE_CONFIG_DIR;
		assert.ok(config && config.startsWith(os.tmpdir()), 'tests must not use the real ~/.claude folder');
		await vscode.extensions.getExtension('jaafar-shiha.claude-inline-diff')!.activate();
	});

	test('an open file shows Accept/Reject buttons above the change, and Accept keeps it', async () => {
		const file = path.join(root, 'lib', 'main_screen.dart');
		fs.writeFileSync(file, 'void main() {\n  run();\n}\n');
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);

		claudeEdits(file, "void main() {\n  debugPrint('Hello world');\n  run();\n}\n");

		const lenses = await waitFor('Accept/Reject buttons', async () => {
			const found = await changeLenses(doc.uri);
			return found.length > 0 ? found : undefined;
		});
		assert.deepStrictEqual(lenses.map(l => [l.range.start.line, l.command!.title]),
			[[1, '$(check) Accept ⌥⌘Y'], [1, '$(close) Reject ⌥⌘N']]);
		const all = await vscode.commands.executeCommand<vscode.CodeLens[]>('vscode.executeCodeLensProvider', doc.uri);
		assert.ok(all.some(l => l.command?.title.includes('Accept All')));

		await run(lenses[0]);

		assert.strictEqual((await changeLenses(doc.uri)).length, 0);
		assert.ok(doc.getText().includes('Hello world'));
	});

	test('Reject puts the original lines back in the file', async () => {
		const file = path.join(root, 'lib', 'other.dart');
		fs.writeFileSync(file, 'a\nb\nc\n');
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);

		claudeEdits(file, 'a\nB\nc\n');

		const lenses = await waitFor('Accept/Reject buttons', async () => {
			const found = await changeLenses(doc.uri);
			return found.length > 0 ? found : undefined;
		});
		await run(lenses.find(l => l.command!.command === 'claudeInlineDiff.rejectHunk')!);

		assert.strictEqual(fs.readFileSync(file, 'utf8'), 'a\nb\nc\n');
		assert.strictEqual((await changeLenses(doc.uri)).length, 0);
	});

	test('a copy saved by an older version still shows only the changed line, not the whole file', async () => {
		const file = path.join(root, 'lib', 'home_screen.dart');
		fs.writeFileSync(file, 'x\ny\n');
		claudeEdits(file, 'x\nhello\ny\n');
		// Older versions saved the copy without the .snapshot suffix.
		const snapshots = path.join(root, '.claude', 'inline-diff', 'snapshots', 'lib');
		fs.renameSync(path.join(snapshots, 'home_screen.dart.snapshot'), path.join(snapshots, 'home_screen.dart'));
		const doc = await vscode.workspace.openTextDocument(file);
		await vscode.window.showTextDocument(doc);

		const lenses = await waitFor('Accept/Reject buttons', async () => {
			const found = await changeLenses(doc.uri);
			return found.length > 0 ? found : undefined;
		});
		assert.deepStrictEqual(lenses.map(l => l.range.start.line), [1, 1]);
	});

	test('at the end of a reply, the chat lists its edited files as pending, then accepted or rejected', async () => {
		const chat = 'chat-summary';
		const kept = path.join(root, 'lib', 'kept.dart');
		const undone = path.join(root, 'lib', 'undone.dart');
		fs.writeFileSync(kept, 'one\n');
		fs.writeFileSync(undone, 'two\n');
		claudeEdits(kept, 'one\nmore\n', chat);
		claudeEdits(undone, 'TWO\n', chat);

		assert.strictEqual(claudeStops(chat), [
			'Claude Inline Diff: 2 files edited in this chat',
			'⏳ lib/kept.dart (waiting for review)',
			'⏳ lib/undone.dart (waiting for review)',
			'2 files still to review in VS Code.',
		].join('\n'));

		await run(accept((await openWithChanges(kept)).lenses));
		await run(reject((await openWithChanges(undone)).lenses));

		// The user's next message: Claude replies without editing anything.
		assert.strictEqual(claudeStops(chat), undefined, 'nothing new and nothing pending: stay quiet');
		claudeEdits(path.join(root, 'lib', 'third.dart'), 'x\n', chat);
		assert.strictEqual(claudeStops(chat), [
			'Claude Inline Diff: 3 files edited in this chat',
			'⏳ lib/third.dart (waiting for review)',
			'❌ lib/undone.dart (rejected)',
			'✅ lib/kept.dart (accepted)',
			'1 file still to review in VS Code.',
		].join('\n'));
	});

	test('a file with some changes accepted and some rejected is listed as partly accepted', async () => {
		const chat = 'chat-partial';
		const file = path.join(root, 'lib', 'partial.dart');
		fs.writeFileSync(file, 'a\nb\nc\nd\ne\n');
		claudeEdits(file, 'A\nb\nc\nd\nE\n', chat);

		const first = await openWithChanges(file);
		await run(accept(first.lenses));
		await run(reject(await changeLenses(first.doc.uri)));

		assert.strictEqual(claudeStops(chat), [
			'Claude Inline Diff: 1 file edited in this chat',
			'✅❌ lib/partial.dart (partly accepted: 1 kept, 1 undone)',
		].join('\n'));
	});

	test('a chat that only edits files outside set-up projects shows nothing', () => {
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-inline-diff-outside-'));
		const file = path.join(outside, 'x.txt');
		fs.writeFileSync(file, 'x\n');
		claudeEdits(file, 'y\n', 'chat-outside');
		assert.strictEqual(claudeStops('chat-outside'), undefined);
	});

	test('a file Claude edits opens in the inline diff view, which gives way to the normal editor once reviewed', async () => {
		assert.strictEqual(vscode.workspace.getConfiguration('diffEditor').get('renderSideBySide'), false);
		assert.strictEqual(vscode.workspace.getConfiguration('diffEditor').get('codeLens'), true);

		const file = path.join(root, 'lib', 'sheet.dart');
		fs.writeFileSync(file, 'return SizedBox(\n  child: x,\n);\n');
		claudeEdits(file, 'return DraggableScrollableSheet(\n  child: x,\n);\n');

		const diffTab = () => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t =>
			t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === file);
		const tab = await waitFor('the diff view', diffTab);
		const input = tab.input as vscode.TabInputTextDiff;
		assert.strictEqual(input.original.scheme, 'claude-inline-diff-base');
		assert.strictEqual((await vscode.workspace.openTextDocument(input.original)).getText(), 'return SizedBox(\n  child: x,\n);\n');

		// The buttons are on the real file, which is the diff's right side.
		const lenses = await waitFor('Accept/Reject buttons', async () => {
			const found = await changeLenses(input.modified);
			return found.length > 0 ? found : undefined;
		});
		await run(accept(lenses));

		await waitFor('the diff view to close', () => (diffTab() ? undefined : true));
		assert.ok(vscode.window.tabGroups.all.flatMap(g => g.tabs).some(t =>
			t.input instanceof vscode.TabInputText && t.input.uri.fsPath === file), 'the file is open in a normal editor');
		assert.ok(fs.readFileSync(file, 'utf8').includes('DraggableScrollableSheet'));
	});

	const diffTabOf = (file: string) => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t =>
		t.input instanceof vscode.TabInputTextDiff && t.input.modified.fsPath === file);
	const plainTabOf = (file: string) => vscode.window.tabGroups.all.flatMap(g => g.tabs).find(t =>
		t.input instanceof vscode.TabInputText && t.input.uri.fsPath === file);

	test('the diff view opens even though the hook runs before Claude writes the file (real timing)', async () => {
		const file = path.join(root, 'lib', 'timing.dart');
		fs.writeFileSync(file, 'Text("old");\n');
		execFileSync('node', [hook], {
			input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'timing', cwd: root, tool_name: 'Edit', tool_input: { file_path: file } }),
		});
		// The extension sees the new manifest entry while the file is still unchanged...
		await new Promise(r => setTimeout(r, 600));
		assert.strictEqual(plainTabOf(file), undefined, 'nothing to show yet, so no plain editor either');
		// ...and only then does Claude's edit land.
		fs.writeFileSync(file, 'Text("new");\nText("more");\n');
		await waitFor('the diff view', () => diffTabOf(file));
		assert.strictEqual(plainTabOf(file), undefined);
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('a file already open in a normal tab switches to the diff view when Claude changes it', async () => {
		const file = path.join(root, 'lib', 'open_already.dart');
		fs.writeFileSync(file, 'int a = 1;\n');
		await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(file), { preview: false });
		claudeEdits(file, 'int a = 2;\nint b = 3;\n');
		await waitFor('the diff view', () => diffTabOf(file));
		await waitFor('the plain tab to close', () => (plainTabOf(file) ? undefined : true));

		// Leaving the diff view (VS Code's "Open File") isn't undone by the extension.
		await vscode.window.showTextDocument(vscode.Uri.file(file), { preview: false });
		await new Promise(r => setTimeout(r, 600));
		assert.ok(plainTabOf(file), 'the plain tab the user asked for stays');
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	const api = () => vscode.extensions.getExtension('jaafar-shiha.claude-inline-diff')!.exports as {
		pendingFiles(): string[]; fileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined;
	};

	test('files waiting for review get a badge in the Explorer, which goes once they are reviewed', async () => {
		const file = path.join(root, 'lib', 'badge.dart');
		fs.writeFileSync(file, 'var a = 1;\n');
		claudeEdits(file, 'var a = 2;\n');
		const uri = vscode.Uri.file(file);
		const badge = await waitFor('the badge', () => api().fileDecoration(uri));
		assert.strictEqual(badge.badge, '✦');
		assert.ok(badge.propagate, 'parent folders are marked too');
		assert.ok(api().pendingFiles().includes(file));

		const { lenses } = await openWithChanges(file);
		await run(reject(lenses));
		await waitFor('the badge to go', () => (api().fileDecoration(uri) ? undefined : true));
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');
	});

	test('git commit is stopped while a staged file has unreviewed Claude changes, and the user keeps their own hook', async () => {
		const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
			{ cwd: root, encoding: 'utf8', stdio: 'pipe' });
		git('init', '-q');
		const hookFile = path.join(root, '.git', 'hooks', 'pre-commit');
		fs.writeFileSync(hookFile, '#!/bin/sh\necho "the user\'s own check"\n', { mode: 0o755 });
		await vscode.commands.executeCommand('claudeInlineDiff.setUpHook');
		const hookText = await waitFor('the commit guard', () => {
			const text = fs.readFileSync(hookFile, 'utf8');
			return text.includes('claude-inline-diff') ? text : undefined;
		});
		assert.ok(hookText.includes("the user's own check"), 'the existing hook is kept');

		const file = path.join(root, 'lib', 'commit_me.dart');
		fs.writeFileSync(file, 'final x = 1;\n');
		claudeEdits(file, 'final x = 2;\n');
		git('add', 'lib/commit_me.dart');
		let error: any;
		try {
			git('commit', '-q', '-m', 'unreviewed');
		} catch (err) {
			error = err;
		}
		assert.ok(error, 'the commit is stopped');
		assert.match(String(error.stderr), /commit stopped[\s\S]*lib\/commit_me\.dart/);

		const { lenses } = await openWithChanges(file);
		await run(accept(lenses));
		await waitFor('the review to finish', () => (api().pendingFiles().includes(file) ? undefined : true));
		git('add', 'lib/commit_me.dart');
		git('commit', '-q', '-m', 'reviewed'); // goes through now
		await vscode.commands.executeCommand('workbench.action.closeAllEditors');

		// Turning the setting off takes the extension's lines out again, and only those.
		const settings = vscode.workspace.getConfiguration('claudeInlineDiff');
		await settings.update('blockCommitsWithPendingChanges', false, vscode.ConfigurationTarget.Workspace);
		await waitFor('the guard to be removed', () => (fs.readFileSync(hookFile, 'utf8').includes('claude-inline-diff') ? undefined : true));
		assert.strictEqual(fs.readFileSync(hookFile, 'utf8'), '#!/bin/sh\necho "the user\'s own check"\n');
		await settings.update('blockCommitsWithPendingChanges', undefined, vscode.ConfigurationTarget.Workspace);
	});
});
