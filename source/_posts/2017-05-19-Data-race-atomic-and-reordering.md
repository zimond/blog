---
title: Data race, atomic and reordering
date: 2017-05-19 10:44:17
tags:
- Memory
- Concurrency
- Atomic
---

Everything is much more complicated in a multithreaded world. Everyone knows about data races, while few knows why and how to effeciently avoid that.

Data race occurs when multiple threads accessing the same memory location at the same time (Read & Write). If one thread writes to the memory, another thread is not updated and uses the old value to do its own calculcation, undefined behaviour happens. Data race should not be a problem is any interactions made to a memory location is well defined.

By using the word _interaction_, we mean _Read_ and _Write_, or in the memory model terminology, _Load_ and _Store_.

By using the word _well defined_, we mean the interactions for one memory model in one thread do not collision with other threads in this time period.

This post introduces memory reordering, how it affects multithreaded program behaviour, why does it happen and what we could do to avoid data race by avoiding it.

# Memory Reordering

Memory reordering is quite interesting. If writing single threaded program, you may never noticed this. As the key principle of memory reordering is keep single-threaded behaviour not changed. Reordering includes compiler and runtime reordering.

## [Compile time reordering](http://preshing.com/20120625/memory-ordering-at-compile-time/)

As the title says, this happens when the compiler thransforming your code into assembly code. The compiler trys to gather all IO to a memory location into one block to optimise memory usage.

```cpp
int A, B;

void foo()
{
    A = B + 1;
    B = 0;
}
```

will be translated to:

```assembly
...
mov     eax, DWORD PTR B
mov     DWORD PTR B, 0
add     eax, 1
mov     DWORD PTR A, eax
...
```

The _save_ to `B` is lifted before the _save_ to `A`, so I/O to `B` happens together. As mentioned before, this will not affect the runtime in a single-threaded program. But when it comes to multithreaded, the program may run not like what you expected.

To avoid compile time reordering, one could add compiler instructions to tell the compiler that reordering should not be done at certain position. In C++11, you could use `asm volatile("" ::: "memory")`. In rust you could use `asm!("" ::: "memory" : "volatile")`.

## Runtime reordering

This is the interecting part. The processor could do runtime reordering when executing your program. That's because every process has a inline-cache (like 32KB size) which supported I/O in 1 or 2 cycles. But a trip to the memory could cost hundred of cycles. So the processor would like to cache as much as he could and visit the memory as less. Not only the read is a problem, when some data is written, it first comes to the L1 cache, then got flushed to the memroy and L2 cache when the L1 cache is full. We could say that the time point of I/O is totally undefined.

Let's say we have 4 threads A, B, C and D. A and B both read then write to `variable`, C and D are _observers_. Despite of reordering that could occur on every thread, C and D may end with totally different result of IO observation. C may see Load-A -> Load-B -> Store-A -> Store-B, whilc D may see Load-A -> Store-A -> Load-B -> Store-B.

### Sequential Consistency

If a system could keep the observation result same across every thread, we say this system has _Sequential Consistency_. In a sequential consist system, all I/O are in order, no extra worry.

### Relaxed consistency

Note that the most popular system X86 (intel, AMD) is not sequential consist.This is the major problem when writing multithreaded programs. And that's where memory barriers come in. The creator of java compiler, Doug Lea has a [famous article](http://g.oswego.edu/dl/jmm/cookbook.html) about compilers, in which he defined 4 types of memory barriers: LoadLoad, LoadStore, StoreStore, StoreLoad. E.g, `LoadStore` is to make a barrier between a `Load` and a following `Store`, to prevent the `store` to be reordered to happen before the `load`.

Relaxed consitency means that some reodering are allowed if they do not across the mentioned four types of barriers.

