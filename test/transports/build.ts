// The worker and child-process tests run real Node processes, which load
// plain JavaScript. This builds src/ and the transport fixtures into a temp
// directory once per test file and hands back the paths.
import { build } from 'cugel-scripts/build';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type BuiltFixtures = {
    readonly dir : string,
    readonly entry : string,
    readonly protocol : string,
    readonly api : string,
    readonly cleanup : () => Promise<void>,
};

export const buildFixtures = async () : Promise<BuiltFixtures> => {
    const root = path.resolve(import.meta.dirname, '..', '..');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sandestin-build-'));

    await build({ root, outDir: dir, sourceDirs: [ 'src', 'test/transports' ], declarations: false });

    return {
        dir,
        entry:    path.join(dir, 'src', 'index.js'),
        protocol: path.join(dir, 'test', 'transports', 'protocol.js'),
        api:      path.join(dir, 'test', 'transports', 'api.js'),
        cleanup:  () => rm(dir, { recursive: true, force: true })
    };
};
