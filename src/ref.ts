import type { AnyFunction, Ref } from './types';

import { refOptions, refReleasers, revocationListeners, revoked } from './ref-registry';

export type AuthorizeRefOptions<Context> = {
    readonly context : Context,
    // The context the function was encoded under, if any.
    readonly handleContext : Context | undefined,
    readonly args : ReadonlyArray<unknown>,
};

export type RefOptions<Context = unknown> = {
    // Released after its first call; a second call rejects with ReleasedError.
    readonly once ?: boolean,
    // Called when the holder is done with it, by any route: `once`, revoke,
    // explicit release on the far side, or the far side's garbage collector.
    readonly onRelease ?: () => void,
    // Per-function gate, run after the instance-level one, with the decoded
    // arguments in hand.
    readonly authorize ?: (options : AuthorizeRefOptions<Context>) => boolean | Promise<boolean>,
};

export type MarkRefOptions<Fn extends AnyFunction, Context> = RefOptions<Context> & {
    readonly fn : Fn,
};

// Tag a function with lifetime and policy options before encoding it.
// Returns the same function.
export const ref = <Fn extends AnyFunction, Context = unknown>(
    { fn, ...options } : MarkRefOptions<Fn, Context>
) : Fn => {
    refOptions.set(fn, options);

    return fn;
};

// Owner-side: every handle pointing at this function stops working, now and
// for any future encode of it.
type RevokeOptions = { readonly fn : AnyFunction };

export const revoke = ({ fn } : RevokeOptions) : void => {
    revoked.add(fn);

    for (const listener of revocationListeners.get(fn) ?? []) {
        listener();
    }

    revocationListeners.delete(fn);
};

// Holder-side: is this a function the other side owns?
export const isRef = (value : unknown) : value is Ref =>
    typeof value === 'function' && refReleasers.has(value as AnyFunction);

// Holder-side: done with this ref. Idempotent. `using` does the same thing.
type ReleaseOptions = { readonly ref : Ref };

export const release = ({ ref: proxy } : ReleaseOptions) : void => {
    refReleasers.get(proxy)?.();
};
