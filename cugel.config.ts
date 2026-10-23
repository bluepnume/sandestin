import type { BuildOptions } from 'cugel-scripts/build';

// The runtime bar is current browsers and Node 20+ (FinalizationRegistry,
// WeakRef, AbortSignal.any), but the *syntax* is kept at ES2019 so that
// bundlers which predate `??`, `?.` and class fields can still parse the
// package without a transpile step of their own.
// eslint-disable-next-line import/no-default-export -- cugel-scripts reads the config's default export
export default {
    build: {
        target: 'es2019'
    } satisfies Omit<BuildOptions, 'root'>
};
