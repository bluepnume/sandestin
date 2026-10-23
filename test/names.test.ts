import { release, ReleasedError, UnauthorizedError } from '../src';

import { pair } from './helpers';

describe('function names', () => {
    it('travel with the function and land on the ref', () => {
        const [ a, b ] = pair();
        const logout = () : string => 'bye';
        const api = { logout, anonymous: () => 1 };
        const remote = b.decode<typeof api>({ wire: a.encode({ value: api }) });

        expect(remote.logout.name).toBe('logout');
        expect(remote.anonymous.name).toBe('anonymous');
    });

    it('appear in the error when a released function is called', async () => {
        const [ a, b ] = pair();
        const logout = () : string => 'bye';
        const remote = b.decode<typeof logout>({ wire: a.encode({ value: logout }) });

        release({ ref: remote });

        const err = await remote().catch((caught : unknown) => caught) as ReleasedError;

        expect(err).toBeInstanceOf(ReleasedError);
        expect(err.message).toMatch(/^Function logout \([0-9a-f-]{36}\) has been released$/);
    });

    it('appear in the error when the gate refuses a function', async () => {
        const [ a, b ] = pair({ authorizeInboundRequest: () => false });
        const checkout = () : string => 'paid';
        const remote = b.decode<typeof checkout>({ wire: a.encode({ value: checkout }) });

        const err = await remote().catch((caught : unknown) => caught) as UnauthorizedError;

        expect(err).toBeInstanceOf(UnauthorizedError);
        expect(err.message).toMatch(/^Not authorized to use Function checkout/);
    });

    it('fall back to the handle when there is no name', () => {
        expect(new ReleasedError({ handle: 'h1' }).message).toBe('Handle h1 has been released');
        expect(new UnauthorizedError({ handle: 'h1', name: '' }).message).toBe('Not authorized to use Handle h1');
    });

    it('a ref without a known name still works when decoded from a bare record', async () => {
        const [ a, b ] = pair();
        const handle = (a.encode({ value: () => 7 }) as { $value : { handle : string } }).$value.handle;
        const remote = b.decode<() => number>({ wire: { $type: 'function', $value: { handle, name: '' } } });

        expect(await remote()).toBe(7);
        expect(remote.name).toBe('');
    });

    it('are not confused with refs for isRef and friends', () => {
        const [ a, b ] = pair();
        const remote = b.decode<() => number>({ wire: a.encode({ value: () => 7 }) });

        expect(typeof remote).toBe('function');
        expect(remote).toHaveProperty('invoke');
    });
});

describe('decode<T>', () => {
    it('types the result as Remote<T> without a cast', async () => {
        const [ a, b ] = pair();
        const api = { greet: (name : string) : string => `hi ${ name }`, count: 3, later: Promise.resolve('x') };
        const remote = b.decode<typeof api>({ wire: a.encode({ value: api }) });

        const greeting : string = await remote.greet('you');
        const count : number = remote.count;
        const later : string = await remote.later;

        expect([ greeting, count, later ]).toEqual([ 'hi you', 3, 'x' ]);
    });

    it('is unknown with no type argument', () => {
        const [ a, b ] = pair();
        const result : unknown = b.decode({ wire: a.encode({ value: 1 }) });

        expect(result).toBe(1);
    });
});
