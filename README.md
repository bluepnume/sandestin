# sandestin

Serialize values across a boundary with the functions and promises inside them kept alive.

Pass an object with a callback in it to another window, worker or process. On the far side, the callback is still callable: calling it runs the original where it lives and resolves with the result. Promises inside the value settle on the far side when they settle at home. Everything else goes across as plain JSON-safe data, with `Date`, `Map`, typed arrays and the like rebuilt on arrival. That is the whole idea, and the package does only that: it does not open windows, send messages, or know what an origin is. Those are yours to plug in, which is how it stays small and how you keep control of security.

A sandestin, in Jack Vance's Dying Earth books, is a bound entity that carries out a magician's instructions from afar, for exactly as long as the binding holds. Same deal.

## Install

```sh
npm install sandestin
```

ES modules, TypeScript types included, no dependencies. Needs `FinalizationRegistry`, `crypto.randomUUID` and `AbortSignal.any`, so any current browser, Node 20+, Deno or Bun. The syntax is ES2019, so older bundlers can parse it without a transpile step.

## The idea in one example

Two sides in one process, wired straight to each other. No messages, no transport, just the mechanism:

```ts
import { sandestin } from 'sandestin';

type Side = 'a' | 'b';

const a = sandestin<Side>({
    authorizeInboundRequest: ({ context }) => context === 'b',
    invokeRemoteFunction:    ({ handle, args }) => b.invokeLocalFunction({ handle, args, context: 'a' }),
    releaseRemoteHandle:     ({ handle }) => void b.releaseLocalHandle({ handle, context: 'a' }),
    watchRemotePromise:      ({ handle }) => b.watchLocalPromise({ handle, context: 'a' })
});

const b = sandestin<Side>({
    authorizeInboundRequest: ({ context }) => context === 'a',
    invokeRemoteFunction:    ({ handle, args }) => a.invokeLocalFunction({ handle, args, context: 'b' }),
    releaseRemoteHandle:     ({ handle }) => void a.releaseLocalHandle({ handle, context: 'b' }),
    watchRemotePromise:      ({ handle }) => a.watchLocalPromise({ handle, context: 'b' })
});

// Side A owns a value with a function and a promise in it.
const cart = {
    name:  'cart',
    add:   ({ id } : { id : string }) => `added ${ id }`,
    ready: loadInventory()                       // a pending promise
};

const wire = a.encode({ value: cart });
// {
//     name:  'cart',
//     add:   { $type: 'function', $value: { handle: '3f9a…', name: 'add' } },
//     ready: { $type: 'promise', $value: '7c21…' }
// }

// Side B decodes it and gets live references back, typed as the far side's value.
const copy = b.decode<typeof cart>({ wire });

await copy.add({ id: 'B08N5WRWNW' });    // runs on side A, resolves here: 'added B08N5WRWNW'
await copy.ready;                        // resolves when A's promise does
```

Read the two `sandestin` calls as "how do I reach the other side": each outbound hook on one instance calls the matching inbound method on the other. With a real transport, the hook posts a message and the far side calls the inbound method when it arrives. The instance's code is identical either way.

## What crosses, and how

Three rules:

- **Data goes by value.** Objects, arrays, strings, numbers, booleans and `null` are themselves on the wire. `Date`, `Map`, `Set`, `RegExp`, `bigint`, typed arrays, `ArrayBuffer`, `undefined`, cycles and shared references become small tagged records and are rebuilt on the far side as what they were. Anything else, a class instance say, is passed through as a plain object and loses its prototype, unless you register a custom type for it.
- **Functions go by reference.** A function becomes a handle. The far side gets a *ref*: a function that, when called, sends the arguments back and resolves with the result. Arguments and results follow the same three rules, so callbacks nest to any depth and a ref can be handed back or forwarded on. The function's `name` travels with it, so a ref is named like the original and so are the errors about it.
- **Promises go by reference.** A promise becomes a handle and the far side gets a real `Promise` that settles when the original does, with the resolved value or rejection reason crossing by these same rules. Anything with a `then` method counts, the same rule `await` uses, so a library's own promise class crosses too.

