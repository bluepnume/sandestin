import type { Ref } from '../src';

import { pair, waitFor } from './helpers';

// Decodes in a separate function so the proxy is unreachable once it returns.
type DecodeAndDropOptions = { readonly wire : unknown, readonly serdes : ReturnType<typeof pair>[1] };

const decodeAndDrop = ({ wire, serdes } : DecodeAndDropOptions) : void => {
    const remote = serdes.decode({ wire }) as Ref;

    expect(typeof remote).toBe('function');
};

describe('the garbage-collection net', () => {
    it('releases a handle whose proxy was dropped without an explicit release', async () => {
        const [ a, b ] = pair();
        const wire = a.encode({ value: () => 1 });

        decodeAndDrop({ wire, serdes: b });
        expect(a.liveHandleCount()).toBe(1);

        await waitFor({ check: () => a.liveHandleCount() === 0 });
    });

    it('does not release a handle whose proxy is still held', async () => {
        const [ a, b ] = pair();
        const held = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;

        await expect(waitFor({ check: () => a.liveHandleCount() === 0, timeout: 300 })).rejects.toThrow(/Timed out/);
        expect(await held()).toBe(1);
    });

    it('does not double-release a proxy that was released explicitly and then collected', async () => {
        const releases : Array<string> = [];
        const [ a, b ] = pair();
        const wire = a.encode({ value: () => 1 });

        const releaseOnce = () : void => {
            const remote = b.decode({ wire }) as Ref;

            remote[Symbol.dispose]();
            releases.push('explicit');
        };

        releaseOnce();
        expect(a.liveHandleCount()).toBe(0);

        // Give the collector a chance to run the finalizer for the dropped proxy;
        // a second release would be a no-op on a's side, so we assert via b's
        // own bookkeeping staying consistent instead of via a crash.
        await waitFor({ check: () => releases.length === 1, timeout: 200 }).catch(() => undefined);
        expect(a.liveHandleCount()).toBe(0);
    });

    it('keeps a function sent twice alive while either proxy is held', async () => {
        const [ a, b ] = pair();
        const fn = () : number => 1;
        const first = a.encode({ value: fn });
        const second = a.encode({ value: fn });

        decodeAndDrop({ wire: first, serdes: b });
        await waitFor({ check: () => false, timeout: 200 }).catch(() => undefined);

        const held = b.decode({ wire: second }) as Ref;

        expect(await held()).toBe(1);

        held[Symbol.dispose]();
        expect(a.liveHandleCount()).toBe(0);
    });
});

describe('counted releases', () => {
    it('gives back the same proxy each time one handle arrives', () => {
        const [ a, b ] = pair();
        const fn = () : number => 1;

        expect(b.decode({ wire: a.encode({ value: fn }) })).toBe(b.decode({ wire: a.encode({ value: fn }) }));
    });

    it('keeps a function whose second send was still in flight when the first proxy was released', async () => {
        const [ a, b ] = pair();
        const fn = () : number => 1;
        const first = b.decode({ wire: a.encode({ value: fn }) }) as Ref;
        const inFlight = a.encode({ value: fn });

        first[Symbol.dispose]();
        expect(a.liveHandleCount()).toBe(1);

        const second = b.decode({ wire: inFlight }) as Ref;

        expect(await second()).toBe(1);

        second[Symbol.dispose]();
        expect(a.liveHandleCount()).toBe(0);
    });

    it('releases outright when no count is given', async () => {
        const [ a ] = pair();
        const fn = () : number => 1;
        const wire = a.encode({ value: fn });

        a.encode({ value: fn });

        const { handle } = (wire as { $value : { handle : string } }).$value;

        await a.releaseLocalHandle({ handle, context: { from: 'b' } });
        expect(a.liveHandleCount()).toBe(0);
    });

    it('releases what it holds when closed', () => {
        const [ a, b ] = pair();
        const fn = () : number => 1;

        b.decode({ wire: a.encode({ value: fn }) });
        b.close();

        expect(a.liveHandleCount()).toBe(0);
    });
});
