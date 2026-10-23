import type { CustomType } from './custom-types';
import type { EncodedFunction, EncodedReturned } from './records';
import type {
    Encode, Encoded, Handle, InvokeOptions, Outcome,
    Ref, Remote, Sandestin, SandestinOptions, TransferableEncoded
} from './types';

import { decodeWalk, encodeWalk } from './codec';
import { validateCustomTypes } from './custom-types';
import { ReleasedError, RemoteError, UnauthorizedError } from './errors';
import { registerRef } from './ref-registry';
import { createTable } from './table';

type AuthorizeOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context,
};

type EncodeInOptions<Context> = {
    readonly value : unknown,
    readonly transferable : boolean,
    readonly context : Context | undefined,
};

type DecodeInOptions<Context> = {
    readonly wire : Encoded,
    readonly context : Context | undefined,
};

type SettleOptions<Context> = {
    readonly outcome : Outcome,
    readonly context : Context | undefined,
};

// Where a ref or remote promise came from: the handle it names on the other
// side and the context it was decoded under.
type Holding<Context> = {
    readonly handle : Handle,
    readonly context : Context | undefined,
};

type Core<Context> = {
    readonly encodeIn : (options : EncodeInOptions<Context>) => TransferableEncoded,
    readonly decodeIn : (options : DecodeInOptions<Context>) => unknown,
    readonly settle : (options : SettleOptions<Context>) => unknown,
    readonly createRef : (options : EncodedFunction & { readonly context : Context | undefined }) => Ref,
    readonly createRemotePromise : (options : Holding<Context>) => Promise<unknown>,
    readonly original : (options : EncodedReturned) => unknown,
    readonly trackPromise : (options : Holding<Context> & { readonly promise : Promise<unknown> }) => void,
};

const asError = (err : unknown) : Error => (err instanceof Error
    ? err
    : new Error(String(err)));

// Runs `step` now and reports its result as a promise, without deferring the
// synchronous part to a microtask the way an `async` wrapper would.
const settled = <Result>(step : () => Result | Promise<Result>) : Promise<Awaited<Result>> => {
    try {
        return Promise.resolve(step());
    } catch (err) {
        return Promise.reject(asError(err));
    }
};

// A signal's reason as an Error, which it already is for timeouts and
// plain aborts; anything else is wrapped so a catch always sees one.
type AbortReasonOptions = { readonly signal : AbortSignal };

const abortReason = ({ signal } : AbortReasonOptions) : Error => asError(signal.reason);

// Rejects as soon as `signal` fires, otherwise settles with `promise`.
type AbortableOptions<Result> = {
    readonly promise : Promise<Result>,
    readonly signal : AbortSignal | undefined,
};

const abortable = <Result>({ promise, signal } : AbortableOptions<Result>) : Promise<Result> => {
    if (!signal) {
        return promise;
    }

    if (signal.aborted) {
        return Promise.reject(abortReason({ signal }));
    }

    return new Promise((resolve, reject) => {
        const onAbort = () : void => reject(abortReason({ signal }));

        signal.addEventListener('abort', onAbort, { once: true });

        promise.then(resolve, reject).finally(() => signal.removeEventListener(`abort`, onAbort)).catch(() => undefined);
    });
};