Errors are the one special case of data: an `Error` crosses with its `name`, `message`, `cause` chain and own properties intact, and arrives as a `RemoteError` whose `name` is the original's. Stacks stay home unless you opt in with `includeStacks`; then `stack` reads as the remote stack followed by the local one, with the raw remote stack kept on `remoteStack`.

### Sent back to its owner

Hand a function across, and the other side may hand it back: in a reply, inside a later message, as an argument. When a ref reaches the instance it came from, the owner gets its **original function** back, same identity, callable directly with no round trip. The same goes for promises. On the wire that is a `returned` record naming the owner's own handle rather than a new one. If the owner has already let go of it (a `once` function that fired, say), it gets a stand-in that rejects with `ReleasedError`. A ref forwarded to a third side is relayed as a new handle, as before.

### Who is calling

A function you handed out runs with the request's context as `this`: the same object your transport attached and the gate saw. A function that cares who is calling can look without being wrapped:

```ts
function sendMessage(this : { source : Window, origin : string }, message : string) {
    this.source.postMessage(message, this.origin);
}
```

Arrow functions and functions that ignore `this` see no difference.

### One wire, three ways to carry it

The wire `encode` produces is plain JSON: only objects, arrays, strings, numbers, booleans and `null`. That one shape fits every transport.

- `encode({ value })` gives you the wire as an object. Hand it to `postMessage`, a `MessagePort`, a `Worker` or a `BroadcastChannel` and it crosses as is.
- `encodeJSON({ value })` gives you the same wire as text, for WebSocket, `child_process` IPC, HTTP and anything else that carries strings. `decodeJSON({ text })` is the inverse.
- `encode({ value, transferable: true })` gives you `{ wire, transfer }`: `ArrayBuffer`s, typed arrays and `MessagePort`s are left native in the wire and listed in `transfer`, ready for `postMessage(wire, transfer)`. Without this flag bytes go as base64 and a `MessagePort` is refused, since there is no way to carry one as text.

Every special value shares one record shape, `{ $type, $value }`. A user object that happens to have a `$type` key is escaped on the way out and unescaped on the way in, so there are no reserved keys. `-0` becomes `0`, as it does in JSON.

Send the wire as the message body. If your transport nests it inside something sandestin encodes again, it still round-trips (the records are escaped and restored), at the cost of a second walk.

### Custom types

Register a type to carry your own classes by value:

```ts
import { sandestin } from 'sandestin';
import type { CustomType } from 'sandestin';

const money : CustomType<Money, { cents : number, currency : string }> = {
    name:   'money',
    test:   value => value instanceof Money,
    encode: ({ value }) => ({ cents: value.cents, currency: value.currency }),
    decode: ({ value }) => new Money(value.cents, value.currency)
};

const a = sandestin({ types: [ money ], /* ...hooks */ });
```

Custom types are tried before the built-ins, so you can override how a `Date` crosses if you need to. The encoded form is walked by the same rules, so it may contain functions, promises, other custom types, or anything else that crosses. Both sides must register the type; a record nobody can decode is an error, not a silent object. Both `encode` and `decode` also receive the `context` of the operation they are part of (see below), so a type that needs to know which peer it is talking to can look.

That last point is how you carry something by *reference*: encode it as an object of functions that act on the original, and add `release` to hear when the far side has let go of all of them:

```ts
const windowType : CustomType<Window, { postMessage : (message : unknown) => void, close : () => void }> = {
    name: 'window',
    test: value => value instanceof Window,

    encode: ({ value }) => ({
        postMessage: message => value.postMessage(message, '*'),
        close:       () => value.close()
    }),

    decode:  ({ value }) => value,
    release: ({ value }) => forget(value)
};
```

The far side gets `{ postMessage, close }` as refs. Each call runs against the original window where it lives. When every one of those refs has been released or collected, `release` fires once with the window, which is where a wrapper would drop its own bookkeeping.

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

A call that has been released rejects with `ReleasedError`, and the message names the function: `Function add (3f9a…) has been released`.

