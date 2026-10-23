import type { HandleGroup } from './codec';
import type { RefOptions } from './ref';
import type { AnyFunction, Handle, Outcome } from './types';

import { ReleasedError } from './errors';
import { getRefOptions, isRevoked, onRevoke } from './ref-registry';

type FunctionEntry<Context> = {
    readonly kind : 'function',
    readonly fn : AnyFunction,
    readonly options : RefOptions<Context>,
    // The context it was encoded under: who it was handed to.
    readonly context : Context | undefined,
    // How many times it has been sent and not yet released.
    sent : number,
};

type PromiseEntry<Context> = {
    readonly kind : 'promise',
    // What was encoded: a native promise or any thenable.
    readonly target : object,
    // The same, adopted into a native promise.
    readonly promise : Promise<unknown>,
    readonly context : Context | undefined,
    outcome : Outcome | undefined,
    readonly listeners : Array<(outcome : Outcome) => void>,
};

type TableEntry<Context> = FunctionEntry<Context> | PromiseEntry<Context>;

type ReleaseOptions = {
    readonly handle : Handle,
    readonly count ?: number,
};

type WatchOptions = {
    readonly handle : Handle,
    readonly listener : (outcome : Outcome) => void,
};

type RegisteredPromise = {
    readonly handle : Handle,
    readonly fresh : boolean,
};

type RegisterFunctionOptions<Context> = {
    readonly fn : AnyFunction,
    readonly context : Context | undefined,
};

type RegisterPromiseOptions<Context> = {
    readonly promise : object,
    readonly context : Context | undefined,
};

type SettleOptions = {
    readonly handle : Handle,
    readonly outcome : Outcome,
};

// A custom-type value's handles, released as a group: the owner hears once
// when the last of them goes.
type Group = {
    readonly pending : Set<Handle>,
    readonly release : () => void,
};

// The owner side of a connection: everything this side has handed across and
// still has to honour. One per instance; handles are random so holding one
// is the only way to name what it points at.
type Table<Context> = {
    readonly registerFunction : (options : RegisterFunctionOptions<Context>) => Handle,
    // Returns the handle and whether it is new, so the caller can start
    // watching the promise exactly once.
    readonly registerPromise : (options : RegisterPromiseOptions<Context>) => RegisteredPromise,
    readonly registerGroup : (group : HandleGroup) => void,
    readonly get : (options : { readonly handle : Handle }) => TableEntry<Context> | undefined,
    readonly release : (options : ReleaseOptions) => void,
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
    const groupsByHandle = new Map<Handle, Set<Group>>();

    const releaseFromGroups = ({ handle } : { readonly handle : Handle }) : void => {
        for (const group of groupsByHandle.get(handle) ?? []) {
            group.pending.delete(handle);

            if (group.pending.size === 0) {
                group.release();
            }
        }

        groupsByHandle.delete(handle);
    };

    // With a count, only that many sends of a function are released, and it
    // stays while any other send is still out.
    const release = ({ handle, count } : ReleaseOptions) : void => {
        const entry = entries.get(handle);

        if (!entry) {
            return;
        }

        if (count !== undefined && entry.kind === 'function') {
            entry.sent -= count;

            if (entry.sent > 0) {
                return;
            }
        }

        entries.delete(handle);

        if (entry.kind === 'function') {
            handlesByTarget.delete(entry.fn);
            entry.options.onRelease?.();
        } else {
            handlesByTarget.delete(entry.target);
        }

        releaseFromGroups({ handle });
    };

    const registerFunction = ({ fn, context } : RegisterFunctionOptions<Context>) : Handle => {
        const existing = handlesByTarget.get(fn);

        const existingEntry = existing === undefined
            ? undefined
            : entries.get(existing);

        if (existing !== undefined && existingEntry?.kind === 'function') {
            existingEntry.sent += 1;

            return existing;
        }

        const handle = crypto.randomUUID();

        const options = getRefOptions({ fn }) as RefOptions<Context>;

        entries.set(handle, { kind: 'function', fn, options, context, sent: 1 });
        handlesByTarget.set(fn, handle);
        onRevoke({ fn, listener: () => release({ handle }) });

        if (isRevoked({ fn })) {
            release({ handle });
        }

        return handle;
    };

    type DeliverOptions = { readonly handle : Handle, readonly entry : PromiseEntry<Context> };

    const deliver = ({ handle, entry } : DeliverOptions) : void => {
        if (entry.outcome === undefined || entry.listeners.length === 0) {
            return;
        }

        for (const listener of entry.listeners) {
            listener(entry.outcome);
        }

        release({ handle });
    };

    const registerPromise = ({ promise: target, context } : RegisterPromiseOptions<Context>) : RegisteredPromise => {
        const existing = handlesByTarget.get(target);

        if (existing !== undefined) {
            return { handle: existing, fresh: false };
        }

        const handle = crypto.randomUUID();
        const promise = Promise.resolve(target as PromiseLike<unknown>);

        entries.set(handle, { kind: 'promise', target, promise, context, outcome: undefined, listeners: [] });
        handlesByTarget.set(target, handle);

        return { handle, fresh: true };
    };

    const registerGroup = ({ handles, release: releaseGroup } : HandleGroup) : void => {
        const live = handles.filter(handle => entries.has(handle));

        if (live.length === 0) {
            releaseGroup();

            return;
        }

        const group : Group = { pending: new Set(live), release: releaseGroup };

        for (const handle of live) {
            const groups = groupsByHandle.get(handle) ?? new Set();

            groups.add(group);
            groupsByHandle.set(handle, groups);
        }
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
        registerGroup,
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
