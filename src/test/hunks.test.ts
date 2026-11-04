import * as assert from 'assert';
import { acceptHunk, computeDiff, rejectHunk } from '../hunks';

const base = 'a\nb\nc\nd\ne\n';
// Hunk 0 replaces b with B1/B2, hunk 1 removes d, hunk 2 appends f.
const current = 'a\nB1\nB2\nc\ne\nf\n';

suite('hunks', () => {
	test('finds each change and where it sits in the current text', () => {
		const { hunks } = computeDiff(base, current);
		assert.deepStrictEqual(
			hunks.map(h => [h.startLine, h.addedLines, h.removedLines]),
			[[1, 2, 1], [4, 0, 1], [5, 1, 0]],
		);
		assert.strictEqual(hunks[0].removedText, 'b\n');
		assert.strictEqual(hunks[0].addedText, 'B1\nB2\n');
	});

	test('accepting a hunk moves only that hunk into the original', () => {
		const diff = computeDiff(base, current);
		assert.strictEqual(acceptHunk(diff, 0), 'a\nB1\nB2\nc\nd\ne\n');
		assert.strictEqual(acceptHunk(diff, 1), 'a\nb\nc\ne\n');
		assert.strictEqual(computeDiff(acceptHunk(diff, 2), current).hunks.length, 2);
	});

	test('rejecting a hunk restores only that hunk', () => {
		const diff = computeDiff(base, current);
		assert.strictEqual(rejectHunk(diff, 0), 'a\nb\nc\ne\nf\n');
		assert.strictEqual(rejectHunk(diff, 1), 'a\nB1\nB2\nc\nd\ne\nf\n');
		assert.strictEqual(rejectHunk(diff, 2), 'a\nB1\nB2\nc\ne\n');
	});

	test('a new file is one added hunk; rejecting it empties the file', () => {
		const diff = computeDiff('', 'x\ny\n');
		assert.deepStrictEqual(diff.hunks.map(h => [h.startLine, h.addedLines, h.removedLines]), [[0, 2, 0]]);
		assert.strictEqual(rejectHunk(diff, 0), '');
	});

	test('no changes means no hunks', () => {
		assert.strictEqual(computeDiff(base, base).hunks.length, 0);
	});
});
