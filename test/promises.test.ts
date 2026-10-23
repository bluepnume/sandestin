import type { Remote } from '../src';

import { ReleasedError, RemoteError } from '../src';

import { pair } from './helpers';

type Deferred = {
    readonly promise : Promise<string>,
    readonly resolve : (value : string) => void,
};

const defer = () : Deferred => {
    let resolveLater : (value : string) => void = () => undefined;

    const promise = new Promise<string>(resolve => {
        resolveLater = resolve;
    });

    return { promise, resolve: resolveLater };
};

describe('promises cross as handles', () => {
    it('a pending promise resolves on the far side when it resolves here', async () => {
        const [ a, b ] = pair();
        const deferred = defer();
        const wire = a.encode({ value: { promise: deferred.promise } });
        const remote = b.decode({ wire }) as { promise : Promise<string> };

        expect(remote.promise).toBeInstanceOf(Promise);
        expect(a.liveHandleCount()).toBe(1);

        deferred.resolve('later');
        expect(await remote.promise).toBe('later');
        expect(a.liveHandleCount()).toBe(0);
    });

    it('an already settled promise still arrives as a promise', async () => {
        const [ a, b ] = pair();
        const remote = b.decode<Promise<unknown>>({ wire: a.encode({ value: Promise.resolve({ list: [ 1 ] }) }) });

        expect(remote).toBeInstanceOf(Promise);
        expect(await remote).toEqual({ list: [ 1 ] });
    });

    it('a rejection arrives as a RemoteError with the original name and message', async () => {
        const [ a, b ] = pair();
        const failure = new TypeError('bad input');
        const remote = b.decode<Promise<unknown>>({ wire: a.encode({ value: Promise.reject(failure) }) });

        await expect(remote).rejects.toBeInstanceOf(RemoteError);
        await expect(remote).rejects.toMatchObject({ name: 'TypeError', message: 'bad input' });
    });

    it('a non-Error rejection reason is wrapped, with the raw value on cause', async () => {
        const [ a, b ] = pair();
        // eslint-disable-next-line prefer-promise-reject-errors, @typescript-eslint/prefer-promise-reject-errors -- the point of the test
        const rejected = Promise.reject('nope');
        const remote = b.decode<Promise<unknown>>({ wire: a.encode({ value: rejected }) });

        await expect(remote).rejects.toBeInstanceOf(RemoteError);
        await expect(remote).rejects.toMatchObject({ message: 'nope', cause: 'nope' });
    });

    it('resolved values can carry functions and promises of their own', async () => {
        const [ a, b ] = pair();
        const value = Promise.resolve({ greet: (name : string) => `hi ${ name }`, later: Promise.resolve('eventually') });
        const remote = b.decode({ wire: a.encode({ value }) }) as Promise<Remote<Awaited<typeof value>>>;
        const resolved = await remote;

        expect(await resolved.greet('x')).toBe('hi x');
        expect(await resolved.later).toBe('eventually');
    });

    it('the same promise encodes to the same handle', () => {
        const [ a ] = pair();
        const promise = Promise.resolve(1);
        const wire = a.encode({ value: [ promise, promise ] }) as Array<{ $value : string }>;

        expect(wire[0]?.$value).toBe(wire[1]?.$value);
        expect(a.liveHandleCount()).toBe(1);
    });

    it('watching an unknown or non-promise handle is refused', async () => {
        const [ a ] = pair();
        const fnHandle = (a.encode({ value: () => 1 }) as { $value : { handle : string } }).$value.handle;

        await expect(a.watchLocalPromise({ handle: 'nope', context: { from: 'b' } }))
            .rejects.toBeInstanceOf(ReleasedError);

        await expect(a.watchLocalPromise({ handle: fnHandle, context: { from: 'b' } }))
            .rejects.toBeInstanceOf(ReleasedError);
    });

    it('a promise released before settlement delivers nothing and leaks nothing', async () => {
        const [ a, b ] = pair();
        const deferred = defer();
        const handle = (a.encode({ value: deferred.promise }) as { $value : string }).$value;

        await a.releaseLocalHandle({ handle, context: { from: 'b' } });
        expect(a.liveHandleCount()).toBe(0);

        deferred.resolve('too late');
        await deferred.promise;
        expect(a.liveHandleCount()).toBe(0);
        expect(b.liveHandleCount()).toBe(0);
    });

    it('promises in JSON mode work the same way', async () => {
        const [ a, b ] = pair();
        const text = a.encodeJSON({ value: { p: Promise.resolve(7) } });
        const remote = b.decodeJSON({ text }) as { p : Promise<number> };

        expect(await remote.p).toBe(7);
    });
});

describe('a remote promise sent back to its owner', () => {
    it('decodes as the original promise', async () => {
        const [ a, b ] = pair();
        const original = Promise.resolve('home');
        const remote = b.decode<Promise<string>>({ wire: a.encode({ value: original }) });
        const returned = a.decode<Promise<string>>({ wire: b.encode({ value: remote }) });

        expect(returned).toBe(original);
        expect(await returned).toBe('home');
    });

    it('is a rejected stand-in once the owner has let go of it', async () => {
        const [ a, b ] = pair();
        const remote = b.decode<Promise<string>>({ wire: a.encode({ value: Promise.resolve('gone') }) });

        expect(await remote).toBe('gone');
        expect(a.liveHandleCount()).toBe(0);

        const returned = a.decode<Promise<string>>({ wire: b.encode({ value: remote }) });

        await expect(returned).rejects.toBeInstanceOf(ReleasedError);
    });
});
