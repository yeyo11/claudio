import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { ChatUploads } from '../src/chat-uploads.ts';
import { Db } from '../src/db.ts';
import { Core } from '../src/index.ts';
import { UploadStore } from '../src/uploads.ts';
import { tempConfig } from './helpers.ts';

// Which uploads belong to a chat is kept as rows, so a shared chat's uploads are known for every
// chat and after a restart, not only for the chats loaded in the current run.

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude-control.mjs', import.meta.url));

test("a chat's uploads are known after a restart of the core, with nothing of the chat loaded", async () => {
  const config = { ...tempConfig(), claudeBin: FAKE_CLAUDE };
  const core = new Core(config);
  let chatId = '';
  let uploadId = '';
  try {
    const upload = core.uploads.save('notes.txt', Buffer.from('what the chat was given'));
    uploadId = upload.id;
    const chat = core.runtime.start({ prompt: 'read this', attachments: [upload.id], keepAlive: false });
    chatId = chat.id;
    await core.runtime.waitForResult(chat.id);
    const before = await core.chatUploads.of(chatId);
    assert.deepEqual(before.map((u) => u.uploadId), [uploadId]);
  } finally {
    core.shutdown();
  }

  const again = new Core(config);
  try {
    assert.equal((again.runtime.messages(chatId) ?? []).length, 0, "the restarted core holds none of the chat's messages");
    const after = await again.chatUploads.of(chatId);
    assert.deepEqual(after.map((u) => u.uploadId), [uploadId]);
    assert.ok(after[0] && !Number.isNaN(Date.parse(after[0].attachedAt)));
  } finally {
    again.shutdown();
  }
});

test("a chat from before the rows is read once from its transcript, and only its own turns' files count", async () => {
  const config = tempConfig();
  const db = new Db(config);
  const uploads = new UploadStore(config.dataDir);
  const attached = uploads.save('spec.md', Buffer.from('# spec'));
  const elsewhere = uploads.save('other.md', Buffer.from('# other'));
  const transcript = join(config.dataDir, 'old-chat.jsonl');
  const turn = `look\n\n<attached-files>\nFiles attached to this message:\n- spec.md | text/markdown | 6 bytes | ${attached.path}\n</attached-files>`;
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: turn }] } }),
      // A tool that read another chat's upload names its path, but this chat never attached it
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `cat ${elsewhere.path}` }] } }),
      'not json',
    ].join('\n') + '\n',
  );
  let reads = 0;
  const chatUploads = new ChatUploads(db, uploads.dir, async (id) => {
    reads++;
    return id === 'old-chat' ? transcript : null;
  });

  const [first, second] = await Promise.all([chatUploads.of('old-chat'), chatUploads.of('old-chat')]);
  assert.deepEqual(first?.map((u) => u.uploadId), [attached.id]);
  assert.deepEqual(second, first);
  assert.equal(reads, 1, 'two asks at once share one scan');

  // Scanned once: the transcript is not read again, and a later message's rows join the scanned ones
  rmSync(transcript);
  db.addChatUploads('old-chat', [elsewhere.id, attached.id], '2999-01-01T00:00:00.000Z');
  assert.deepEqual((await chatUploads.of('old-chat')).map((u) => u.uploadId), [attached.id, elsewhere.id]);
  assert.equal(reads, 1);

  // A chat without a transcript names nothing, and is not looked for again either
  assert.deepEqual(await chatUploads.of('new-chat'), []);
  assert.deepEqual(await chatUploads.of('new-chat'), []);
  assert.equal(reads, 2);

  // Deleting a chat takes its rows and its mark with it
  db.deleteChat('old-chat');
  assert.deepEqual(db.chatUploads('old-chat'), []);
  assert.equal(db.chatUploadsScanned('old-chat'), false);
  db.close();
});
