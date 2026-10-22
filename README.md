# sandestin

Serialize values across a boundary with the functions and promises inside them kept alive.

Pass an object with a callback in it to another window, worker or process. On the far side, the callback is still callable: calling it runs the original where it lives and resolves with the result. Promises inside the value settle on the far side when they settle at home. Everything else goes across as data. That is the whole idea, and the package does only that: it does not open windows, send messages, or know what an origin is. Those are yours to plug in, which is how it stays small and how you keep control of security.

A sandestin, in Jack Vance's Dying Earth books, is a bound entity that carries out a magician's instructions from afar, for exactly as long as the binding holds. Same deal.

## Install

```sh
npm install sandestin
```

ES modules, TypeScript types included, no dependencies. Needs `FinalizationRegistry`, `crypto.randomUUID` and `structuredClone`, so any current browser, Node 20+, Deno or Bun.

## The idea in one example

Two sides in one process, wired straight to each other. No messages, no transport, just the mechanism:

```ts
import { createSerdes } from 'sandestin';

type Side = 'a' | 'b';

const a = createSerdes<Side>({
    authorizeInboundRequest: ({ context }) => context === 'b',
    invokeRemoteFunction:    ({ handle, args }) => b.invokeLocalFunction({ handle, args, context: 'a' }),
    releaseRemoteHandle:     ({ handle }) => void b.releaseLocalHandle({ handle, context: 'a' }),
    watchRemotePromise:      ({ handle, listener }) => void b.watchLocalPromise({ handle, listener, context: 'a' })
});

const b = createSerdes<Side>({
    authorizeInboundRequest: ({ context }) => context === 'a',
    invokeRemoteFunction:    ({ handle, args }) => a.invokeLocalFunction({ handle, args, context: 'b' }),
    releaseRemoteHandle:     ({ handle }) => void a.releaseLocalHandle({ handle, context: 'b' }),
    watchRemotePromise:      ({ handle, listener }) => void a.watchLocalPromise({ handle, listener, context: 'b' })
});

// Side A owns a value with a function and a promise in it.
const cart = {
    name:  'cart',
    add:   ({ id } : { id : string }) => `added ${ id }`,
    ready: loadInventory()                       // a pending promise
};

const wire = a.encode({ value: cart });
// { name: 'cart', add: { $type: 'function', $value: '3f9a…' }, ready: { $type: 'promise', $value: '7c21…' } }

// Side B decodes it and gets live references back.
const copy = b.decode({ wire }) as Remote<typeof cart>;

await copy.add({ id: 'B08N5WRWNW' });    // runs on side A, resolves here: 'added B08N5WRWNW'
await copy.ready;                        // resolves when A's promise does
```

Read the two `createSerdes` calls as "how do I reach the other side": each outbound hook on one instance calls the matching inbound method on the other. With a real transport, the hook posts a message and the far side calls the inbound method when it arrives. The instance's code is identical either way.

## What crosses, and how

Three rules:

- **Data goes by value.** Objects, arrays, strings, numbers, booleans, `null`, and in the default mode anything `structuredClone` carries: `Date`, `Map`, `Set`, typed arrays, `undefined`, cycles. The serializer leaves these alone and lets the platform do the copying.
- **Functions go by reference.** A function becomes a handle. The far side gets a *ref*: a function that, when called, sends the arguments back and resolves with the result. Arguments and results follow the same three rules, so callbacks nest to any depth and a ref can be handed back or forwarded on.
- **Promises go by reference.** A promise becomes a handle and the far side gets a real `Promise` that settles when the original does, with the resolved value or rejection reason crossing by these same rules.

Errors are the one special case of data: an `Error` crosses with its `name`, `message`, `cause` chain and own properties intact, and arrives as a `RemoteError` whose `name` is the original's. Stacks stay home unless you opt in.

### Two wire modes

`encode` / `decode` produce and consume structured-cloneable values: hand them to `postMessage`, a `MessagePort`, a `Worker`, a `BroadcastChannel`. Nothing is stringified.

`encodeJSON` / `decodeJSON` produce and consume text for transports that carry strings: WebSocket, `child_process` IPC, HTTP. This mode adds its own records for what JSON cannot say: `Date`, `Map`, `Set`, `RegExp`, `bigint`, typed arrays and `ArrayBuffer` as base64, `undefined`, and cycles. `-0` becomes `0`, as it does in JSON.

In both modes the special values share one record shape, `{ $type, $value }`. A user object that happens to have a `$type` key is escaped on the way out and unescaped on the way in, so there are no reserved keys.

## Lifetime

A function handed across stays callable for as long as the holder keeps the ref. Three ways it ends:

```ts
import { ref, revoke, release } from 'sandestin';

// Owner side, before encoding
ref({ fn, once: true });                        // released after its first call; a second call rejects
ref({ fn, onRelease: () => cleanup() });        // told when the holder is done, by any route
revoke({ fn });                                 // every handle to fn stops working, now and in future

// Holder side
release({ ref: copy.add });                     // done with it; idempotent
using add = copy.add;                           // the same, at scope exit
```