If none of those happen, the holder's garbage collector does it: when a ref becomes unreachable, a `FinalizationRegistry` sends the release. That is the safety net, not the mechanism. It runs when the collector feels like it, so anything that must happen promptly should be an explicit operation, an `unsubscribe()` rather than a dropped reference.

`ref()` returns the function unchanged, tagged in a `WeakMap`, so it composes with anything and can be written inline in the object being encoded. Promises need none of this: their handle is released when they settle.

`liveHandleCount()` tells you how many functions and promises an instance is currently holding for the other side. It exists for tests and leak checks.

## Calling with a signal, a timeout, or no reply

A ref is a plain async function, and it also has `invoke`, which takes the arguments as a list plus options:

```ts
const result = await copy.add({ id: 'B08N5WRWNW' });
const same = await copy.add.invoke({ args: [ { id: 'B08N5WRWNW' } ], signal: AbortSignal.timeout(5000) });

await copy.notify.invoke({ args: [ 'done' ], reply: false });   // fire and forget
```

When the signal fires, the call rejects with the signal's reason and the transport hook sees the same signal, so it can stop waiting too. An already-aborted signal rejects without crossing at all. Set `callTimeout` on the instance and every call, plain or `invoke`, gets `AbortSignal.timeout(callTimeout)` combined with whatever you pass.

`reply: false` resolves with `undefined` once the call is on its way; whatever the far side returns or throws is dropped. The transport hook sees `reply: false` and may send one way and resolve with nothing.

## Context

Every encode and decode can carry a `context`, your own value, typed by the instance's `Context` parameter:

```ts
const wire = peer.encode({ value, context: { window: child, origin: 'https://child.example' } });
const copy = peer.decode({ wire, context: { window: parent, origin: event.origin } });
```

The context is remembered by every function and promise in the value, and **flows with the handle**: when the other side calls a function from that encode, the gate sees the context it was encoded under as `handleContext` next to the request's own `context`; when you call a ref from that decode, the arguments are encoded and the result decoded under the ref's context, and the outbound hooks receive it; when a promise settles, its value is encoded under the context the promise was encoded under; custom types receive it on every `encode` and `decode`, including the ones sandestin does on its own for arguments, results and outcomes. A transport that keys instances by peer can leave `context` out and keep the peer in a closure; one that needs to know, per value, where it was going or where it came from, passes it here and reads it back wherever it matters.

## Security

The package never decides who may call what. It gives you one gate and an opaque context to decide with:

```ts
const peer = sandestin<{ origin : string, source : Window }>({
    authorizeInboundRequest: ({ handle, context, target }) =>
        context.origin === trustedOrigin && context.source === trustedWindow,
    // ...hooks
});

// Your transport attaches whatever it can vouch for to every inbound request:
peer.invokeLocalFunction({ handle, args, context: { origin: event.origin, source: event.source } });
```

`context` is whatever your transport puts there. This package never reads it; it passes it to your `authorizeInboundRequest` before every call, release and watch that arrives, together with the `handleContext` the handle was encoded under, and refuses with `UnauthorizedError` when you return `false`. The function being called gets the same `context` as `this`. A `postMessage` transport would put the sender's origin and window there and compare against what it recorded when it connected. A worker transport would put the port. The pair harness puts a string.

Two further layers:

- **Handles are unguessable.** Every handle is a random UUID, scoped to one instance. Holding a handle is the only way to name what it points at, so even with no gate installed, the worst a peer can do is call what it was actually given.
- **Per-function policy.** `ref({ fn, authorize: ({ context, handleContext, args }) => ... })` runs after the instance gate, with the decoded arguments, for decisions like "only below this amount" or "only with a user gesture".

Absent gate means every request is allowed. Install one in anything that talks to another origin.

## API

### `sandestin<Context>(options)`

One instance per peer. The options are the outbound half: what this side needs done on the other side.

