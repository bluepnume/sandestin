import type { CustomType } from './custom-types';
import type { EncodedFunction } from './records';
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

type EncodeInOptions = {
    readonly value : unknown,
    readonly transferable : boolean,
};

type Core = {
    readonly encodeIn : (options : EncodeInOptions) => TransferableEncoded,
    readonly decodeIn : (options : { readonly wire : Encoded }) => unknown,
    readonly settle : (options : { readonly outcome : Outcome }) => unknown,
    readonly createRef : (options : EncodedFunction) => Ref,
    readonly createRemotePromise : (options : { readonly handle : Handle }) => Promise<unknown>,
    readonly trackPromise : (options : { readonly handle : Handle, readonly promise : Promise<unknown> }) => void,
};

// Runs `step` now and reports its outcome as a promise, without deferring the
// synchronous part to a microtask the way an `async` wrapper would.
const settled = (step : () => void | Promise<void>) : Promise<void> => {
    try {
        return Promise.resolve(step());
    } catch (err) {
        return Promise.reject(err instanceof Error
            ? err
            : new Error(String(err)));
    }
};

// A signal's reason as an Error, which it already is for timeouts and
// plain aborts; anything else is wrapped so a catch always sees one.
type AbortReasonOptions = { readonly signal : AbortSignal };

const abortReason = ({ signal } : AbortReasonOptions) : Error => {
    const reason : unknown = signal.reason;

    return reason instanceof Error
        ? reason
        : new Error(String(reason));
};

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

type CombineSignalsOptions = { readonly signals : ReadonlyArray<AbortSignal | undefined> };

const combineSignals = ({ signals } : CombineSignalsOptions) : AbortSignal | undefined => {
    const present = signals.filter((signal) : signal is AbortSignal => signal !== undefined);

    if (present.length === 0) {
        return undefined;
    }

    return present.length === 1
        ? present[0]
        : AbortSignal.any(present);
};

