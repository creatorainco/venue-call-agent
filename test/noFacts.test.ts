/**
 * The no-facts guard's venue rule, read from a list outside the repository.
 *
 * WHY THIS EXISTS. Real venue names cannot sit in a public repository in any form — an unsalted
 * hash of a short restaurant name is reversed by hashing a list of restaurants. So the guard reads
 * them from the file `VENUE_NAME_LIST_FILE` names, and a CreatoRain engineer keeps that file
 * elsewhere. That moves the rule's only real input out of every test this repository runs, which
 * is exactly how a rule goes quietly dead. These cases are its positive control: an invented list,
 * an invented name planted in a throwaway copy of `src/`, and the guard must refuse it.
 *
 * Every name below is invented. The guard is copied into a temporary root so the plant never
 * touches this repository's own `src/`.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARD = fileURLToPath(new URL('../scripts/check-no-facts.mjs', import.meta.url));
const PLANTED = 'Velvet Ladle Bistro';

interface Run { status: number | null; out: string }

function runGuard(script: string, listFile?: string): Run {
    const env: Record<string, string | undefined> = { ...process.env };
    delete env.VENUE_NAME_LIST_FILE;
    if (listFile !== undefined) env.VENUE_NAME_LIST_FILE = listFile;
    const r = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('no-facts: real venue names come from a file outside the repository', () => {
    let root = '';
    let copy = '';

    before(() => {
        root = mkdtempSync(join(tmpdir(), 'no-facts-'));
        mkdirSync(join(root, 'scripts'));
        mkdirSync(join(root, 'src'));
        copy = join(root, 'scripts', 'check-no-facts.mjs');
        copyFileSync(GUARD, copy);
        writeFileSync(join(root, 'src', 'planted.ts'), `export const where = '${PLANTED}';\n`);
        writeFileSync(join(root, 'names.txt'), `# invented, for this test only\n${PLANTED}\nCopper Kettle Diner\n`);
        writeFileSync(join(root, 'other-names.txt'), 'Copper Kettle Diner\n');
        writeFileSync(join(root, 'empty.txt'), '# nothing but a comment\n\n');
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    it('CONTROL — a listed name planted in src/ fails the build, and the output says where', () => {
        const r = runGuard(copy, join(root, 'names.txt'));
        assert.equal(r.status, 1, r.out);
        assert.match(r.out, /planted\.ts:1\s+\[a venue or brand name\]/);
        assert.match(r.out, /venue names: 2 from VENUE_NAME_LIST_FILE/);
    });

    it('the same tree is clean when the list does not hold that name', () => {
        const r = runGuard(copy, join(root, 'other-names.txt'));
        assert.equal(r.status, 0, r.out);
    });

    it('unset, every other rule still runs and the venue rule keeps its built-in control', () => {
        const r = runGuard(copy);
        assert.equal(r.status, 0, r.out);
        assert.match(r.out, /control tripped \d+ rule\(s\) \(a venue or brand name,/);
        assert.match(r.out, /venue names: the control only/);
    });

    it('a list that cannot be read refuses to report clean', () => {
        const r = runGuard(copy, join(root, 'no-such-file.txt'));
        assert.equal(r.status, 2, r.out);
    });

    it('a list with no names in it refuses to report clean', () => {
        const r = runGuard(copy, join(root, 'empty.txt'));
        assert.equal(r.status, 2, r.out);
    });

    it("this repository's own src/ holds none of the invented names", () => {
        const r = runGuard(GUARD, join(root, 'names.txt'));
        assert.equal(r.status, 0, r.out);
    });
});
