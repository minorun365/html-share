import assert from 'node:assert/strict';
import test from 'node:test';
import type { BuiltPage } from '../src/bundle.js';
import { matchingPages } from '../src/publish.js';

function page(slug: string, title = slug): BuiltPage {
  return {
    slug,
    title,
    source: `${slug}.html`,
    updatedAt: '2026-08-27T00:00:00.000Z',
    date: '2026-08-27T00:00:00.000Z',
    repository: 'test',
    stream: 'test',
    streamLabel: 'Test',
    objectKey: `pages/${slug}/index.html`,
  };
}

test('prefers an exact slug over prefix and title matches', () => {
  const exact = page('report-2026-08-04-141049');
  const longer = page('report-2026-08-04-141049-ja');
  assert.deepEqual(matchingPages([exact, longer], exact.slug), [exact]);
});

test('keeps partial matching when there is no exact slug', () => {
  const first = page('release-notes', 'Release notes');
  const second = page('roadmap', 'Release roadmap');
  assert.deepEqual(matchingPages([first, second], 'Release'), [first, second]);
});
