import { test } from 'node:test';
import assert from 'node:assert/strict';
import { headerAwareChunk } from '../ingest.js';

test('headerAwareChunk splits on markdown headers, keeping each section intact', () => {
  const md = [
    '# Remote Work',
    'We are an all-remote company.',
    '',
    '## Equipment',
    'We provide a laptop stipend.',
  ].join('\n');

  const chunks = headerAwareChunk(md, 'handbook/remote.md');
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].heading, 'Remote Work');
  assert.ok(chunks[0].text.includes('all-remote'));
  assert.equal(chunks[1].heading, 'Equipment');
  assert.ok(chunks[1].text.includes('laptop stipend'));
});

test('headerAwareChunk sub-splits a section that exceeds the chunk size, preserving an overlap', () => {
  const longParagraph = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about the policy.`).join(' ');
  const md = `## Policy\n\n${longParagraph}`;

  const chunks = headerAwareChunk(md, 'handbook/policy.md');
  assert.ok(chunks.length > 1, 'a long section should be split into multiple chunks');
  for (const c of chunks) {
    assert.ok(c.text.length <= 1400 + 200); // MAX_CHUNK_CHARS + slack for the paragraph that pushed it over
  }
});

test('headerAwareChunk drops sections that are entirely blank', () => {
  const md = '## Empty Section\n\n\n## Real Section\nActual content here.';
  const chunks = headerAwareChunk(md, 'handbook/mixed.md');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'Real Section');
});

test('headerAwareChunk falls back to the file path as the heading when there is no header', () => {
  const chunks = headerAwareChunk('Just a plain paragraph with no heading at all.', 'handbook/no-header.md');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].heading, 'handbook/no-header.md');
});