export const sandestin = <Context = unknown>({
    invokeRemoteFunction,
    releaseRemoteHandle,
    watchRemotePromise,
    authorizeInboundRequest = () => true,
    types = [],
    includeStacks = false
} : SandestinOptions<Context>) : Sandestin<Context> => {
    // The option is typed loosely so any CustomType<Value, Wire> fits; the
    // codec works with the erased form.
    const customTypes = types as unknown as ReadonlyArray<CustomType>;

    validateCustomTypes({ types: customTypes });

    const table = createTable<Context>();

    // Holder side: handles this side has been given, and how to let go of each.
    const heldReleasers = new Map<Handle, () => void>();

    // Holder side: the refs and remote promises this instance has made, with
    // the handle and context each came from. Sending one back names that
    // handle; calling one carries that context.
    const holdings = new WeakMap<object, Holding<Context>>();
    const releasedHandles = new Set<Handle>();

    // The garbage-collection net: a proxy nobody references any more releases
    // its handle on the far side, if nothing released it explicitly first.
    const finalization = new FinalizationRegistry<Holding<Context>>(({ handle, context }) => {
        if (releasedHandles.has(handle)) {
            releasedHandles.delete(handle);
        } else {
            heldReleasers.delete(handle);
            releaseRemoteHandle({ handle, context });
        }
    });

    let closed = false;

    // The pieces that refer to each other, kept on one object so each can
    // reach the others without ordering games.
    const core : Core<Context> = {
        encodeIn: ({ value, transferable, context }) => encodeWalk({
            value,
            context,
            includeStacks,
            types:      customTypes,
            transferable,
            onFunction: ({ fn }) => table.registerFunction({ fn, context }),
            onGroup:    group => table.registerGroup(group),
            homeHandle: ({ target }) => holdings.get(target)?.handle,

            onPromise: ({ promise }) => {
                const { handle, fresh } = table.registerPromise({ promise, context });

                if (fresh) {
                    const entry = table.get({ handle });

                    if (entry?.kind === 'promise') {
                        core.trackPromise({ handle, promise: entry.promise, context });
                    }
                }

                return handle;
            }
        }),

        decodeIn: ({ wire, context }) => decodeWalk({
            wire,
            context,
            types:      customTypes,
            onFunction: ({ handle, name }) => core.createRef({ handle, name, context }),
            onPromise:  ({ handle }) => core.createRemotePromise({ handle, context }),
            onReturned: ({ kind, handle }) => core.original({ kind, handle })
        }),

        // The other side sent back something it got from here: hand back the
        // very thing that was sent, or, if it has since been released, a
        // stand-in that says so.
        original: ({ kind, handle }) => {
            const entry = table.get({ handle });

            if (kind === 'function' && entry?.kind === 'function') {
                return entry.fn;
            }

            if (kind === 'promise' && entry?.kind === 'promise') {
                return entry.target;
            }

            const error = new ReleasedError({ handle });

            if (kind === 'function') {
                return () => Promise.reject(error);
            }

            const rejected = Promise.reject(error);

            // Already handled, so holding it without looking is not an
            // unhandled rejection; awaiting it still throws.
            rejected.catch(() => undefined);

            return rejected;
        },

        // What a ref or a remote promise does with an outcome.
        settle: ({ outcome, context }) => {
            if (outcome.ok) {
                return core.decodeIn({ wire: outcome.value, context });
            }

            const error = core.decodeIn({ wire: outcome.error, context });

            throw error instanceof Error
                ? error
                : new RemoteError({ name: 'Error', message: String(error), cause: error });
        },

        createRef: ({ handle, name, context }) => {
            let released = false;

            const releaser = () : void => {
                if (released) {
                    return;
                }

                released = true;
                releasedHandles.add(handle);
                heldReleasers.delete(handle);
                releaseRemoteHandle({ handle, context });
            };

            const invoke = async (
                { args, signal, reply = true } : InvokeOptions<ReadonlyArray<unknown>>
            ) : Promise<unknown> => {
                if (released) {
                    throw new ReleasedError({ handle, name });
                }

                const encodedArgs = core.encodeIn({ value: args, transferable: false, context }).wire;

                if (signal?.aborted) {
                    throw abortReason({ signal });
                }

                const outcome = await abortable({
                    promise: invokeRemoteFunction({ handle, args: encodedArgs, signal, reply, context }),
                    signal
                });

                // Fire and forget: whatever came back, if anything, is dropped.
                return !reply || outcome === undefined
                    ? undefined
                    : core.settle({ outcome, context });
            };

            const proxy = (...args : ReadonlyArray<unknown>) : Promise<unknown> => invoke({ args });

            Object.defineProperty(proxy, 'name', { value: name });

            const proxyRef = Object.assign(proxy, { invoke, [ Symbol.dispose ]: releaser }) as Ref;

            heldReleasers.set(handle, releaser);
            holdings.set(proxyRef, { handle, context });
            registerRef({ proxy: proxyRef, releaser });
            finalization.register(proxyRef, { handle, context });

            return proxyRef;
        },

        createRemotePromise: ({ handle, context }) => {
            const promise = settled(() => watchRemotePromise({ handle, context }))
                .then(outcome => core.settle({ outcome, context }));

            holdings.set(promise, { handle, context });

            return promise;
        },

        trackPromise: ({ handle, promise, context }) => {
            promise.then(
                value => table.settle({
                    handle,
                    outcome: { ok: true, value: core.encodeIn({ value, transferable: false, context }).wire }
                }),
                (err : unknown) => table.settle({
                    handle,
                    outcome: { ok: false, error: core.encodeIn({ value: err, transferable: false, context }).wire }
                })
            ).catch(() => {
                // The promise had already been released; nothing to deliver to.
            });
        }
    };

    // Runs the gate and then `allowed`. When the hook answers synchronously
    // the whole thing is synchronous, so a release or watch from a same-tick
    // transport has taken effect by the time the caller's next line runs.
    const authorized = <Result>({ handle, context, allowed } : AuthorizeOptions<Context> & {
        readonly allowed : () => Result,
    }) : Result | Promise<Result> => {
        const entry = table.get({ handle });

        if (!entry) {
            throw new ReleasedError({ handle });
        }

        const target = entry.kind === 'function'
            ? entry.fn
            : entry.target;

        const verdict = authorizeInboundRequest({ handle, context, handleContext: entry.context, target });

        const proceed = (ok : boolean) : Result => {
            if (!ok) {
                throw new UnauthorizedError({
                    handle,
                    name: entry.kind === 'function'
                        ? entry.fn.name
                        : undefined
                });
            }

            return allowed();
        };

        return verdict instanceof Promise
            ? verdict.then(proceed)
            : proceed(verdict);
    };

    const assertOpen = () : void => {
        if (closed) {
            throw new Error('This sandestin instance has been closed');
        }
    };

    type EncodeArguments = {
        readonly value : unknown,
        readonly transferable ?: true,
        readonly context ?: Context,
    };

    const encode = (({ value, transferable, context } : EncodeArguments) => {
        assertOpen();

        const result = core.encodeIn({ value, transferable: transferable === true, context });

        return transferable === true
            ? result
            : result.wire;
    }) as Encode<Context>;

    const decode = <T>({ wire, context } : { readonly wire : Encoded, readonly context ?: Context }) : Remote<T> => {
        assertOpen();

        return core.decodeIn({ wire, context }) as Remote<T>;
    };

    return {
        encode,
        decode,
        encodeJSON: ({ value, context }) => JSON.stringify(encode({ value, context })),
        decodeJSON: ({ text, context }) => decode({ wire: JSON.parse(text), context }),

        invokeLocalFunction: async ({ handle, args, context }) => {
            try {
                await authorized({ handle, context, allowed: () => undefined });

                const entry = table.get({ handle });

                if (entry?.kind !== 'function') {
                    throw new ReleasedError({ handle });
                }

                const decodedArgs = core.decodeIn({ wire: args, context }) as ReadonlyArray<unknown>;
                const { authorize, once } = entry.options;

                if (authorize && !await authorize({ context, handleContext: entry.context, args: decodedArgs })) {
                    throw new UnauthorizedError({ handle, name: entry.fn.name });
                }

                if (once) {
                    table.release({ handle });
                }

                // The function runs with the request's context as `this`, so
                // one that cares who is calling can look without a wrapper.
                const fn = entry.fn as (this : Context, ...args : ReadonlyArray<unknown>) => unknown;
                const result : unknown = await fn.call(context, ...decodedArgs);

                return { ok: true, value: core.encodeIn({ value: result, transferable: false, context }).wire };
            } catch (err) {
                return { ok: false, error: core.encodeIn({ value: err, transferable: false, context }).wire };
            }
        },

        releaseLocalHandle: ({ handle, context }) => {
            return table.get({ handle })
                ? settled(() => authorized({ handle, context, allowed: () => table.release({ handle }) }))
                : Promise.resolve();
        },

        watchLocalPromise: ({ handle, context }) => settled(() => authorized({
            handle,
            context,

            allowed: () => new Promise<Outcome>(resolve => {
                table.watch({ handle, listener: resolve });
            })
        })),

        hasHandle: ({ handle }) => table.get({ handle }) !== undefined,

        liveHandleCount: () => table.size(),

        close: () => {
            closed = true;
            table.close();

            for (const releaser of heldReleasers.values()) {
                releaser();
            }
        }
    };
};
