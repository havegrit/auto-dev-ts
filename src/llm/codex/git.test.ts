import { describe, expect, it } from 'vitest';
import { parseGitChangedFiles } from './git.js';

describe('parseGitChangedFiles', () => {
  it('combines diff names and status entries without duplicates', () => {
    const files = parseGitChangedFiles({
      diffNameOnly: ['src/a.ts', 'src/b.ts'].join('\n'),
      statusShort: [' M src/b.ts', '?? src/c.ts', 'R  src/old.ts -> src/new.ts'].join('\n'),
    });

    expect(files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/new.ts']);
  });
});
