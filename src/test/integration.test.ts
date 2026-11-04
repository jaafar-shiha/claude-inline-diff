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
		assert.notStrictEqual(os.homedir(), process.env.REAL_HOME, 'tests must not use the real home folder');
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
});
