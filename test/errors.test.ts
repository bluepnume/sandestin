import type { Ref } from '../src';

import { ReleasedError, REMOTE_STACK_SEPARATOR, RemoteError, UnauthorizedError } from '../src';

import { pair } from './helpers';

class CodedError extends Error {
    readonly code : string;

    constructor({ message, code } : { message : string, code : string }) {
        super(message);
        this.name = 'CodedError';
        this.code = code;
    }
}

describe('errors', () => {
    it('a thrown error comes back as a RemoteError with name, message and own properties', async () => {
        const [ a, b ] = pair();

        const remote = b.decode({
            wire: a.encode({
                value: () => {
                    throw new CodedError({ message: 'no stock', code: 'OUT_OF_STOCK' });
                }
            })
        }) as Ref;

        const err = await remote().catch((caught : unknown) => caught) as RemoteError & { code : string };

        expect(err).toBeInstanceOf(RemoteError);
        expect(err.name).toBe('CodedError');
        expect(err.message).toBe('no stock');
        expect(err.code).toBe('OUT_OF_STOCK');
        expect(err.remoteStack).toBeUndefined();
        expect(err.stack).toContain('CodedError: no stock');
    });

    it('carries the cause chain', async () => {
        const [ a, b ] = pair();

        const remote = b.decode({
            wire: a.encode({
                value: () => {
                    throw new Error('outer', { cause: new RangeError('inner') });
                }
            })
        }) as Ref;

        const err = await remote().catch((caught : unknown) => caught) as RemoteError;

        expect(err.cause).toBeInstanceOf(RemoteError);
        expect((err.cause as RemoteError).name).toBe('RangeError');
        expect((err.cause as RemoteError).message).toBe('inner');
    });

    it('leaves stacks behind by default and includes them when asked', async () => {
        const [ a, b ] = pair();
        const [ c, d ] = pair({ includeStacks: true });

        const thrower = () : never => {
            throw new Error('boom');
        };

        const quietRef = b.decode({ wire: a.encode({ value: thrower }) }) as Ref;
        const loudRef = d.decode({ wire: c.encode({ value: thrower }) }) as Ref;
        const quiet = await quietRef().catch((caught : unknown) => caught) as RemoteError;
        const loud = await loudRef().catch((caught : unknown) => caught) as RemoteError;

        expect(quiet.remoteStack).toBeUndefined();
        expect(quiet.stack).not.toContain(REMOTE_STACK_SEPARATOR);

        // With stacks included, `stack` reads remote first, then local,
        // and the raw remote stack is kept on its own.
        expect(loud.remoteStack).toContain('boom');
        expect(loud.stack).toContain(loud.remoteStack);
        expect(loud.stack).toContain(REMOTE_STACK_SEPARATOR);
        expect(loud.stack?.indexOf(REMOTE_STACK_SEPARATOR)).toBeGreaterThan(loud.stack?.indexOf('boom') ?? -1);
    });

    it('a thrown non-Error value is wrapped with the value on cause', async () => {
        const [ a, b ] = pair();

        const remote = b.decode({
            wire: a.encode({
                value: () => {
                    // eslint-disable-next-line no-throw-literal, @typescript-eslint/only-throw-error -- the point of the test
                    throw { code: 42 };
                }
            })
        }) as Ref;

        const err = await remote().catch((caught : unknown) => caught) as RemoteError;

        expect(err).toBeInstanceOf(RemoteError);
        expect(err.cause).toEqual({ code: 42 });
    });

    it('errors inside values round-trip as data, not just as rejections', () => {
        const [ a, b ] = pair();
        const value = { problem: new SyntaxError('bad json'), list: [ new Error('x') ] };
        const result = b.decode({ wire: a.encode({ value }) }) as typeof value;

        expect(result.problem).toBeInstanceOf(RemoteError);
        expect(result.problem.name).toBe('SyntaxError');
        expect(result.list[0]?.message).toBe('x');
    });

    it('errors round-trip through JSON mode too', () => {
        const [ a, b ] = pair();
        const result = b.decodeJSON({ text: a.encodeJSON({ value: new Error(`text`, { cause: `why` }) }) }) as RemoteError;

        expect(result.message).toBe('text');
        expect(result.cause).toBe('why');
    });

    it('the package errors keep their class on the far side', async () => {
        const [ a, b ] = pair();
        const once = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;
        const handle = (a.encode({ value: () => 1 }) as { $value : { handle : string } }).$value.handle;

        await a.releaseLocalHandle({ handle, context: { from: 'b' } });

        const stale = b.decode({ wire: { $type: 'function', $value: { handle, name: 'stale' } } }) as Ref;

        await expect(stale()).rejects.toBeInstanceOf(ReleasedError);
        await expect(once()).resolves.toBe(1);
    });

    it('RemoteError is a normal Error', () => {
        const err = new RemoteError({ name: 'Custom', message: 'msg', properties: { extra: 1 } });

        expect(err).toBeInstanceOf(Error);
        expect(err.name).toBe('Custom');
        expect((err as RemoteError & { extra : number }).extra).toBe(1);
        expect(new ReleasedError({ handle: 'h' }).message).toContain('h');
        expect(new UnauthorizedError({ handle: 'h' }).message).toContain('h');
    });

    it('keeps the message and stack a released error had where it was thrown', async () => {
        const [ a, b ] = pair({ includeStacks: true });
        const stale = b.decode({ wire: a.encode({ value: () => 1 }) }) as Ref;
        const { handle } = (b.encode({ value: stale }) as { $value : { handle : string } }).$value;

        await a.releaseLocalHandle({ handle, context: { from: 'b' } });

        const error = await stale().catch((err : unknown) => err) as ReleasedError;

        expect(error.message).toContain(handle);
        expect(error.stack).toContain(`ReleasedError: Handle ${ handle } has been released`);
        expect(error.remoteStack).toContain(handle);
    });
});
