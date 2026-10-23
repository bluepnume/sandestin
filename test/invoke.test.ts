import type { InvokeRemoteFunctionOptions } from '../src';

import { pair } from './helpers';

describe('ref.invoke', () => {
    it('is the plain call with named arguments', async () => {
        const [ a, b ] = pair();
        const add = ({ x, y } : { x : number, y : number }) : number => x + y;
        const remote = b.decode<typeof add>({ wire: a.encode({ value: add }) });

        expect(await remote.invoke({ args: [ { x: 1, y: 2 } ] })).toBe(3);
        expect(await remote({ x: 2, y: 2 })).toBe(4);
    });

    it('rejects with the abort reason when the signal fires mid-call', async () => {
        const [ a, b ] = pair();

        const slow = () : Promise<string> => new Promise(resolve => {
            setTimeout(() => resolve('late'), 50);
        });

        const remote = b.decode<typeof slow>({ wire: a.encode({ value: slow }) });
        const controller = new AbortController();
        const pending = remote.invoke({ args: [], signal: controller.signal });

        controller.abort(new Error('changed my mind'));

        await expect(pending).rejects.toThrow('changed my mind');
    });

    it('rejects immediately on an already aborted signal without calling across', async () => {
        const [ a, b ] = pair();
        let calls = 0;

        const remote = b.decode<() => number>({
            wire: a.encode({
                value: () => {
                    calls += 1;

                    return calls;
                }
            })
        });

        await expect(remote.invoke({ args: [], signal: AbortSignal.abort() })).rejects.toThrow();
        expect(calls).toBe(0);
    });

    it('wraps a non-Error abort reason', async () => {
        const [ a, b ] = pair();
        const remote = b.decode<() => number>({ wire: a.encode({ value: () => 1 }) });
        const controller = new AbortController();
        const pending = remote.invoke({ args: [], signal: controller.signal });

        controller.abort('because');

        await expect(pending).rejects.toMatchObject({ message: 'because' });
    });

    it('times out with a TimeoutError from the signal', async () => {
        const [ a, b ] = pair();

        const never = () : Promise<never> => new Promise(() => {
            // never settles
        });

        const remote = b.decode<typeof never>({ wire: a.encode({ value: never }) });

        await expect(remote.invoke({ args: [], signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ name: `TimeoutError` });
    });

    it('applies the instance callTimeout to plain calls', async () => {
        const [ a, b ] = pair({ callTimeout: 20 });

        const never = () : Promise<never> => new Promise(() => {
            // never settles
        });

        const quick = () : string => 'done';
        const wire = a.encode({ value: { never, quick } });
        const remote = b.decode<{ never : typeof never, quick : typeof quick }>({ wire });

        await expect(remote.never()).rejects.toMatchObject({ name: 'TimeoutError' });
        expect(await remote.quick()).toBe('done');
    });

    it('combines the instance timeout with a per-call signal', async () => {
        const [ a, b ] = pair({ callTimeout: 10_000 });

        const never = () : Promise<never> => new Promise(() => {
            // never settles
        });

        const remote = b.decode<typeof never>({ wire: a.encode({ value: never }) });
        const controller = new AbortController();
        const pending = remote.invoke({ args: [], signal: controller.signal });

        controller.abort(new Error('mine first'));

        await expect(pending).rejects.toThrow('mine first');
    });

    it('hands the signal to the transport hook', async () => {
        const seen : Array<InvokeRemoteFunctionOptions> = [];
        const [ a ] = pair();

        // Wrap b's hook by decoding through a third instance whose hook we own.
        const { sandestin } = await import('../src');

        const spy = sandestin({
            invokeRemoteFunction: options => {
                seen.push(options);

                return a.invokeLocalFunction({ handle: options.handle, args: options.args, context: { from: 'b' } });
            },

            releaseRemoteHandle: () => undefined,
            watchRemotePromise:  () => undefined
        });

        const remote = spy.decode<() => number>({ wire: a.encode({ value: () => 5 }) });
        const controller = new AbortController();

        expect(await remote.invoke({ args: [], signal: controller.signal })).toBe(5);
        expect(await remote()).toBe(5);
        expect(seen[0]?.signal).toBe(controller.signal);
        expect(seen[1]?.signal).toBeUndefined();
    });

    it('a released ref rejects from invoke as well', async () => {
        const [ a, b ] = pair();
        const remote = b.decode<() => number>({ wire: a.encode({ value: () => 1 }) });

        remote[Symbol.dispose]();

        await expect(remote.invoke({ args: [] })).rejects.toMatchObject({ name: 'ReleasedError' });
    });
});