If none of those happen, the holder's garbage collector does it: when a ref becomes unreachable, a `FinalizationRegistry` sends the release. That is the safety net, not the mechanism. It runs when the collector feels like it, so anything that must happen promptly should be an explicit operation, an `unsubscribe()` rather than a dropped reference.

`ref()` returns the function unchanged, tagged in a `WeakMap`, so it composes with anything and can be written inline in the object being encoded. Promises need none of this: their handle is released when they settle.

`liveHandleCount()` tells you how many functions and promises an instance is currently holding for the other side. It exists for tests and leak checks.

## Security

The package never decides who may call what. It gives you one gate and an opaque context to decide with:

```ts
const serdes = createSerdes<{ origin : string, source : Window }>({
    authorizeInboundRequest: ({ handle, context, target }) =>
        context.origin === trustedOrigin && context.source === trustedWindow,
    // ...hooks
});

// Your transport attaches whatever it can vouch for to every inbound request:
serdes.invokeLocalFunction({ handle, args, context: { origin: event.origin, source: event.source } });
```

`context` is whatever your transport puts there. This package never reads it; it passes it to your `authorizeInboundRequest` before every call, release and watch that arrives, and refuses with `UnauthorizedError` when you return `false`. A `postMessage` transport would put the sender's origin and window there and compare against what it recorded when it connected. A worker transport would put the port. The pair harness puts a string.

Two further layers:

- **Handles are unguessable.** Every handle is a random UUID, scoped to one instance. Holding a handle is the only way to name what it points at, so even with no gate installed, the worst a peer can do is call what it was actually given.
- **Per-function policy.** `ref({ fn, authorize: ({ context, args }) => ... })` runs after the instance gate, with the decoded arguments, for decisions like "only below this amount" or "only with a user gesture".

Absent gate means every request is allowed. Install one in anything that talks to another origin.

## API

### `createSerdes<Context>(options)`

One instance per peer. The options are the outbound half: what this side needs done on the other side.

| Option | Called when | You should |
| --- | --- | --- |
| `invokeRemoteFunction({ handle, args })` | A ref on this side is called | Deliver the call; resolve with the far side's `Outcome` |
| `releaseRemoteHandle({ handle })` | A ref is released, or collected | Tell the far side; no reply |
| `watchRemotePromise({ handle, listener })` | A promise handle is decoded | Deliver the far side's `Outcome` to `listener` when it has one |
| `authorizeInboundRequest({ handle, context, target })` | Any inbound request arrives | Return `true` to allow; optional, default allows all |
| `includeStacks` | Encoding an error | `true` to ship `stack`; default `false` |

The returned instance has the inbound half, which your transport calls when a message arrives, plus the codec:

| Method | Does |
| --- | --- |
| `encode({ value })` | Value to structured-cloneable wire; functions and promises become handles |
| `decode({ wire })` | Wire to value; handles become refs and promises |
| `encodeJSON({ value })` / `decodeJSON({ text })` | The same, as text |
| `invokeLocalFunction({ handle, args, context })` | Run a function this side encoded; resolves with an `Outcome`, never throws |
| `releaseLocalHandle({ handle, context })` | The other side let go; fires that function's `onRelease` |
| `watchLocalPromise({ handle, listener, context })` | Deliver a promise's `Outcome` to `listener` when known |
| `liveHandleCount()` | Handles this side still holds for the other |
| `close()` | Release everything in both directions; the instance is finished |

`Outcome` is `{ ok: true, value }` or `{ ok: false, error }`, with `value` and `error` already encoded. Transports forward outcomes without looking inside; refs and remote promises decode them.

### Value helpers

| Function | Side | Does |
| --- | --- | --- |
| `ref({ fn, once?, onRelease?, authorize? })` | Owner | Tags `fn` with lifetime and policy; returns `fn` |
| `revoke({ fn })` | Owner | Every handle to `fn` stops working |
| `release({ ref })` | Holder | Done with a ref; `ref[Symbol.dispose]()` is the same |
| `isRef(value)` | Holder | Whether a function came from the other side |

### Errors

`RemoteError` is what a failed call or rejected remote promise rejects with. Its `name`, `message`, `cause` and own properties are the original's; `remoteStack` carries the far side's stack when it chose to include one. Two subclasses are thrown by the package itself: `ReleasedError` when a handle no longer names anything, `UnauthorizedError` when the gate said no. Both keep their class when they cross a boundary.

### Types

`Remote<T>` is what `T` looks like after crossing: functions become `Ref`s (callable, async, disposable), promises stay promises, everything else is itself. `decode` returns `unknown` because it cannot know what came across; `decode({ wire }) as Remote<Api>` is the honest assertion.

### `sandestin/testing`