export const sandestin = <Context = unknown>({
    invokeRemoteFunction,
    releaseRemoteHandle,
    watchRemotePromise,
    authorizeInboundRequest = () => true,
    types = [],
    callTimeout,
    includeStacks = false
} : SandestinOptions<Context>) : Sandestin<Context> => {
    // The option is typed loosely so any CustomType<Value, Wire> fits; the
    // codec works with the erased form.
    const customTypes = types as unknown as ReadonlyArray<CustomType>;

    validateCustomTypes({ types: customTypes });

    const table = createTable<Context>();

    // Holder side: handles this side has been given, and how to let go of each.
    const heldReleasers = new Map<Handle, () => void>();
    const releasedHandles = new Set<Handle>();

    // The garbage-collection net: a proxy nobody references any more releases
    // its handle on the far side, if nothing released it explicitly first.
    const finalization = new FinalizationRegistry<Handle>(handle => {
        if (releasedHandles.has(handle)) {
            releasedHandles.delete(handle);
        } else {
            heldReleasers.delete(handle);
            releaseRemoteHandle({ handle });
        }
    });

    let closed = false;

    // The pieces that refer to each other, kept on one object so each can
    // reach the others without ordering games.
    const core : Core = {
        encodeIn: ({ value, transferable }) => encodeWalk({
            value,
            includeStacks,
            types:      customTypes,
            transferable,
            onFunction: ({ fn }) => table.registerFunction({ fn }),
            onGroup:    group => table.registerGroup(group),

            onPromise: ({ promise }) => {
                const { handle, fresh } = table.registerPromise({ promise });

                if (fresh) {
                    core.trackPromise({ handle, promise });
                }

                return handle;
            }
        }),

        decodeIn: ({ wire }) => decodeWalk({
            wire,
            types:      customTypes,
            onFunction: encoded => core.createRef(encoded),
            onPromise:  ({ handle }) => core.createRemotePromise({ handle })
        }),

        // What a ref or a remote promise does with an outcome.
        settle: ({ outcome }) => {
            if (outcome.ok) {
                return core.decodeIn({ wire: outcome.value });
            }

            const error = core.decodeIn({ wire: outcome.error });

            throw error instanceof Error
                ? error
                : new RemoteError({ name: 'Error', message: String(error), cause: error });
        },

        createRef: ({ handle, name }) => {
            let released = false;

            const releaser = () : void => {
                if (released) {
                    return;
                }

                released = true;
                releasedHandles.add(handle);
                heldReleasers.delete(handle);
                releaseRemoteHandle({ handle });
            };

            const invoke = async ({ args, signal } : InvokeOptions<ReadonlyArray<unknown>>) : Promise<unknown> => {
                if (released) {
                    throw new ReleasedError({ handle, name });
                }

                const combined = combineSignals({
                    signals: [
                        signal,
                        callTimeout === undefined
                            ? undefined
                            : AbortSignal.timeout(callTimeout)
                    ]
                });

                const encodedArgs = core.encodeIn({ value: args, transferable: false }).wire;

                if (combined?.aborted) {
                    throw abortReason({ signal: combined });
                }

                const outcome = await abortable({
                    promise: invokeRemoteFunction({ handle, args: encodedArgs, signal: combined }),
                    signal:  combined
                });

                return core.settle({ outcome });
            };

            const proxy = (...args : ReadonlyArray<unknown>) : Promise<unknown> => invoke({ args });

            Object.defineProperty(proxy, 'name', { value: name });

            const proxyRef = Object.assign(proxy, { invoke, [ Symbol.dispose ]: releaser }) as Ref;

            heldReleasers.set(handle, releaser);
            registerRef({ proxy: proxyRef, releaser });
            finalization.register(proxyRef, handle);

            return proxyRef;
        },

        createRemotePromise: ({ handle }) => new Promise((resolve, reject) => {
            watchRemotePromise({
                handle,

                listener: outcome => {
                    try {
                        resolve(core.settle({ outcome }));
                    } catch (err) {
                        reject(err instanceof Error
                            ? err
                            : new Error(String(err)));
                    }
                }
            });
        }),

        trackPromise: ({ handle, promise }) => {
            promise.then(
                value => table.settle({
                    handle,
                    outcome: { ok: true, value: core.encodeIn({ value, transferable: false }).wire }
                }),
                (err : unknown) => table.settle({
                    handle,
                    outcome: { ok: false, error: core.encodeIn({ value: err, transferable: false }).wire }
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
            : entry.promise;

        const verdict = authorizeInboundRequest({ handle, context, target });

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

    const encode = (({ value, transferable } : { readonly value : unknown, readonly transferable ?: true }) => {
        assertOpen();

        const result = core.encodeIn({ value, transferable: transferable === true });

        return transferable === true
            ? result
            : result.wire;
    }) as Encode;

    const decode = <T>({ wire } : { readonly wire : Encoded }) : Remote<T> => {
        assertOpen();

        return core.decodeIn({ wire }) as Remote<T>;
    };

    return {
        encode,
        decode,
        encodeJSON: ({ value }) => JSON.stringify(encode({ value })),
        decodeJSON: ({ text }) => decode({ wire: JSON.parse(text) }),

        invokeLocalFunction: async ({ handle, args, context }) => {
            try {
                await authorized({ handle, context, allowed: () => undefined });

                const entry = table.get({ handle });

                if (entry?.kind !== 'function') {
                    throw new ReleasedError({ handle });
                }

                const decodedArgs = core.decodeIn({ wire: args }) as ReadonlyArray<unknown>;

                if (entry.options.authorize && !await entry.options.authorize({ context, args: decodedArgs })) {
                    throw new UnauthorizedError({ handle, name: entry.fn.name });
                }

                if (entry.options.once) {
                    table.release({ handle });
                }

                const fn = entry.fn as (...args : ReadonlyArray<unknown>) => unknown;
                const result : unknown = await fn(...decodedArgs);

                return { ok: true, value: core.encodeIn({ value: result, transferable: false }).wire };
            } catch (err) {
                return { ok: false, error: core.encodeIn({ value: err, transferable: false }).wire };
            }
        },

        releaseLocalHandle: ({ handle, context }) => {
            return table.get({ handle })
                ? settled(() => authorized({ handle, context, allowed: () => table.release({ handle }) }))
                : Promise.resolve();
        },

        watchLocalPromise: ({ handle, listener, context }) =>
            settled(() => authorized({ handle, context, allowed: () => table.watch({ handle, listener }) })),

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
