# Changelog

## [0.1.16](https://github.com/RooseveltAdvisors/quota-axi/compare/quota-axi-v0.1.15...quota-axi-v0.1.16) (2026-08-08)


### Features

* add cycle-average quota pace signals ([#49](https://github.com/RooseveltAdvisors/quota-axi/issues/49)) ([b465eae](https://github.com/RooseveltAdvisors/quota-axi/commit/b465eaeb4050e6ae919da7832908e33a9a9e7af8))
* add model evidence, quota runway, and human TUI ([#9](https://github.com/RooseveltAdvisors/quota-axi/issues/9)) ([83cd39b](https://github.com/RooseveltAdvisors/quota-axi/commit/83cd39b829e0d5102941613b6ddae57c12a91de8))
* add release automation and public skill scaffolding ([#2](https://github.com/RooseveltAdvisors/quota-axi/issues/2)) ([10b3c46](https://github.com/RooseveltAdvisors/quota-axi/commit/10b3c46b2f0a3e1d8562b2a3e1d1dbfae09cb5da))
* **alibaba:** report authoritative Coding Plan usage ([#6](https://github.com/RooseveltAdvisors/quota-axi/issues/6)) ([02a2441](https://github.com/RooseveltAdvisors/quota-axi/commit/02a24416c7d23e22e53f08351e84f064cd1af1bd))
* **cli:** add human terminal quota report ([#66](https://github.com/RooseveltAdvisors/quota-axi/issues/66)) ([7c5bb5e](https://github.com/RooseveltAdvisors/quota-axi/commit/7c5bb5e538951973cc4de01a74f55cf0a9aa45a2))
* **cli:** migrate CLI plumbing to axi-sdk-js ([#20](https://github.com/RooseveltAdvisors/quota-axi/issues/20)) ([d59fc2a](https://github.com/RooseveltAdvisors/quota-axi/commit/d59fc2ab4e8c94fda2e38f0bbf7fecb72dc60a56))
* **models:** add intelligence-aware quota evidence ([#64](https://github.com/RooseveltAdvisors/quota-axi/issues/64)) ([229ad37](https://github.com/RooseveltAdvisors/quota-axi/commit/229ad37fd6ed368b08f76439c1db15959510a4f7))
* **providers:** add Alibaba Coding Plan entitlement provider ([#5](https://github.com/RooseveltAdvisors/quota-axi/issues/5)) ([37707ad](https://github.com/RooseveltAdvisors/quota-axi/commit/37707ad43f4cbe9121ca97278115b41a5bef71b2))
* **providers:** add cursor copilot and grok quota reports ([#9](https://github.com/RooseveltAdvisors/quota-axi/issues/9)) ([1cf7fd5](https://github.com/RooseveltAdvisors/quota-axi/commit/1cf7fd5af7a376389f1943b12011e7d0c1200c55))
* **providers:** add Kimi Code CLI quota fallback ([#31](https://github.com/RooseveltAdvisors/quota-axi/issues/31)) ([e21241f](https://github.com/RooseveltAdvisors/quota-axi/commit/e21241f43c2e5ccae051f6dce6e7c8901fa27046))
* **providers:** add Kimi Code quota reporting ([#29](https://github.com/RooseveltAdvisors/quota-axi/issues/29)) ([659a2eb](https://github.com/RooseveltAdvisors/quota-axi/commit/659a2eb4148418ada055bad831114e31cd6b1ff1))
* **providers:** add multi-seat Claude quota reporting ([#8](https://github.com/RooseveltAdvisors/quota-axi/issues/8)) ([0c718eb](https://github.com/RooseveltAdvisors/quota-axi/commit/0c718ebb3fd7f462d41649de7861c7ebf5d2fcfb))
* **providers:** isolate managed Claude and Codex profiles ([#22](https://github.com/RooseveltAdvisors/quota-axi/issues/22)) ([b81d311](https://github.com/RooseveltAdvisors/quota-axi/commit/b81d3119c4f4a0a2ef5b577dd42963aa7da5f404))
* **providers:** renew OAuth credentials on quota reads ([#4](https://github.com/RooseveltAdvisors/quota-axi/issues/4)) ([a6d3bef](https://github.com/RooseveltAdvisors/quota-axi/commit/a6d3befa627d72afd05d0c289595fdf2f56150f0))
* **providers:** support Alibaba Token Plan quota usage ([#7](https://github.com/RooseveltAdvisors/quota-axi/issues/7)) ([d697926](https://github.com/RooseveltAdvisors/quota-axi/commit/d69792644d604b97420d1dcf44bd61490f8cb204))
* report effective quota availability ([#41](https://github.com/RooseveltAdvisors/quota-axi/issues/41)) ([4760cfd](https://github.com/RooseveltAdvisors/quota-axi/commit/4760cfd820670ac42df487b1635b535eec236897))
* report effective usable runway ([#57](https://github.com/RooseveltAdvisors/quota-axi/issues/57)) ([19d0403](https://github.com/RooseveltAdvisors/quota-axi/commit/19d04035e4adc2fa8c0ec280ba40d613de56bc22))
* **tui:** make the human report live and act on captain feedback, fix Pi Kimi OAuth ([#68](https://github.com/RooseveltAdvisors/quota-axi/issues/68)) ([fcc9aa3](https://github.com/RooseveltAdvisors/quota-axi/commit/fcc9aa3b11dab333cbcb295bbdece303b730fd4e))


### Bug Fixes

* **claude:** pin Keychain reads to current user ([#46](https://github.com/RooseveltAdvisors/quota-axi/issues/46)) ([8f65d58](https://github.com/RooseveltAdvisors/quota-axi/commit/8f65d58aa0b0efacd0850b9107a8324b122654e3))
* **cli:** fast-path bare version checks ([#67](https://github.com/RooseveltAdvisors/quota-axi/issues/67)) ([f9d5b9f](https://github.com/RooseveltAdvisors/quota-axi/commit/f9d5b9f5fdd7d98817f29ef83935acd9b33093d4))
* **cli:** load user env before quota reads ([#10](https://github.com/RooseveltAdvisors/quota-axi/issues/10)) ([340c39f](https://github.com/RooseveltAdvisors/quota-axi/commit/340c39f155c6084cd7e8862d2ee5b49238e004aa))
* **codex:** classify quota windows by exact duration ([1591c58](https://github.com/RooseveltAdvisors/quota-axi/commit/1591c585384fe69ac23e822d68f6b6662f6abe62))
* **codex:** derive window id/label/kind from actual window duration ([47db504](https://github.com/RooseveltAdvisors/quota-axi/commit/47db504dab7bf7f623b9e17728caaa0df4c55251))
* **codex:** identify quota windows by exact duration ([a24b1ff](https://github.com/RooseveltAdvisors/quota-axi/commit/a24b1ff246f7b958782da64fb75e07465bd5f28c))
* execute every PR body compliance event ([#37](https://github.com/RooseveltAdvisors/quota-axi/issues/37)) ([e85fdbc](https://github.com/RooseveltAdvisors/quota-axi/commit/e85fdbc0b100a1042f50935e467c0c301542e595))
* harden the no-mistakes pull request gate ([#3](https://github.com/RooseveltAdvisors/quota-axi/issues/3)) ([7ef2e06](https://github.com/RooseveltAdvisors/quota-axi/commit/7ef2e066f52de9811f9016f29b2ea455872378a1))
* **pace:** treat a missing resetsAt on a zero-use window as not-yet-triggered ([#70](https://github.com/RooseveltAdvisors/quota-axi/issues/70)) ([3ab4d12](https://github.com/RooseveltAdvisors/quota-axi/commit/3ab4d127c5adaa2768f5c2a1320cb14128ae1ad2))
* **providers:** clean up unread Kimi responses ([#36](https://github.com/RooseveltAdvisors/quota-axi/issues/36)) ([b106f0f](https://github.com/RooseveltAdvisors/quota-axi/commit/b106f0f2e9f167e9adf2091be25b845b4d6d71b1))
* **providers:** correct Claude auth and stale quota fallback ([#44](https://github.com/RooseveltAdvisors/quota-axi/issues/44)) ([8dd34ee](https://github.com/RooseveltAdvisors/quota-axi/commit/8dd34eee84da602844a8c2fac96fe71de158a514))
* **providers:** correct Codex and Grok auth classification ([#51](https://github.com/RooseveltAdvisors/quota-axi/issues/51)) ([d4383e6](https://github.com/RooseveltAdvisors/quota-axi/commit/d4383e694472e6f689b26b636ba8a9cb15fef7f6))
* **providers:** detect Grok OIDC auth records ([#11](https://github.com/RooseveltAdvisors/quota-axi/issues/11)) ([7b33cc6](https://github.com/RooseveltAdvisors/quota-axi/commit/7b33cc65abbfb923da9fa114a77da34ada9e6079))
* **providers:** distinguish expired Grok sessions from sign-in required ([#47](https://github.com/RooseveltAdvisors/quota-axi/issues/47)) ([83ef9fd](https://github.com/RooseveltAdvisors/quota-axi/commit/83ef9fd8b643790d71913c049f7554fd2e75abfc))
* **providers:** keep Kimi credential inspection read-only ([#33](https://github.com/RooseveltAdvisors/quota-axi/issues/33)) ([17eadc9](https://github.com/RooseveltAdvisors/quota-axi/commit/17eadc9f3366fb6ba7f027481fbd8d14755220c8))
* **providers:** parse Pi Kimi credentials directly ([#35](https://github.com/RooseveltAdvisors/quota-axi/issues/35)) ([272a7bc](https://github.com/RooseveltAdvisors/quota-axi/commit/272a7bc1e6c5edce2f689e51e337762b46160b36))
* **providers:** report authoritative Grok quota percentages ([#27](https://github.com/RooseveltAdvisors/quota-axi/issues/27)) ([17c4bd3](https://github.com/RooseveltAdvisors/quota-axi/commit/17c4bd38d258e63313586ac5bc1c0f9ce46fca36))
* **providers:** report quota for Kimi and Grok subscriptions authenticated through pi ([#2](https://github.com/RooseveltAdvisors/quota-axi/issues/2)) ([c266146](https://github.com/RooseveltAdvisors/quota-axi/commit/c266146475b7d8654b6c8acdf13974983c0af06a))
* reuse granted Claude Keychain access on plain calls ([#7](https://github.com/RooseveltAdvisors/quota-axi/issues/7)) ([029f85f](https://github.com/RooseveltAdvisors/quota-axi/commit/029f85fa1c450eaccbc64302a9c723f512081f4b))
* surface Claude Keychain access guidance ([#5](https://github.com/RooseveltAdvisors/quota-axi/issues/5)) ([6d25e11](https://github.com/RooseveltAdvisors/quota-axi/commit/6d25e11a3853fd55dab8a6e2668bb438c09c85e6))
* **tui:** polish --tui exhaustion notes and align two-up card rows ([#72](https://github.com/RooseveltAdvisors/quota-axi/issues/72)) ([170dd33](https://github.com/RooseveltAdvisors/quota-axi/commit/170dd33065168774ce39584a2e4110df3aa959cb))

## [0.1.15](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.14...quota-axi-v0.1.15) (2026-07-28)


### Features

* add cycle-average quota pace signals ([#49](https://github.com/kunchenguid/quota-axi/issues/49)) ([b465eae](https://github.com/kunchenguid/quota-axi/commit/b465eaeb4050e6ae919da7832908e33a9a9e7af8))


### Bug Fixes

* **providers:** distinguish expired Grok sessions from sign-in required ([#47](https://github.com/kunchenguid/quota-axi/issues/47)) ([83ef9fd](https://github.com/kunchenguid/quota-axi/commit/83ef9fd8b643790d71913c049f7554fd2e75abfc))

## [0.1.14](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.13...quota-axi-v0.1.14) (2026-07-27)


### Bug Fixes

* **claude:** pin Keychain reads to current user ([#46](https://github.com/kunchenguid/quota-axi/issues/46)) ([8f65d58](https://github.com/kunchenguid/quota-axi/commit/8f65d58aa0b0efacd0850b9107a8324b122654e3))
* **providers:** correct Claude auth and stale quota fallback ([#44](https://github.com/kunchenguid/quota-axi/issues/44)) ([8dd34ee](https://github.com/kunchenguid/quota-axi/commit/8dd34eee84da602844a8c2fac96fe71de158a514))

## [0.1.13](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.12...quota-axi-v0.1.13) (2026-07-25)


### Features

* report effective quota availability ([#41](https://github.com/kunchenguid/quota-axi/issues/41)) ([4760cfd](https://github.com/kunchenguid/quota-axi/commit/4760cfd820670ac42df487b1635b535eec236897))

## [0.1.12](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.11...quota-axi-v0.1.12) (2026-07-24)


### Bug Fixes

* **codex:** classify quota windows by exact duration ([1591c58](https://github.com/kunchenguid/quota-axi/commit/1591c585384fe69ac23e822d68f6b6662f6abe62))
* **codex:** derive window id/label/kind from actual window duration ([47db504](https://github.com/kunchenguid/quota-axi/commit/47db504dab7bf7f623b9e17728caaa0df4c55251))
* **codex:** identify quota windows by exact duration ([a24b1ff](https://github.com/kunchenguid/quota-axi/commit/a24b1ff246f7b958782da64fb75e07465bd5f28c))
* execute every PR body compliance event ([#37](https://github.com/kunchenguid/quota-axi/issues/37)) ([e85fdbc](https://github.com/kunchenguid/quota-axi/commit/e85fdbc0b100a1042f50935e467c0c301542e595))

## [0.1.11](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.10...quota-axi-v0.1.11) (2026-07-21)


### Bug Fixes

* **providers:** clean up unread Kimi responses ([#36](https://github.com/kunchenguid/quota-axi/issues/36)) ([b106f0f](https://github.com/kunchenguid/quota-axi/commit/b106f0f2e9f167e9adf2091be25b845b4d6d71b1))
* **providers:** keep Kimi credential inspection read-only ([#33](https://github.com/kunchenguid/quota-axi/issues/33)) ([17eadc9](https://github.com/kunchenguid/quota-axi/commit/17eadc9f3366fb6ba7f027481fbd8d14755220c8))
* **providers:** parse Pi Kimi credentials directly ([#35](https://github.com/kunchenguid/quota-axi/issues/35)) ([272a7bc](https://github.com/kunchenguid/quota-axi/commit/272a7bc1e6c5edce2f689e51e337762b46160b36))

## [0.1.10](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.9...quota-axi-v0.1.10) (2026-07-20)


### Features

* **providers:** add Kimi Code CLI quota fallback ([#31](https://github.com/kunchenguid/quota-axi/issues/31)) ([e21241f](https://github.com/kunchenguid/quota-axi/commit/e21241f43c2e5ccae051f6dce6e7c8901fa27046))

## [0.1.9](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.8...quota-axi-v0.1.9) (2026-07-20)


### Features

* **providers:** add Kimi Code quota reporting ([#29](https://github.com/kunchenguid/quota-axi/issues/29)) ([659a2eb](https://github.com/kunchenguid/quota-axi/commit/659a2eb4148418ada055bad831114e31cd6b1ff1))

## [0.1.8](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.7...quota-axi-v0.1.8) (2026-07-20)


### Bug Fixes

* **providers:** report authoritative Grok quota percentages ([#27](https://github.com/kunchenguid/quota-axi/issues/27)) ([17c4bd3](https://github.com/kunchenguid/quota-axi/commit/17c4bd38d258e63313586ac5bc1c0f9ce46fca36))

## [0.1.7](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.6...quota-axi-v0.1.7) (2026-07-18)


### Features

* **providers:** isolate managed Claude and Codex profiles ([#22](https://github.com/kunchenguid/quota-axi/issues/22)) ([b81d311](https://github.com/kunchenguid/quota-axi/commit/b81d3119c4f4a0a2ef5b577dd42963aa7da5f404))

## [0.1.6](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.5...quota-axi-v0.1.6) (2026-07-17)


### Features

* **cli:** migrate CLI plumbing to axi-sdk-js ([#20](https://github.com/kunchenguid/quota-axi/issues/20)) ([d59fc2a](https://github.com/kunchenguid/quota-axi/commit/d59fc2ab4e8c94fda2e38f0bbf7fecb72dc60a56))

## [0.1.5](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.4...quota-axi-v0.1.5) (2026-07-08)


### Bug Fixes

* **providers:** detect Grok OIDC auth records ([#11](https://github.com/kunchenguid/quota-axi/issues/11)) ([7b33cc6](https://github.com/kunchenguid/quota-axi/commit/7b33cc65abbfb923da9fa114a77da34ada9e6079))

## [0.1.4](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.3...quota-axi-v0.1.4) (2026-07-08)


### Features

* **providers:** add cursor copilot and grok quota reports ([#9](https://github.com/kunchenguid/quota-axi/issues/9)) ([1cf7fd5](https://github.com/kunchenguid/quota-axi/commit/1cf7fd5af7a376389f1943b12011e7d0c1200c55))

## [0.1.3](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.2...quota-axi-v0.1.3) (2026-07-08)


### Bug Fixes

* reuse granted Claude Keychain access on plain calls ([#7](https://github.com/kunchenguid/quota-axi/issues/7)) ([029f85f](https://github.com/kunchenguid/quota-axi/commit/029f85fa1c450eaccbc64302a9c723f512081f4b))

## [0.1.2](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.1...quota-axi-v0.1.2) (2026-07-07)


### Bug Fixes

* surface Claude Keychain access guidance ([#5](https://github.com/kunchenguid/quota-axi/issues/5)) ([6d25e11](https://github.com/kunchenguid/quota-axi/commit/6d25e11a3853fd55dab8a6e2668bb438c09c85e6))

## [0.1.1](https://github.com/kunchenguid/quota-axi/compare/quota-axi-v0.1.0...quota-axi-v0.1.1) (2026-07-07)


### Features

* add release automation and public skill scaffolding ([#2](https://github.com/kunchenguid/quota-axi/issues/2)) ([10b3c46](https://github.com/kunchenguid/quota-axi/commit/10b3c46b2f0a3e1d8562b2a3e1d1dbfae09cb5da))

## Changelog