`pair()` returns two instances wired directly to each other, as in the first example, with an optional `authorizeInboundRequest`. It is how this package tests itself and how a layer on top can test its protocol without a window.

## A transport in fifty lines

The package ships no transport because a transport is small and yours should know your trust model. This is a complete one over `window.postMessage`, used by the test suite against a real iframe:

```ts
import { createSerdes } from 'sandestin';

export const connect = ({ target, origin, onValue }) => {
    const pending = new Map();      // request id -> resolve
    const watchers = new Map();     // promise handle -> listener
    let nextId = 0;

    const post = message => target.postMessage(message, origin);

    const serdes = createSerdes({
        authorizeInboundRequest: ({ context }) => context.origin === origin && context.source === target,

        invokeRemoteFunction: ({ handle, args }) => new Promise(resolve => {
            const id = nextId++;

            pending.set(id, resolve);
            post({ type: 'invoke', id, handle, args });
        }),

        releaseRemoteHandle: ({ handle }) => post({ type: 'release', handle }),

        watchRemotePromise: ({ handle, listener }) => {
            watchers.set(handle, listener);
            post({ type: 'watch', handle });
        }
    });

    window.addEventListener('message', async event => {
        if (event.origin !== origin || event.source !== target) {
            return;
        }

        const message = event.data;
        const context = { origin: event.origin, source: event.source };

        switch (message.type) {
            case 'value':   onValue(serdes.decode({ wire: message.wire })); break;
            case 'invoke':  post({ type: 'result', id: message.id, outcome: await serdes.invokeLocalFunction({ handle: message.handle, args: message.args, context }) }); break;
            case 'result':  pending.get(message.id)?.(message.outcome); pending.delete(message.id); break;
            case 'release': serdes.releaseLocalHandle({ handle: message.handle, context }); break;
            case 'watch':   serdes.watchLocalPromise({ handle: message.handle, listener: outcome => post({ type: 'settle', handle: message.handle, outcome }), context }); break;
            case 'settle':  watchers.get(message.handle)?.(message.outcome); watchers.delete(message.handle); break;
        }
    });

    return { send: value => post({ type: 'value', wire: serdes.encode({ value }) }) };
};
```

Five message types, one security check, and the transport never looks inside a value. The same shape over a `MessagePort`, a worker, or `child_process` IPC differs only in `post` and the event source, and the test suite runs all three.

## How this differs from the neighbours

**[post-robot](https://github.com/krakenjs/post-robot)** is the direct ancestor: JSON plus function references, passed across windows, with a `send`/`on` messaging layer and origin checks built in. sandestin keeps the rule and drops the rest. The serializer is structured-clone native instead of string based, promises cross as well as functions, references are released when the holder lets go instead of living until the window closes, the messaging layer and origin checks are left to you so the package is not tied to windows, and it targets current runtimes only, so there is no bridge for old browsers.

**[universal-serialize](https://github.com/krakenjs/universal-serialize)** is post-robot's serializer: a `JSON.stringify` replacer with a per-type table. sandestin borrows that structure for its JSON mode and adds what it lacks: structured-clone mode, cycles, the reference table and lifetime, and the inbound gate. It is a different layer rather than an alternative; universal-serialize left function and promise handling as hooks for post-robot to fill, which is exactly the part this package owns.

**[Cap'n Web](https://github.com/cloudflare/capnweb)** is the serious prior art: an object-capability RPC with functions and objects by reference, bidirectional calls, promise pipelining and its own transports. It is a complete RPC system, and its lifetime rules follow from that: every stub must be explicitly disposed, a callback received as a parameter dies when the call returns unless duplicated, class instances must extend `RpcTarget` to cross by reference, and property reads on stubs are remote calls. sandestin chooses the other end of each of those:

| | Cap'n Web | sandestin |
| --- | --- | --- |
| What it is | An RPC system with transports | A serializer with hooks |
| Mental model | Object capabilities: stubs, targets, pipelining | `structuredClone` plus function references |
| A bare function passed across | Stub, disposed when the carrying call returns unless `.dup()` | Callable until the holder drops it, then collected |
| Explicit lifetime | Required (`using` / `dispose`) | Optional (`once`, `release`, `revoke`), GC net underneath |
| Objects with methods | Must extend `RpcTarget` | Plain objects; the functions inside are the references |
| Property reads | Remote, pipelined | Local; data was copied |
| Security | Capabilities are the model | Random handles plus a gate you write |
| Transports | Built in: HTTP, WebSocket, `postMessage` | None; three hooks |

Pick Cap'n Web when you want RPC with pipelining and a capability discipline across many services. Pick sandestin when you want to hand a value with callbacks in it across one boundary and have the rest of your stack stay as it is.

## Status

0.1.0. The surface is small on purpose and is expected to hold; the layer that adds `send`/`on` style messaging and connect-by-URL will be a separate package that depends on this one.

## License

MIT
