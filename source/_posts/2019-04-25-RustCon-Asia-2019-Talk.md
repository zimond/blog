---
layout: post
title: RustCon Asia 2019 Talk
date: 2019-04-25 17:23:23
tags:
---

On April 20th, I was invited to give a talk on _RustCon Asia 2019_, a fantastic local event held by _Pingcap_ and _Cryptape_.

The talk is about a distributed actor system I have been developing and using for nearly half a year, codenamed as _UPS_. We know that `actix` is the most famous and successful actor system in Rust ecosystem. UPS is different as it is a distribution-first solution. It picks fast codes for message se/de, integrates with `tokio` for networking. For each runtime worker, the actors are stored as plain objects, following the [ECS pattern](https://en.wikipedia.org/wiki/Entity_component_system), which means UPS allows more than one actor per-type.

UPS is developed for large work loads, distributed and streaming computation. I am planning to opensource this crate this year, under the name of my company, _Alibaba inc._

Enough intro, back to the talk. It's about some problems I encountered when making this crate. Specifically, the talk is about 3 problems:

- Get compilation-stable `TypeId`, quite hacky
- Use _specialization_ for different codecs
- The tick based design in UPS

{% pdf /blog/files/distributed_actor_system_in_rust.pdf %}