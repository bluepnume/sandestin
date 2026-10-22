import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

export { pair } from '../src/testing';

export type { PairContext } from '../src/testing';

// Forces a garbage collection without starting node with --expose-gc.
export const forceGC = () : void => {
    setFlagsFromString('--expose_gc');
    const gc = runInNewContext('gc') as () => void;

    gc();
};

// Waits for FinalizationRegistry callbacks, which run after GC on a later
// turn of the event loop, polling until `check` passes or time runs out.
type WaitForOptions = { readonly check : () => boolean, readonly timeout ?: number };

export const waitFor = async ({ check, timeout = 5000 } : WaitForOptions) : Promise<void> => {
    const deadline = Date.now() + timeout;

    while (!check()) {
        if (Date.now() > deadline) {
            throw new Error('Timed out waiting for condition');
        }

        forceGC();

        // eslint-disable-next-line no-await-in-loop -- polling loop
        await new Promise(resolve => {
            setTimeout(resolve, 20);
        });
    }
};