| Option | Called when | You should |
| --- | --- | --- |
| `invokeRemoteFunction({ handle, args, signal?, reply, context })` | A ref on this side is called | Deliver the call; resolve with the far side's `Outcome` (or nothing when `reply` is false); stop waiting if `signal` fires |
| `releaseRemoteHandle({ handle, context })` | A ref is released, or collected | Tell the far side; no reply |
| `watchRemotePromise({ handle, context })` | A promise handle is decoded | Resolve with the far side's `Outcome`; reject if it cannot be had |
| `authorizeInboundRequest({ handle, context, handleContext, target })` | Any inbound request arrives | Return `true` to allow; optional, default allows all |
| `types` | Encoding and decoding | A list of `CustomType`s; optional |
| `callTimeout` | Every outbound call | Milliseconds before a call rejects with a `TimeoutError`; optional |
| `includeStacks` | Encoding an error | `true` to ship `stack`; default `false` |

The returned instance has the inbound half, which your transport calls when a message arrives, plus the codec:

| Method | Does |
| --- | --- |
| `encode({ value, context? })` | Value to JSON-safe wire; functions and promises become handles |
| `encode({ value, context?, transferable: true })` | The same, returning `{ wire, transfer }` with buffers and ports left native |
| `decode<T>({ wire, context? })` | Wire to value, typed `Remote<T>`; handles become refs and promises |
| `encodeJSON({ value, context? })` / `decodeJSON<T>({ text, context? })` | The same, as text |
| `invokeLocalFunction({ handle, args, context })` | Run a function this side encoded; resolves with an `Outcome`, never throws |
| `releaseLocalHandle({ handle, context })` | The other side let go; fires that function's `onRelease` |
| `watchLocalPromise({ handle, context })` | Resolves with a promise's `Outcome` when known; rejects if refused or unknown |
| `hasHandle({ handle })` | Whether this side still holds what the handle names |
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
| `ref.invoke({ args, signal?, reply? })` | Holder | The call as a list of arguments, with an `AbortSignal` and the option of no reply |

### Errors

`RemoteError` is what a failed call or rejected remote promise rejects with. Its `name`, `message`, `cause` and own properties are the original's; when the far side chose to include its stack, `stack` reads as that stack and then the local one, and `remoteStack` carries the raw remote stack. Two subclasses are thrown by the package itself: `ReleasedError` when a handle no longer names anything, `UnauthorizedError` when the gate said no. Both keep their class when they cross a boundary.

### Types

`Remote<T>` is what `T` looks like after crossing: functions become `Ref`s (callable, async, disposable, with `invoke`), promises stay promises, everything else is itself. `decode<Api>({ wire })` returns `Remote<Api>`; with no type argument it returns `unknown`, because the wire cannot say what came across. A value sent back to its owner is the original, which `Remote<T>` cannot express; narrow with `isRef` when it matters. `CustomType<Value, Wire, Context>` is the shape of a `types` entry.

### `sandestin/testing`

`pair()` returns two instances wired directly to each other, as in the first example, taking the same `authorizeInboundRequest`, `types`, `callTimeout` and `includeStacks` options. It is how this package tests itself and how a layer on top can test its protocol without a window.

## A transport in fifty lines

The package ships no transport because a transport is small and yours should know your trust model. This is a complete one over `window.postMessage`, used by the test suite against a real iframe:

