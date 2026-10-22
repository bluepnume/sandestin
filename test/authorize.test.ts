import type { Ref } from '../src';

import { ref, ReleasedError, UnauthorizedError } from '../src';

import type { PairContext } from './helpers';

import { pair } from './helpers';

describe('authorizeInboundRequest', () => {
    it('allows everything when absent', async () => {
        const [ a, b ] = pair();
        const remote = b.decode({ wire: a.encode({ value: () => 'ok' }) }) as Ref;

        expect(await remote()).toBe('ok');
    });

    it('sees the handle, the context the transport attached, and the target', async () => {
        const seen : Array<{ handle : string, context : PairContext, target : unknown }> = [];
        const fn = () : number => 1;

        const [ a, b ] = pair({
            authorizeInboundRequest: options => {
                seen.push(options);

                return true;
            }
        });

        const wire = a.encode({ value: fn }) as { $value : string };

        await (b.decode({ wire }) as Ref)();

        expect(seen).toEqual([ { handle: wire.$value, context: { from: 'b' }, target: fn } ]);
    });

    it('refuses calls with UnauthorizedError when it returns false', async () => {
        const [ a, b ] = pair({ authorizeInboundRequest: ({ context }) => (context.from as string) === 'nobody' });
        const remote = b.decode({ wire: a.encode({ value: () => 'secret' }) }) as Ref;

        await expect(remote()).rejects.toBeInstanceOf(UnauthorizedError);
        expect(a.liveHandleCount()).toBe(1);
    });

    it('may be async', async () => {
        const [ a, b ] = pair({ authorizeInboundRequest: () => Promise.resolve(false) });
        const remote = b.decode({ wire: a.encode({ value: () => 'secret' }) }) as Ref;

        await expect(remote()).rejects.toBeInstanceOf(UnauthorizedError);
    });

    it('gates releases and promise watches too', async () => {
        const [ a, b ] = pair({ authorizeInboundRequest: () => false });
        const fnHandle = (a.encode({ value: () => 1 }) as { $value : string }).$value;
        const promiseHandle = (a.encode({ value: Promise.resolve(1) }) as { $value : string }).$value;

        await expect(a.releaseLocalHandle({ handle: fnHandle, context: { from: `b` } })).rejects.toBeInstanceOf(UnauthorizedError);
        expect(a.liveHandleCount()).toBe(2);

        await expect(a.watchLocalPromise({ handle: promiseHandle, listener: () => undefined, context: { from: 'b' } }))
            .rejects.toBeInstanceOf(UnauthorizedError);

        // The decoder on b still gets a promise; it just never settles.
        const pending = b.decode({ wire: { $type: 'promise', $value: promiseHandle } }) as Promise<unknown>;

        expect(pending).toBeInstanceOf(Promise);
    });

    it('a released handle reports ReleasedError before the gate is consulted', async () => {
        let consulted = 0;

        const [ a ] = pair({
            authorizeInboundRequest: () => {
                consulted += 1;

                return true;
            }
        });

        await expect(a.invokeLocalFunction({ handle: 'nope', args: [], context: { from: 'b' } }))
            .resolves.toMatchObject({ ok: false });

        expect(consulted).toBe(0);
    });
});

describe('per-function authorize', () => {
    it('runs after the instance gate with the decoded arguments', async () => {
        const [ a, b ] = pair();
        const seen : Array<unknown> = [];

        const guarded = ref<(amount : number) => string, PairContext>({
            fn: amount => `paid ${ amount }`,

            authorize: ({ context, args }) => {
                seen.push({ context, args });

                return (args[0] as number) < 100;
            }
        });

        const remote = b.decode({ wire: a.encode({ value: guarded }) }) as Ref;

        expect(await remote(50)).toBe('paid 50');
        await expect(remote(500)).rejects.toBeInstanceOf(UnauthorizedError);

        expect(seen).toEqual([
            { context: { from: 'b' }, args: [ 50 ] },
            { context: { from: 'b' }, args: [ 500 ] }
        ]);
    });

    it('may be async, and an exception counts as a refusal', async () => {
        const [ a, b ] = pair();
        const slow = ref({ fn: () => 1, authorize: () => Promise.resolve(false) });

        const angry = ref({
            fn: () => 1,

            authorize: () => {
                throw new Error('no');
            }
        });

        const remote = b.decode({ wire: a.encode({ value: { slow, angry } }) }) as { slow : Ref, angry : Ref };

        await expect(remote.slow()).rejects.toBeInstanceOf(UnauthorizedError);
        await expect(remote.angry()).rejects.toMatchObject({ message: 'no' });
    });

    it('the instance gate wins when both are present', async () => {
        let perFunctionRan = false;
        const [ a, b ] = pair({ authorizeInboundRequest: () => false });

        const guarded = ref({
            fn: () => 1,

            authorize: () => {
                perFunctionRan = true;

                return true;
            }
        });

        const remote = b.decode({ wire: a.encode({ value: guarded }) }) as Ref;

        await expect(remote()).rejects.toBeInstanceOf(UnauthorizedError);
        expect(perFunctionRan).toBe(false);
    });

    it('does not consume a once function when it refuses', async () => {
        const [ a, b ] = pair();
        let allow = false;
        const fn = ref({ fn: () => 'went', once: true, authorize: () => allow });
        const remote = b.decode({ wire: a.encode({ value: fn }) }) as Ref;

        await expect(remote()).rejects.toBeInstanceOf(UnauthorizedError);
        allow = true;
        expect(await remote()).toBe('went');
        await expect(remote()).rejects.toBeInstanceOf(ReleasedError);
    });
});
