import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BM25Index, reciprocalRankFusion } from '../bm25.js';

test('BM25Index ranks an exact keyword match above an unrelated document', () => {
  const index = new BM25Index();
  index.build([
    { id: 'a', content: 'The remote work policy allows employees to work from anywhere.' },
    { id: 'b', content: 'Deployments run through the CI/CD pipeline on every merge.' },
    { id: 'c', content: 'Onboarding checklist for new hires in their first week.' },
  ]);

  const results = index.search('remote work policy');
  assert.equal(results[0].id, 'a');
  assert.ok(results[0].score > 0);
});

test('BM25Index returns nothing for a query with no vocabulary overlap', () => {
  const index = new BM25Index();
  index.build([{ id: 'a', content: 'Collaboration, Results, Efficiency, Diversity, Inclusion, Iteration, Transparency.' }]);
  const results = index.search('xyzzy plugh quux');
  assert.deepEqual(results, []);
});

test('BM25Index.search on an empty index does not throw', () => {
  const index = new BM25Index();
  index.build([]);
  assert.deepEqual(index.search('anything'), []);
});

test('reciprocalRankFusion favors an item ranked highly in both lists', () => {
  const dense = [{ id: 'x', score: 0.9 }, { id: 'y', score: 0.8 }, { id: 'z', score: 0.7 }];
  const sparse = [{ id: 'x', score: 12 }, { id: 'z', score: 8 }, { id: 'y', score: 1 }];
  const fused = reciprocalRankFusion([dense, sparse]);
  assert.equal(fused[0].id, 'x'); // #1 in both lists
});

test('reciprocalRankFusion handles an id present in only one list', () => {
  const dense = [{ id: 'only-dense', score: 0.5 }];
  const sparse = [{ id: 'only-sparse', score: 5 }];
  const fused = reciprocalRankFusion([dense, sparse]);
  assert.equal(fused.length, 2);
});
