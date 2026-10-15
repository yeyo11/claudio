import assert from 'node:assert/strict';
import test from 'node:test';
import * as headless from '@xterm/headless';
import { Screen, TailTracker } from '../src/terminals/host/screen.ts';

const { Terminal } = (headless as unknown as { default?: typeof headless }).default ?? headless;

const parsed = (term: InstanceType<typeof Terminal>, data: string | Uint8Array): Promise<void> => new Promise((done) => term.write(data, done));

/** What a viewer would see: text and colours of every cell of the active buffer, and the cursor */
function look(term: InstanceType<typeof Terminal>) {
  const buffer = term.buffer.active;
  const rows: string[] = [];
  for (let y = 0; y < buffer.length; y += 1) {
    const line = buffer.getLine(y);
    if (!line) continue;
    const cells: string[] = [];
    for (let x = 0; x < line.length; x += 1) {
      const cell = line.getCell(x);
      cells.push(`${cell?.getChars() ?? ''}|${String(cell?.getFgColor())}|${String(cell?.getBgColor())}|${String(cell?.isBold())}|${String(cell?.getWidth())}`);
    }
    rows.push(cells.join(','));
  }
  return { type: buffer.type, rows, cursor: [buffer.cursorX, buffer.cursorY] };
}

/** Writes `output` to a screen, takes its snapshot, and paints a second terminal from it */
async function roundTrip(output: string, cols = 40, rows = 10) {
  const screen = new Screen(cols, rows, 1000);
  screen.write(Buffer.from(output));
  const snap = await screen.snapshot(1000, 512 * 1024);
  const original = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true });
  await parsed(original, output);
  const copy = new Terminal({ cols: snap.cols, rows: snap.rows, scrollback: 1000, allowProposedApi: true });
  await parsed(copy, snap.snapshot);
  screen.dispose();
  return { original, copy, snap };
}

test('a snapshot after colours reproduces the same buffer in a second terminal', async () => {
  const { original, copy } = await roundTrip('\x1b[31mred\x1b[0m \x1b[1;44mbold on blue\x1b[0m\r\n\x1b[38;2;10;200;30mtrue colour\x1b[0m\r\nplain');
  assert.deepEqual(look(copy), look(original));
});

test('a snapshot inside the alternate screen reproduces it, and the primary screen behind it', async () => {
  const { original, copy } = await roundTrip('main screen\r\n\x1b[?1049h\x1b[2J\x1b[Hvim says hi\x1b[3;5Hcursor here');
  assert.equal(copy.buffer.active.type, 'alternate');
  assert.deepEqual(look(copy), look(original));
  await parsed(copy, '\x1b[?1049l');
  await parsed(original, '\x1b[?1049l');
  assert.deepEqual(look(copy), look(original));
});

test('wide characters (emoji, CJK) survive the round trip', async () => {
  const { original, copy } = await roundTrip('日本語のテキスト\r\n🎉 party 🚀\r\né combining');
  assert.deepEqual(look(copy), look(original));
});

test('scrollback is replayed up to the lines asked, and stepped down to fit the size', async () => {
  const screen = new Screen(20, 5, 5000);
  screen.write(Buffer.from(Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\r\n')));
  const full = await screen.snapshot(1000, 10 * 1024 * 1024);
  const small = await screen.snapshot(1000, 600);
  const none = await screen.snapshot(0, 1);
  assert.ok(full.snapshot.includes('line 5\r\n'), 'the first lines are in a full replay');
  assert.ok(Buffer.byteLength(small.snapshot) < Buffer.byteLength(full.snapshot));
  assert.ok(none.snapshot.includes('line 299'), 'the visible screen is always there');
  assert.equal(none.snapshot.includes('line 100'), false);
  screen.dispose();
});

test('the unfinished tail is what the serializer drops: a sequence cut in half', async () => {
  const screen = new Screen(20, 5, 100);
  screen.write(Buffer.from('hello\x1b[3'));
  const snap = await screen.snapshot(100, 1024);
  assert.equal(snap.tail.toString(), '\x1b[3');
  assert.equal(snap.snapshot.includes('\x1b[3'), false);
  screen.write(Buffer.from('1mred'));
  assert.equal((await screen.snapshot(100, 1024)).tail.length, 0);
  screen.dispose();
});

test('the tail tracker knows CSI, OSC (BEL and ST), DCS, intermediates and half a character', () => {
  const tail = (...chunks: string[]): string => {
    const tracker = new TailTracker();
    for (const chunk of chunks) tracker.feed(Buffer.from(chunk, 'latin1'));
    return tracker.tail().toString('latin1');
  };
  assert.equal(tail('plain text'), '');
  assert.equal(tail('a\x1b'), '\x1b');
  assert.equal(tail('a\x1b[1;'), '\x1b[1;');
  assert.equal(tail('a\x1b[1;2H'), '');
  assert.equal(tail('x\x1b]0;a title'), '\x1b]0;a title');
  assert.equal(tail('x\x1b]0;a title\x07y'), '');
  assert.equal(tail('x\x1b]0;a title\x1b\\'), '');
  assert.equal(tail('x\x1b]0;a title\x1b'), '\x1b]0;a title\x1b');
  assert.equal(tail('x\x1bP1$r'), '\x1bP1$r');
  assert.equal(tail('x\x1b(B'), '');
  assert.equal(tail('x\x1b('), '\x1b(');
  // Across chunks: the open sequence is the tail of both
  assert.equal(tail('ab\x1b[3', '1;4'), '\x1b[31;4');
  assert.equal(tail('ab\x1b[3', '1mok'), '');
  // A character cut after its first byte (the euro sign is E2 82 AC)
  const euro = Buffer.from('€');
  const tracker = new TailTracker();
  tracker.feed(euro.subarray(0, 2));
  assert.deepEqual(tracker.tail(), euro.subarray(0, 2));
  tracker.feed(euro.subarray(2));
  assert.equal(tracker.tail().length, 0);
});