```ts
import { sandestin } from 'sandestin';

export const connect = ({ target, origin, onValue }) => {
    const pending = new Map();      // request id -> resolve
    const watchers = new Map();     // promise handle -> listener
    let nextId = 0;

    const post = message => target.postMessage(message, origin);

    const peer = sandestin({
        authorizeInboundRequest: ({ context }) => context.origin === origin && context.source === target,

        invokeRemoteFunction: ({ handle, args }) => new Promise(resolve => {
            const id = nextId++;

            pending.set(id, resolve);
            post({ type: 'invoke', id, handle, args });
        }),

        releaseRemoteHandle: ({ handle }) => post({ type: 'release', handle }),

        watchRemotePromise: ({ handle }) => new Promise(resolve => {
            watchers.set(handle, resolve);
            post({ type: 'watch', handle });
        })
    });

    window.addEventListener('message', async event => {
        if (event.origin !== origin || event.source !== target) {
            return;
        }

        const message = event.data;
        const context = { origin: event.origin, source: event.source };

        switch (message.type) {
            case 'value':   onValue(peer.decode({ wire: message.wire })); break;
            case 'invoke':  post({ type: 'result', id: message.id, outcome: await peer.invokeLocalFunction({ handle: message.handle, args: message.args, context }) }); break;
            case 'result':  pending.get(message.id)?.(message.outcome); pending.delete(message.id); break;
            case 'release': peer.releaseLocalHandle({ handle: message.handle, context }); break;
            case 'watch':   post({ type: 'settle', handle: message.handle, outcome: await peer.watchLocalPromise({ handle: message.handle, context }) }); break;
            case 'settle':  watchers.get(message.handle)?.(message.outcome); watchers.delete(message.handle); break;
        }
    });

    return { send: value => post({ type: 'value', wire: peer.encode({ value }) }) };
};
```

Five message types, one security check, and the transport never looks inside a value. The same shape over a `MessagePort`, a worker, or `child_process` IPC differs only in `post` and the event source, and the test suite runs all three; the child-process one carries the same wire as `JSON.stringify` text.

## How this differs from the neighbours

**[post-robot](https://github.com/krakenjs/post-robot)** is the direct ancestor: JSON plus function references, passed across windows, with a `send`/`on` messaging layer and origin checks built in. sandestin keeps the rule and drops the rest. Promises cross as well as functions, references are released when the holder lets go instead of living until the window closes, functions carry their names, calls take a signal, the messaging layer and origin checks are left to you so the package is not tied to windows, and it targets current runtimes only, so there is no bridge for old browsers. What post-robot did implicitly is kept: a function sent back to its owner is the original, called functions see the caller as `this`, and fire-and-forget calls exist.

**[universal-serialize](https://github.com/krakenjs/universal-serialize)** is post-robot's serializer: a `JSON.stringify` replacer with a per-type table. sandestin borrows that structure, one record shape and a per-type table that you can extend, and adds what it lacks: cycles and shared references, transferables, the reference table and lifetime, and the inbound gate. It is a different layer rather than an alternative; universal-serialize left function and promise handling as hooks for post-robot to fill, which is exactly the part this package owns.

**[Cap'n Web](https://github.com/cloudflare/capnweb)** is the serious prior art: an object-capability RPC with functions and objects by reference, bidirectional calls, promise pipelining and its own transports. It is a complete RPC system, and its lifetime rules follow from that: every stub must be explicitly disposed, a callback received as a parameter dies when the call returns unless duplicated, class instances must extend `RpcTarget` to cross by reference, and property reads on stubs are remote calls. sandestin chooses the other end of each of those:

| | Cap'n Web | sandestin |
| --- | --- | --- |
| What it is | An RPC system with transports | A serializer with hooks |
| Mental model | Object capabilities: stubs, targets, pipelining | JSON plus function references |
| A bare function passed across | Stub, disposed when the carrying call returns unless `.dup()` | Callable until the holder drops it, then collected |
| Your own function coming back | A stub to the stub | The original |
| Explicit lifetime | Required (`using` / `dispose`) | Optional (`once`, `release`, `revoke`), GC net underneath |
| Objects with methods | Must extend `RpcTarget` | Plain objects; the functions inside are the references, or a custom type |
| Property reads | Remote, pipelined | Local; data was copied |
| Security | Capabilities are the model | Random handles plus a gate you write |
| Transports | Built in: HTTP, WebSocket, `postMessage` | None; three hooks |

Pick Cap'n Web when you want RPC with pipelining and a capability discipline across many services. Pick sandestin when you want to hand a value with callbacks in it across one boundary and have the rest of your stack stay as it is.

## Status

0.3.0, shaped by porting post-robot's serialization layer onto it. The surface is small on purpose and is expected to hold; the layer that adds `send`/`on` style messaging and connect-by-URL will be a separate package that depends on this one.

## License

MIT
