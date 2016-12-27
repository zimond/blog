---
title: Rust futures at a glance
date: 2016-12-07 15:49:59
tags:
- Rust
---

Recently I am working on a project involving a server which is both CPU and I/O heavy.As a developer with a Node.js background, I realized that Node.js is not doing well in a CPU-heavy situation. And that’s why I switched to Rust. I had no doubt about Rust’s well played lifetime & borrow design and the ability to easily ship parallel code to accomplish CPU-heavy jobs. But it’s the I/O handling that remains a problem.

Rust’s standard library has a [TcpStream](https://doc.rust-lang.org/std/net/struct.TcpStream.html) which is sync. It’s known that sync I/O operations could be a huge drawback of program performace as the thread has to wait for I/O to finish. Currently guys in the Rust community are working hard on a solution of this based on [mio](https://github.com/carllerche/mio).

Before all of this, here’s some background knowledge about async I/O.

## Async IO

There’re two async IO models: the completion model and the readiness model.

The completion model is quite straightforward. The program provides a buffer to the kernel and schedules a _callback_. The kernel will eventually fill the buffer with async-got data and call the callback with the data.

The problem of this model is that it involves many allocations, also quickly becomes too complicated especially when composing async jobs. The situation is quite similar to Node.js’s [callback hell](http://stackabuse.com/avoiding-callback-hell-in-node-js/).

The readiness model is more passive. The program polls a socket, and gets an `EWOULDBLOCK` error if it is not ready. The kernel(`epoll`, in fact) will register the program for further notification once the socket is ready, and _waits_ for state changes of the socket. When notified, the program could poll again and get the data.

So in the readiness model, an _event loop_ must be introduced to continuously call `epoll_wait` to get socket fd changes. `Mio` is such a library in Rust.

> Note that even though Node.js’s standard APIs are in a callback favor, it is **NOT** using the completion model. Node.js is based on `libuv`, which is a successor of `libev`, the well-known event loop implementation

Further readings for this section:

1.  [My Basic Understanding of mio and Asynchronous IO](http://hermanradtke.com/2015/07/12/my-basic-understanding-of-mio-and-async-io.html)
2.  [Epoll](http://man7.org/linux/man-pages/man7/epoll.7.html)

## Futures in Rust

So assume that we already have the low-level event-loop layer. How to define and construct an async task? In Node.js we have _Promise_. A _promise_ is a special object with a `.then()` API. The promise model has two major drawbacks:

It could not be scheduled. The promise is sent to the event loop and executed as soon as created. And it could not be canceled.

[Aturon](http://aturon.github.io/blog/) takes a clever design named as [futures-rs](https://github.com/alexcrichton/futures-rs/) to solve the problems. The `Future` trait is like this:

```rust
trait Future {
  type Item;
  type Error;
  fn poll(&mut self) -> Result<Async<Self::Item>, Self::Error>;
}
```

A _Future_ acts as a node in a large state machine. Each time polled, the `.poll()` API tells which state to go to. If the future is ready to be resolved, it returns `Async::Ready(data)` with the _data_ resolved. If not, `Async::NotReady` is returned to indicate that it should be polled later.

To cancel a future, an event loop could simply stop polling the future any more, which could be achieved by simply `drop` the future instance. Also as a future is a state machine, it will not move to any state without polling.

> Note that `futures-rs` is an abstract layer of design pattern. It is not bound to any real async library (like mio) or event loop implementation(like tokio-core).

## Run a Future

We now have a Future instance, but who should poll the future? `Task` is introduced as the execution unit of a future. the `.wait` (blocking current thread) and `.spawn` (dispatch the future to a thread) APIs are used to create tasks to execute the future passed in.

When a future returns `NotReady`, the task is halted to wait for some event to resume. When running many _tasks_, you have to decide which task to run on which worker thread. When an event occurs, you have to decide which task to wake up. So clearly there’s need for another layer to handle all of this, connect the futures model to the actual async world. This is where [tokio-core](https://github.com/tokio-rs/tokio-core) kicks in. Tokio-core acts as an event loop (based on mio’s event loop) to poll `fd`s, get the events and schedule tasks.

So now let’s go back to the task. When a future is `NotReady`, the task halts. How?

There is an API [.park()](https://docs.rs/futures/0.1.6/futures/task/fn.park.html), which should be called in a future’s `.poll()` function. It acts like `thread::park` and halts the task at the point called. This API returns a _handle_ to the caller to resume the task at a proper time later. A halted task will not block current thread (aka the tokio-core event loop), which allows the event loop to schedule another task to keep it busy.

Further readings for this section:

*   [Design futures for Rust](http://aturon.github.io/blog/2016/09/07/futures-design/)
*   [Zero cost futures in Rust](http://aturon.github.io/blog/2016/08/11/futures/)

## Custom Future Myth

Say we have a `TcpStream` and want to read 10 lines from it. It’s easy to come up with a custom Future like `TenTimesReadFuture`.

```rust
struct TenTimesReadFuture {
  buffer: Vec<u8>,
  line_count: u8,
  stream: TcpStream
}
impl Future for TenTimesReadFuture {
  // omitted
}
```

In the `.poll()` method, read a line from the stream and store it to `buffer` and check the `line_count`. If it reaches 10 lines, resolve the future with the buffer.

But this will not work and `.poll()` will be called only once. That’s because behind tokio-core, `mio`‘s event loop is using the _edge triggering model_. In the event loop, when a resource’s ready, the registered callback (the task) is only notified _once_. So you have to process all the bytes once the socket is ready and `.poll()` is called.

If you do need to wait for something like operations in a worker thread, you have to use the `park/unpark` API to pause the poll and resume it later on.

## Tokio-core

Till now it’s quite clear that the event loop is quite important for all of this to actually work. Tokio-core is such a crate.

```rust
let core = tokio_core::reactor::Core::new();
let lp = core.handle();
// move the handle around
core.run(a_future).unwrap();
```

`.run` will **block** current thread to poll a future to end. It will be super inconvenient to call this API every time. A proper way is to obtain a `Handle` of the loop via `core.handle()`. You could move the handle around, cheap clone it to various structs. Later on, call `handle.spawn()` to spawn a future to the event loop.

Even though Futures-rs is ready for multi-thread use, tokio’s core is single-threaded. It’s clearer to keep the event loop on a single thread and leave the multi-thread thing to the user. There’s `futures-cpupool` to spread cpu-heavy jobs to a thread pool. You could also use `core.remote()` to get a remote handle, which is `Send` and could be used in another thread.

Normally in a multi-threaded server, it’s better to spawn several threads and run an event loop on each. You could reuse the TCP port through the threads. It allows the kernel to dispatch different incoming sockets among the worker threads.

Tokio-core wraps mio’s APIs and serves the `net` module with async TCP/UDP bindings. In the 0.1.0 release, there’s `io` module with some convenient methods for manipulating the streams.

For most users, working directly with tokio-core is still too low-level. So there’s another abstraction layer to sculpture a common workflow. It is [Tokio-proto](https://github.com/tokio-rs/tokio-proto) which is usually used together with [Tokio-service](https://github.com/tokio-rs/tokio-service). But that’s too much for this article.

For HTTP users, hyper’s tokio branch is based on tokio-proto/futures stack, so you have to wait for some time until everything settled down.

## Futures in practice: How to return a future?

Now it’s time to put all of this stuff into practice. When actually using futures to write a project, a critical problem will soon hit you: What’s the correct way to return a `Future`?

Aturon has a nice [tutorial](https://github.com/alexcrichton/futures-rs/blob/master/TUTORIAL.md) about the baby steps of using futures. I urge everyone to read it before using the futures pattern. In the tutorial, he mentions that there are several ways to return a future:

*   Box wrapping the future
*   Use a custom struct to wrap the future
*   Directly return the type
*   return `impl trait`

In my opinion, the forth option is the one and only elegant way to go. Directly returning the type is nearly impossible when you are chaning futures (that’s when the type could be really _HUGE_). Using a custom struct also requires you to declare the type of the future in the struct. So the same problem occurs again.

Box wrapping seems to be a good approach. In fact it’s really easy for a newbie like me to use the `.boxed()` API on futures and return `BoxFuture` here and there. But given a second thought, the API should _not_ be used. `.boxed()` requires a `Send + 'static` bound, which is not needed in most cases, especially when most projects are using `tokio-core` which is single-threaded. If you do need to return a boxed future, it’d better to create your own boxed type without the `Send` bound.

That’s not the biggest problem, however. A `Box` in rust always means runtime overhead. THe compiler could not know the type statically. In fact in this scenario we DO know the returned type, just not bothered to write it down.

Use the latest [impl trait](https://github.com/rust-lang/rfcs/blob/master/text/1522-conservative-impl-trait.md) signature seems to be the best way. It is super clear and still is statically analyzed down to a specific type. Just return `impl Future<Item=T, Error=E>` and you are good to go.

> A common myth is that `impl trait` is similar to that it is in OO languages. In fact it is **NOT**. You could not return any of the trait implementations, only **ONE** of them. It’s just a grammar sugar, and that’s the base of why it do not aquire any runtime overhead.

**Note A:**

A common scenario is that you need to return one of several futures based on a condition.

```rust
if condition {
  future_a
} else {
  future_b
}
```

It’s not so obvious that you could always chain futures to combine these futures into one.

An enum type `Either` is [merged](https://github.com/alexcrichton/futures-rs/pull/271) and landed in futures-rs 0.1.7 to solve this problem.

```rust
if condition {
  Either::A(a)
} else {
    Either::B(b)
}
```

And now you could return the one and only Future implementation without breaking the rules.

**Note B:**

When using `impl Future`, a common situation is that the compiler would complain about “only named lifetimes are allowed in impl trait”. This is to be because of your method has an anoymouse lifetime. Use the following pattern:

```rust
fn some_method<'a>(arg: SomeArgument) -> impl Future<Item=(), Error=()> + 'a {
  // omitted
}
```

## Conclusion

Mio and Futures is the rusty answer of the async problem. It is carefully crafted and come with a elegant design. Though it could be hard to learn about the concepts and the patterns, it is really a neat piece of library/stack to use.