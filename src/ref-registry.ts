// The owner- and holder-side bookkeeping behind `ref`, `revoke`, `release`
// and `isRef`. Internal: used by the table and the serdes instance, not
// exported from the package.
import type { RefOptions } from './ref';
import type { AnyFunction } from './types';

// Owner-side options live in a WeakMap keyed by the function itself, so
// `ref` returns the function unchanged and composes with anything.
export const refOptions = new WeakMap<AnyFunction, RefOptions<never>>();

// Owner-side revocations: functions whose every handle must stop working,
// and who wants to hear about it.
export const revoked = new WeakSet<AnyFunction>();

export const revocationListeners = new WeakMap<AnyFunction, Set<() => void>>();

// Holder-side: the proxies `decode` produced, and how to release each one.
export const refReleasers = new WeakMap<AnyFunction, () => void>();

type FunctionOptions = {
    readonly fn : AnyFunction,
};

export const getRefOptions = ({ fn } : FunctionOptions) : RefOptions<never> =>
    refOptions.get(fn) ?? {};

export const isRevoked = ({ fn } : FunctionOptions) : boolean => revoked.has(fn);

type OnRevokeOptions = {
    readonly fn : AnyFunction,
    readonly listener : () => void,
};

// Lets a table learn when a function it holds is revoked.
export const onRevoke = ({ fn, listener } : OnRevokeOptions) : void => {
    const listeners = revocationListeners.get(fn) ?? new Set();

    listeners.add(listener);
    revocationListeners.set(fn, listeners);
};

type RegisterRefOptions = {
    readonly proxy : AnyFunction,
    readonly releaser : () => void,
};

export const registerRef = ({ proxy, releaser } : RegisterRefOptions) : void => {
    refReleasers.set(proxy, releaser);
};