Major ref of the following is [this](http://preshing.com/20120710/memory-barriers-are-like-source-control-operations/)

#### `LoadLoad`

`LoadLoad` acts quite like a `git pull`. It meas that _a read A could only happens when a former read B happens_. Note that the "former B" read may or may not be the latest value of B, this read and the former read may even not be the same variable / memory location. It's quite useful even though looks weak at the first glance.

Say we have a variable which is manipulated by several threads. We could create a second shared boolean variable `isChanged`, if `isChanged` is set to `true`, we know the variable is changed by another thread. If we read the variable **at this time point**, the value should be updated.

```cpp
if (isUpdated) {
    LOADLOAD_FENCE();
    return Value;
}
```

The fact that `isUpdated` is the latest value or not is really not important. We now have a defined bound to between `isUpdated` and `Value`, that's enough. This pattern is a basis to the widely used double check lock pattern.

#### `StoreStore`

It acts quites like a `git push`. Using the previous example, a `StoreStore` barrier is useful when we need to update `Value`

```cpp
Value = x;
STORESTORE_FENCE();
isUpdated = true;
```

This ensures `isUpdated` is set **after** Value, and tightly bind the two stores.

#### `LoadStore`

LoadStore barriers are needed only on those out-of-order procesors in which waiting store instructions can bypass loads.

#### `StoreLoad`

`StoreLoad` is quite special here. It's a strong memory barrier and more expensive, which ensures that **ALL** stores performed before the barrier are visible to other processors.

Note that this is not equal to a `LoadLoad` and a `StoreStore`. As `LoadLoad` may not get the latest version between all processors for you, but a `StoreLoad` makes sure of that.

# Prevent data race with a lock

## Lock basics

[Lock](https://en.wikipedia.org/wiki/Lock_(computer_science)) is designed to enforce mutual exclusion concurrency control. And it's sync. You could prevent data race by acquire a lock, make your updates inside the scope, and finally release the lock.

Usually when we say _lock_, it refers to a _Mutex_ lock(readwrite lock), which a lock must be held both reading and writing. There's also RwLock allowing multiple readers **or** one writer. But in fact on many OS, rwlocks are just mutex locks underneath.

### Double check lock

Mutex lock is easy to understand and use, but indeed not so efficient when thought through. There's double-check lock which works with memory barriers, explained [here](http://preshing.com/20130930/double-checked-locking-is-fixed-in-cpp11/)

# Prevent data race with memory fences

If you [do not want to use](http://preshing.com/20120612/an-introduction-to-lock-free-programming/) locks, and hates atomics because of lacking of scale and performace in certain conditions, the choice left is to dive into the dirty ground of memory barriers.

## Memory fences: Acquire and release

C++ 11 introduces low-level lock-free operations: acquire and release.

An _acquire fence_ prevents memory reordering after a read. Which equals to a LoadLoad + LoadStore.

A _release fence_ prevents memory reordering of write after read/write, equals to LoadStore + StoreStore

A well-told article [here](http://preshing.com/20130922/acquire-and-release-fences/).


# Prevent data race with atomics

Locks are heavy and inefficient. Luckily they are not the only option to avoid data races in multithreaded programming. As described in previous sections, if we could instruct the processors to load/store data in a proper way, data race could totally be avoided. This is lock-free programming.

## Force SC: Java volatile and C++ Atomic

As mentioned before, in sequential consistency, IO are in-order. So if we could achieve SC, problem solved! This is how Java's `volatile` is [done](https://bartoszmilewski.com/2008/11/11/who-ordered-sequential-consistency/) (also C++11's atomic).

- Issue a StoreStore barrier before each volatile store.
- Issue a StoreLoad barrier after each volatile store.
- Issue LoadLoad and LoadStore barriers after each volatile load.

After that, Java compiler will use data analysis to remove some of the locks. And if it's X86 system, LoadLoad and StoreStore locks are translated to no-ops. That's [because of](https://bartoszmilewski.com/2008/11/05/who-ordered-memory-fences-on-an-x86/) the special structure of X86. So there would be generally to say, only the `StoreLoad` barrier which is still quite heavy.

Atomics are really easy to use, with the `.load()` and `.store()` API we mentioned before. But the problem is only super basic data structures (like int32, boolean) has atomic types. Many widely used data structures do not have a standard atomic type.

Note that in C++ 11, Atomics are **defaultly** SC, you could still specify the memory ordering for every `load` and `store`. It's explained [here](https://bartoszmilewski.com/2008/12/01/c-atomics-and-memory-ordering/)

## Write your own Atomic type

`load` and `store` are one-dimensional operations. It is not really enough for lock-free operations. Take the add operation as an example, you need to first _load_ the value, perform the addition, and then _store_ the new value back. However, all the different kinds of atomic operations could be built with one essential operation: Compare-and-Swap (CAS). C++11 defines CAS as:

```cpp
shared.compare_exchange_weak(T& oldValue, T newValue, ...);
```

This API updates an atomic `shared` with `newValue`, only if current value stored in `shared` equals to `oldValue`, or it will not perform the update, instead just pull the stored value into `oldValue`.

A spinlock is easy to come up with:

```cpp
uint32_t fetch_multiply(std::atomic<uint32_t>& shared, uint32_t multiplier)
{
    uint32_t oldValue = shared.load();
    while (!shared.compare_exchange_weak(oldValue, oldValue * multiplier)) { }
    return oldValue;
}
```

By using this, you could write any Read-Modify-Write operations for custom atomic types.