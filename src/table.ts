import type { RefOptions } from './ref';
import type { AnyFunction, Handle, Outcome } from './types';

import { ReleasedError } from './errors';
import { getRefOptions, isRevoked, onRevoke } from './ref-registry';

type FunctionEntry<Context> = {
    readonly kind : 'function',
    readonly fn : AnyFunction,
    readonly options : RefOptions<Context>,
};

type PromiseEntry = {
    readonly kind : 'promise',
    readonly promise : Promise<unknown>,
    outcome : Outcome | undefined,
    readonly listeners : Array<(outcome : Outcome) => void>,
};

type TableEntry<Context> = FunctionEntry<Context> | PromiseEntry;

type WatchOptions = {
    readonly handle : Handle,
    readonly listener : (outcome : Outcome) => void,
};

type RegisteredPromise = {
    readonly handle : Handle,
    readonly fresh : boolean,
};

type SettleOptions = {
    readonly handle : Handle,
    readonly outcome : Outcome,
};

// The owner side of a connection: everything this side has handed across and
// still has to honour. One per Serdes instance; handles are random so holding
// one is the only way to name what it points at.
type Table<Context> = {
    readonly registerFunction : (options : { readonly fn : AnyFunction }) => Handle,
    // Returns the handle and whether it is new, so the caller can start
    // watching the promise exactly once.
    readonly registerPromise : (options : { readonly promise : Promise<unknown> }) => RegisteredPromise,
    readonly get : (options : { readonly handle : Handle }) => TableEntry<Context> | undefined,
    readonly release : (options : { readonly handle : Handle }) => void,
    // The other side wants the outcome; delivered now if known, else when known.
    readonly watch : (options : WatchOptions) => void,
    // The promise settled; delivered to every watcher, now or when one arrives.
    readonly settle : (options : SettleOptions) => void,
    readonly size : () => number,
    readonly close : () => void,
};

export const createTable = <Context>() : Table<Context> => {
    const entries = new Map<Handle, TableEntry<Context>>();
    const handlesByTarget = new WeakMap<object, Handle>();

    const release = ({ handle } : { readonly handle : Handle }) : void => {
        const entry = entries.get(handle);

        if (!entry) {
            return;
        }

        entries.delete(handle);

        if (entry.kind === 'function') {
            handlesByTarget.delete(entry.fn);
            entry.options.onRelease?.();
        } else {
            handlesByTarget.delete(entry.promise);
        }
    };

    const registerFunction = ({ fn } : { readonly fn : AnyFunction }) : Handle => {
        const existing = handlesByTarget.get(fn);

        if (existing !== undefined) {
            return existing;
        }

        const handle = crypto.randomUUID();

        entries.set(handle, { kind: 'function', fn, options: getRefOptions({ fn }) as RefOptions<Context> });
        handlesByTarget.set(fn, handle);
        onRevoke({ fn, listener: () => release({ handle }) });

        if (isRevoked({ fn })) {
            release({ handle });
        }

        return handle;
    };

    const deliver = ({ handle, entry } : { readonly handle : Handle, readonly entry : PromiseEntry }) : void => {
        if (entry.outcome === undefined || entry.listeners.length === 0) {
            return;
        }

        for (const listener of entry.listeners) {
            listener(entry.outcome);
        }

        release({ handle });
    };

    const registerPromise = ({ promise } : { readonly promise : Promise<unknown> }) : RegisteredPromise => {
        const existing = handlesByTarget.get(promise);

        if (existing !== undefined) {
            return { handle: existing, fresh: false };
        }

        const handle = crypto.randomUUID();

        entries.set(handle, { kind: 'promise', promise, outcome: undefined, listeners: [] });
        handlesByTarget.set(promise, handle);

        return { handle, fresh: true };
    };

    const watch = ({ handle, listener } : WatchOptions) : void => {
        const entry = entries.get(handle);

        if (entry?.kind !== 'promise') {
            throw new ReleasedError({ handle });
        }

        entry.listeners.push(listener);
        deliver({ handle, entry });
    };

    const settle = ({ handle, outcome } : SettleOptions) : void => {
        const entry = entries.get(handle);

        if (entry?.kind !== 'promise') {
            return;
        }

        entry.outcome = outcome;
        deliver({ handle, entry });
    };

    return {
        registerFunction,
        registerPromise,
        get:  ({ handle }) => entries.get(handle),
        release,
        watch,
        settle,
        size: () => entries.size,

        close: () => {
            for (const handle of entries.keys()) {
                release({ handle });
            }
        }
    };
};
