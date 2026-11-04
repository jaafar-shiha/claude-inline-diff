import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
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
	function claudeEdits(file: string, text: string) {
		execFileSync('node', [hook], { input: JSON.stringify({ cwd: root, tool_name: 'Edit', tool_input: { file_path: file } }) });
		fs.writeFileSync(file, text);
	}

	suiteSetup(async () => {
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
});
