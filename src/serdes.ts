import type { CodecMode } from './codec';
import type { Encoded, Handle, Outcome, Ref, Serdes, SerdesOptions } from './types';

import { decodeWalk, encodeWalk } from './codec';
import { ReleasedError, RemoteError, UnauthorizedError } from './errors';
import { registerRef } from './ref-registry';
import { createTable } from './table';

type ModeOptions<Payload> = Payload & { readonly mode : CodecMode };

type AuthorizeOptions<Context> = {
    readonly handle : Handle,
    readonly context : Context,
};

type Core = {
    readonly encodeIn : (options : ModeOptions<{ readonly value : unknown }>) => Encoded,
    readonly decodeIn : (options : ModeOptions<{ readonly wire : Encoded }>) => unknown,
    readonly settle : (options : { readonly outcome : Outcome }) => unknown,
    readonly createRef : (options : { readonly handle : Handle }) => Ref,
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

export const createSerdes = <Context = unknown>({
    invokeRemoteFunction,
    releaseRemoteHandle,
    watchRemotePromise,
    authorizeInboundRequest = () => true,
    includeStacks = false
} : SerdesOptions<Context>) : Serdes<Context> => {
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
        encodeIn: ({ value, mode }) => encodeWalk({
            value,
            mode,
            includeStacks,
            onFunction: ({ fn }) => table.registerFunction({ fn }),

            onPromise: ({ promise }) => {
                const { handle, fresh } = table.registerPromise({ promise });

                if (fresh) {
                    core.trackPromise({ handle, promise });
                }

                return handle;
            }
        }),

        decodeIn: ({ wire, mode }) => decodeWalk({
            wire,
            mode,
            onFunction: ({ handle }) => core.createRef({ handle }),
            onPromise:  ({ handle }) => core.createRemotePromise({ handle })
        }),

        // What a ref or a remote promise does with an outcome.
        settle: ({ outcome }) => {
            if (outcome.ok) {
                return core.decodeIn({ wire: outcome.value, mode: 'clone' });
            }

            const error = core.decodeIn({ wire: outcome.error, mode: 'clone' });

            throw error instanceof Error
                ? error
                : new RemoteError({ name: 'Error', message: String(error), cause: error });
        },

        createRef: ({ handle }) => {
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

            const proxy = async (...args : ReadonlyArray<unknown>) : Promise<unknown> => {
                if (released) {
                    throw new ReleasedError({ handle });
                }

                const encodedArgs = core.encodeIn({ value: args, mode: 'clone' });
                const outcome = await invokeRemoteFunction({ handle, args: encodedArgs });

                return core.settle({ outcome });
            };

            const proxyRef = Object.assign(proxy, { [ Symbol.dispose ]: releaser }) as Ref;

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
                value => table.settle({ handle, outcome: { ok: true, value: core.encodeIn({ value, mode: `clone` }) } }),
                (err : unknown) => table.settle({
                    handle,
                    outcome: { ok: false, error: core.encodeIn({ value: err, mode: 'clone' }) }
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
                throw new UnauthorizedError({ handle });
            }

            return allowed();
        };

        return verdict instanceof Promise
            ? verdict.then(proceed)
            : proceed(verdict);
    };

    const assertOpen = () : void => {
        if (closed) {
            throw new Error('This serdes instance has been closed');
        }
    };

    return {
        encode: ({ value }) => {
            assertOpen();

            return core.encodeIn({ value, mode: 'clone' });
        },

        decode: ({ wire }) => {
            assertOpen();

            return core.decodeIn({ wire, mode: 'clone' });
        },

        encodeJSON: ({ value }) => {
            assertOpen();

            return JSON.stringify(core.encodeIn({ value, mode: 'json' }));
        },

        decodeJSON: ({ text }) => {
            assertOpen();

            return core.decodeIn({ wire: JSON.parse(text), mode: 'json' });
        },

        invokeLocalFunction: async ({ handle, args, context }) => {
            try {
                await authorized({ handle, context, allowed: () => undefined });

                const entry = table.get({ handle });

                if (entry?.kind !== 'function') {
                    throw new ReleasedError({ handle });
                }

                const decodedArgs = core.decodeIn({ wire: args, mode: 'clone' }) as ReadonlyArray<unknown>;

                if (entry.options.authorize && !await entry.options.authorize({ context, args: decodedArgs })) {
                    throw new UnauthorizedError({ handle });
                }

                if (entry.options.once) {
                    table.release({ handle });
                }

                const fn = entry.fn as (...args : ReadonlyArray<unknown>) => unknown;
                const result : unknown = await fn(...decodedArgs);

                return { ok: true, value: core.encodeIn({ value: result, mode: 'clone' }) };
            } catch (err) {
                return { ok: false, error: core.encodeIn({ value: err, mode: 'clone' }) };
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
