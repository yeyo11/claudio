# Changelog

## [0.10.0](https://github.com/yeyo11/claudio/compare/v0.9.0...v0.10.0) (2026-10-27)


### Features

* **api:** client tools on /v1/chat/completions, held at can_use_tool behind a stub MCP server ([5704b8f](https://github.com/yeyo11/claudio/commit/5704b8f0850184c202d34bc27e668ccce7335c45))
* **api:** OpenAI-compatible /v1 routes, whole and streamed ([6e64f0a](https://github.com/yeyo11/claudio/commit/6e64f0af46f992803679978d782d3c17e42bb3f9))
* **api:** response_format and structured output on /v1/chat/completions ([30ef7fe](https://github.com/yeyo11/claudio/commit/30ef7fe9812ce4a2df9c1fe6043a81deb816262c))
* **api:** serve POST /v1/responses with stored responses, function tools and semantic events ([ba9aed3](https://github.com/yeyo11/claudio/commit/ba9aed3b1a1db3b7c0a5ebec83d2e08514e64db5))
* **core:** openaiToolCallTimeoutMinutes setting, resettable with null ([66ceb40](https://github.com/yeyo11/claudio/commit/66ceb402665864eeda9e3754bb4e06df3af329b9))
* **core:** translate the Responses API to the chat-completions turn, and store responses ([f5e4c7d](https://github.com/yeyo11/claudio/commit/f5e4c7d73185e0e20dce26de7072f893660bbc51))
* **core:** translators and conversation table for the OpenAI-compatible API ([77081cd](https://github.com/yeyo11/claudio/commit/77081cd18da95fd2874bda5a48d8179ee0777242))


### Bug fixes

* **api:** /v1 streams no longer open with a retry field ([78b2ca2](https://github.com/yeyo11/claudio/commit/78b2ca25a189890adf2032aa5dd702a075622f55))
* **api:** a failed store write never hangs or fails an OpenAI turn ([1824dcb](https://github.com/yeyo11/claudio/commit/1824dcb6bcaddc930fd60a5b83c597edfaaba7cd))
* **api:** claim only new client calls per message, and cut API chat titles on whole characters ([8156188](https://github.com/yeyo11/claudio/commit/815618842c7bd46071df587f7ab945fb597fbca5))
* **api:** client-tool calls are held only when claimed, survive refused requests, and can be dropped ([22847e4](https://github.com/yeyo11/claudio/commit/22847e427c8b0d9ee94b17681d3555854b1f78b5))
* **api:** count client-tool calls as held only while the live process still holds one ([7b2253d](https://github.com/yeyo11/claudio/commit/7b2253d6d0265b93209500c6595ac0f5fc37b3de))
* **api:** drop a chat's client-tool stub with the chat, and document phase 4 ([4377a32](https://github.com/yeyo11/claudio/commit/4377a3259829a932b3737dde195419bbe9f0aa18))
* **api:** one stream item that cannot be written never drops the end of the stream ([86ab068](https://github.com/yeyo11/claudio/commit/86ab06810f069f2f2ccb6b5939b52d11c429ab2b))
* **api:** refuse a message that drops held calls before interrupting the turn that holds them ([e5e9ae2](https://github.com/yeyo11/claudio/commit/e5e9ae2f9c36a1fa628bca37983334b38298ddaa))
* **api:** scope /v1 to its own chats, bound its turns, fit inline images ([6a6d7d8](https://github.com/yeyo11/claudio/commit/6a6d7d8ca593a79deb64c6c8fddb97c257cca511))
* **api:** take down the losing side of abandon()'s race with the interrupt ([96c2696](https://github.com/yeyo11/claudio/commit/96c269660b863d3db07a84571e92ba71c84c2eeb))
* **api:** title an OpenAI-compatible chat with its first user message ([178913e](https://github.com/yeyo11/claudio/commit/178913e51872bf480791b57478b3db20e789a28d))
* **api:** typed run-slot and not-found refusals, one credential check, and a stream that knows it is closed ([06615b5](https://github.com/yeyo11/claudio/commit/06615b59bb75844f4db4f58e206a794905e73d48))
* **chat-ui:** make the origin badge's hint reachable by keyboard and screen readers ([ded264e](https://github.com/yeyo11/claudio/commit/ded264ecbc46dff872128f6bc8a8a4195b03e4e8))
* **core:** a chat's added MCP servers get their own file, cleaned up, and survive a broken base config ([1310de5](https://github.com/yeyo11/claudio/commit/1310de5b27bf19e5a85292d44a972839f553471e))
* **core:** evict the least recently used idle API process when a run needs a slot ([cbe289c](https://github.com/yeyo11/claudio/commit/cbe289c1ddd51ff3547a6ffdafdb467a02937b4b))
* **core:** eviction routes every leaving chat cold and reserves a replacement's slot once ([ba853dc](https://github.com/yeyo11/claudio/commit/ba853dc0ea718e887dc7929cb84857768305e87f))
* **core:** run-slot eviction never loses a turn and never ends a process for nothing ([1310e8a](https://github.com/yeyo11/claudio/commit/1310e8abaed0d789b314eb18bf1831feafe6f0e5))
* **core:** stop requiring results for client-tool calls the CLI withdrew ([93a6cca](https://github.com/yeyo11/claudio/commit/93a6ccab82f7d792f26e4b2cb172465cc89a7dac))
* **core:** store image references, not data URLs, in a response's input items ([4c57966](https://github.com/yeyo11/claudio/commit/4c5796640e78a60e58bf6c078b72fb3f95773427))
* **core:** the stub's fallback matches a client result by tool name and arguments ([7cfba95](https://github.com/yeyo11/claudio/commit/7cfba954a8cb0b9d777978e59a416c8ce01c68db))
* **core:** word an unreadable MCP config notice by its cause and owner, once per chat ([d491605](https://github.com/yeyo11/claudio/commit/d491605210aca9a5ba07b6deaeb387bac5e518e3))
* **openai:** a failed turn whose end cannot be written breaks the stream ([2a6bf85](https://github.com/yeyo11/claudio/commit/2a6bf85b81f26ffd741b5aed26db6758d1fe147a))
* **openai:** a stream never ends with a failure its turn did not have ([013ef20](https://github.com/yeyo11/claudio/commit/013ef20f40532248d347cb42abdaae3a732c8d85))
* **openai:** input_items round-trip their images, and assistant messages merge only after a call ([2b69c6f](https://github.com/yeyo11/claudio/commit/2b69c6f9d986d142b74795db2876c05b769a787a))
* **openai:** keep the system prompt in two parts, so a follow-up never loses its developer messages ([c47321f](https://github.com/yeyo11/claudio/commit/c47321f4f432c692764c92eb808843b7481b5563))
* **openai:** never rebuild the conversation part from a joined prompt ([94c1745](https://github.com/yeyo11/claudio/commit/94c1745f6d9103e3afa6f5019cca1db2a346aef6))
* **openai:** Responses words in refusals, no separator across items, one system-prompt rule ([cc8a881](https://github.com/yeyo11/claudio/commit/cc8a88197151b65954f338eaf9019621aee22988))
* **openai:** stored images name the turn's uploads by digest and never save their own ([3e0ae60](https://github.com/yeyo11/claudio/commit/3e0ae602b404d8033ee60ae6959ae48bae136e90))
* **openai:** x-claudio-ignored names what the live process does not run ([4b414f7](https://github.com/yeyo11/claudio/commit/4b414f7e9384338ce7150fa5f47a897f663f2ef4))


### Refactoring

* **openai:** keep the item-boundary rule in ResponsesTranslator, one writer guard, an images param name ([2ea12e3](https://github.com/yeyo11/claudio/commit/2ea12e388baa9d5ab3dce0f844c736143f887f1b))
* **openai:** one whole-answer error shape, a required sweep store, no dead delete ([badf3d3](https://github.com/yeyo11/claudio/commit/badf3d3169af0e6a6ac4b68ccb850ba2d016f999))


### Documentation

* eviction results with real clients, its limits, and the owner's choices ([21bce3f](https://github.com/yeyo11/claudio/commit/21bce3fd68c0a2cb7370bc9541106c2aee609c26))
* image and video results of the real-client tests ([9eb0da3](https://github.com/yeyo11/claudio/commit/9eb0da3275252fa274583ea01dd4e32bad9d50ba))
* **openai:** name the Responses limits on stored images and chains without a prompt row ([9fdb2fc](https://github.com/yeyo11/claudio/commit/9fdb2fc82dbbd4345f217b47b0aa724e5f507a81))
* plan and spike for an OpenAI-compatible API surface ([02554b5](https://github.com/yeyo11/claudio/commit/02554b554eba94b4c3bbda7f0ca799fedb1b3c69))
* **readme:** link the launch article and the project's page on the blog ([#64](https://github.com/yeyo11/claudio/issues/64)) ([9ab3a28](https://github.com/yeyo11/claudio/commit/9ab3a28b46ecbc759088d05cf99ac37eb7c479a0))
* real-client test results and the release goal for the OpenAI-compatible API ([0c20ce9](https://github.com/yeyo11/claudio/commit/0c20ce9a1286ef05801f606d3ed3ba7ca4a856bf))
* record the real-CLI smoke run after the phase 4 review fixes ([a40f8f1](https://github.com/yeyo11/claudio/commit/a40f8f1584850cc346f99604a9686662cdf88ab4))
* record the real-CLI smoke runs of POST /v1/responses ([23af870](https://github.com/yeyo11/claudio/commit/23af870aa4d077e3e5134bd06e6e9fcfc34ccf7f))


### Build and packaging

* **sluice:** install once per merge train with [queue] prepare ([e06ca97](https://github.com/yeyo11/claudio/commit/e06ca97aed98619f17971b10f308552afc7988cd))

## [0.9.0](https://github.com/yeyo11/claudio/compare/v0.8.1...v0.9.0) (2026-10-24)


### Features

* **api:** record the matched route on every audit row, and generate its en/es strings ([49c2f8f](https://github.com/yeyo11/claudio/commit/49c2f8fe8eff7c8f1f79a06888dfc4d004737470))
* **settings:** settings state, reset and overrides on the server ([fbe677e](https://github.com/yeyo11/claudio/commit/fbe677e21f8bb50eee4276e1a0ad04c6457339e0))
* **web:** Changed and Reset on every settings row, Overridden in N projects ([b0270c2](https://github.com/yeyo11/claudio/commit/b0270c2cfa1ae8919482c362aa122b1c726fff32))
* **web:** terminal history as wrapping rows on a phone ([e24c488](https://github.com/yeyo11/claudio/commit/e24c488d28ea46b5e35b9af252b2b4fcf31b1227))
* **web:** translate the audit log per route, name actors in words, and fit it on any width ([d0bfb0e](https://github.com/yeyo11/claudio/commit/d0bfb0e56e029a28133a0f2dbd82fcd3f547da68))
* **web:** word the settings reset route in the audit log ([32eab10](https://github.com/yeyo11/claudio/commit/32eab10604c59b000ceafd7d772449e3a546edf9))


### Bug fixes

* **deps:** electron 44.9.1 and undici 7.30.1 for two high advisories ([967d080](https://github.com/yeyo11/claudio/commit/967d0809049d1a11a1657583485b0bfc6a7559f2))
* **ui:** draw the filter chip in Geist, not the browser's button font ([0c7c274](https://github.com/yeyo11/claudio/commit/0c7c2749c5ddefe5881f92a14722dcdbbf696a4b))
* **web:** 44 px Reset on every phone, and two e2e selectors that missed ([cad9ad9](https://github.com/yeyo11/claudio/commit/cad9ad94df32905c62de655e911e5244e8924b0d))
* **web:** a held row keeps its content at the top, and the rotation card never paints a stale draft ([d51fc27](https://github.com/yeyo11/claudio/commit/d51fc279bb633c4f902e8961e4f38b6231f27b47))
* **web:** a Reset keeps the other row's unsaved edit and the engine slot stacks under its control ([e9ddb21](https://github.com/yeyo11/claudio/commit/e9ddb2180b5838df9d3ea6f1424f1056d688454b))
* **web:** a Reset on a phone keeps the slot's room until the next change ([c93b0b4](https://github.com/yeyo11/claudio/commit/c93b0b4f567537850f37ea0a38213c52489fb1b3))
* **web:** a Reset on a Runs row shows the default even over an unsaved edit ([a4dfb22](https://github.com/yeyo11/claudio/commit/a4dfb220750364680a5fab0581a83d5182963eb0))
* **web:** a shadow point without consent says it is off and offers Review and consent ([08a5418](https://github.com/yeyo11/claudio/commit/08a5418bd99d52e6c28ce7145411921ac77b2706))
* **web:** cut audit paths in the middle and let a keyboard reach the whole path ([11f0be2](https://github.com/yeyo11/claudio/commit/11f0be236789bbf7712fbb01caef22fb3b60470b))
* **web:** Decisions rows keep their height and the Overridden link a target ([9fad5dd](https://github.com/yeyo11/claudio/commit/9fad5dd6be606b105847b03e4c46ffa387925118))
* **web:** Escape returns focus to the bell, every font shorthand names its weight, model ids in mono ([0f54782](https://github.com/yeyo11/claudio/commit/0f5478249ea054dd098bee62d41eb46b451eadf1))
* **web:** give the audit table's What column room at 1280, and keep cells from spilling ([19e1c57](https://github.com/yeyo11/claudio/commit/19e1c570f24211555e873925da6d304a0758e33b))
* **web:** hold each part of a reset row, and let a Reset write only over an unsaved edit ([0e5912a](https://github.com/yeyo11/claudio/commit/0e5912a119c6d19a27892d605e653efecd497c00))
* **web:** hold the whole row after a Reset on a phone, and end the hold only on a new change ([a7b72c0](https://github.com/yeyo11/claudio/commit/a7b72c0124f3b1bb3d38deb75bdf132d9d625289))
* **web:** key the Runs card on env ownership, not on the source of each value ([71b0622](https://github.com/yeyo11/claudio/commit/71b0622677c110cd4ca1395e3bceabee7c535c03))
* **web:** put Changed · Reset on the row's head line, and keep focus after Reset ([fb363d3](https://github.com/yeyo11/claudio/commit/fb363d3c6d565175294dd78d2c9e38a6e28cfe83))
* **web:** Reset focuses the row's own control and keeps the other draft ([ff690bd](https://github.com/yeyo11/claudio/commit/ff690bda89e1f950ee5748e118782fac4e4f6658))
* **web:** say in words when no route matched an audited request ([65776f5](https://github.com/yeyo11/claudio/commit/65776f5035992df2d90247b513edc986016e66b5))
* **web:** Spanish copy of the audit routes and the settings slot ([37efea2](https://github.com/yeyo11/claudio/commit/37efea264a4dd6fdae8c06edd03d0904662f308a))
* **web:** terminal history path is text when it fits, and takes the row's font ([a47622e](https://github.com/yeyo11/claudio/commit/a47622e06fd93d92fa6f64342036fc48ba358c1d))
* **web:** terminal history short path takes the row's font ([44d100c](https://github.com/yeyo11/claudio/commit/44d100c37120fdb397e526db3d18b7e1944d2b3c))
* **web:** the provider row's state never narrows below its tag ([e89c976](https://github.com/yeyo11/claudio/commit/e89c976988cd029f84bc3ca6694edbf9b1e5d2ff))
* **web:** the rotation card keeps only the person's edits, over the saved copy ([0371238](https://github.com/yeyo11/claudio/commit/03712388365329d0022ea6f3938b879192bbef74))
* **web:** the rotation card's Discard is always there, disabled while nothing is edited ([46f24cd](https://github.com/yeyo11/claudio/commit/46f24cd1ad06c94c65824b02b8ff50b6ebd75220))
* **web:** the Runs card is not remounted when a row is reset ([9fb5e70](https://github.com/yeyo11/claudio/commit/9fb5e70731ff735f31ebb04ca24e01078e73d58f))
* **web:** word the terminal history's actors as the audit log does ([4c5d120](https://github.com/yeyo11/claudio/commit/4c5d12084f3ecebb075e47343df1de6ca405fd3f))


### Documentation

* **plans:** record the owner's D2 and D4-D8 in the isolation study ([f32ebd0](https://github.com/yeyo11/claudio/commit/f32ebd0d6b4e06cd40dbc0e5707b29a501d01207))
* **plans:** settings reset and overrides, terminal and audit on a phone, and the polish follow-ups ([9e89720](https://github.com/yeyo11/claudio/commit/9e89720735617c920a1b87b659e11b6d565d1253))
* **readme:** the Buy me a coffee badge beside the others ([cea204f](https://github.com/yeyo11/claudio/commit/cea204f8690966673888831ad70fb04b86e1e7f4))
* settings reset and overrides, audit, terminal history, status and the plan's outcome ([0cbf0fe](https://github.com/yeyo11/claudio/commit/0cbf0fe30f07d69f03a2f732869b21eee2ab1f21))


### Build and packaging

* run the repository's checks through Sluice ([5741994](https://github.com/yeyo11/claudio/commit/574199438a4053a7cc90966369825a09e975fb84))
* **sluice:** install before the test gate, so a merge train can run it ([e7981d9](https://github.com/yeyo11/claudio/commit/e7981d99bcc4ef44409136e5b30c29398c6b0d43))

## [0.8.1](https://github.com/yeyo11/claudio/compare/v0.8.0...v0.8.1) (2026-10-20)


### Bug fixes

* **web:** stuck tooltips, unreadable selected pills, and the ui-review follow-ups ([#53](https://github.com/yeyo11/claudio/issues/53)) ([146131d](https://github.com/yeyo11/claudio/commit/146131df737617d60fe993f1b6ceb40ec7f78979))

## [0.8.0](https://github.com/yeyo11/claudio/compare/v0.7.0...v0.8.0) (2026-10-19)


### Features

* Claudio, the assistant's mascot, and its recent conversations ([#51](https://github.com/yeyo11/claudio/issues/51)) ([a2f5098](https://github.com/yeyo11/claudio/commit/a2f5098d329689d5e85b2a23f3da19b171903f05))
* owner-report fixes and Claudio's MCP server on demand from the + of any chat ([#49](https://github.com/yeyo11/claudio/issues/49)) ([1ba9e8a](https://github.com/yeyo11/claudio/commit/1ba9e8a5cc7f56352d24b1431b334f3fe11258de))
* projects are git repositories, with their worktrees as children ([#50](https://github.com/yeyo11/claudio/issues/50)) ([271e070](https://github.com/yeyo11/claudio/commit/271e0700b1009533a2ae3aaf49482e58cf80be8c))

## [0.7.0](https://github.com/yeyo11/claudio/compare/v0.6.1...v0.7.0) (2026-10-19)


### Features

* Claudio in a container, polished, and one update architecture for desktop, container and Helm ([#46](https://github.com/yeyo11/claudio/issues/46)) ([659d0e7](https://github.com/yeyo11/claudio/commit/659d0e7bc7f3d1cfdab361987d2be816e553aee4))
* **core:** re-check the failed check first after a verification fix ([#47](https://github.com/yeyo11/claudio/issues/47)) ([f748571](https://github.com/yeyo11/claudio/commit/f748571159a0bbd7d8bb0cf354649ff1a80a0f34))


### Bug fixes

* **terminal:** stop asking for terminals the server refuses or forgot ([659d0e7](https://github.com/yeyo11/claudio/commit/659d0e7bc7f3d1cfdab361987d2be816e553aee4))

## [0.6.1](https://github.com/yeyo11/claudio/compare/v0.6.0...v0.6.1) (2026-10-18)


### Documentation

* status.md and desktop.md name pull requests, not release numbers, so a release never leaves them behind ([3c91a10](https://github.com/yeyo11/claudio/commit/3c91a10424ce92f89304b53afb1d9a78d842dbdb))
* **status:** 0.6.0 is out, with the "Eat the code" splash ([#42](https://github.com/yeyo11/claudio/issues/42)) ([20edc51](https://github.com/yeyo11/claudio/commit/20edc51bc6a9f4cfa298c67df8f7e444a498138a))

## [0.6.0](https://github.com/yeyo11/claudio/compare/v0.5.1...v0.6.0) (2026-10-18)


### Features

* the "Eat the code" splash on every load, desktop, web and PWA ([#42](https://github.com/yeyo11/claudio/issues/42)) ([9eb2381](https://github.com/yeyo11/claudio/commit/9eb238109f0fe19d87c9d74fdb5caadcd59d64ca))


### Documentation

* catch the docs up with 0.5.1 ([#43](https://github.com/yeyo11/claudio/issues/43)) ([c2014a2](https://github.com/yeyo11/claudio/commit/c2014a203a3b842d4b854765365ee80b5629086f))

## [0.5.1](https://github.com/yeyo11/claudio/compare/v0.5.0...v0.5.1) (2026-10-18)


### Bug fixes

* **ui:** dialogs, sheets and drawers hold up on a phone and in the desktop app ([#40](https://github.com/yeyo11/claudio/issues/40)) ([0d0af80](https://github.com/yeyo11/claudio/commit/0d0af80179f2bde75c78fa3c77a87e85136c0fa6))

## [0.5.0](https://github.com/yeyo11/claudio/compare/v0.4.1...v0.5.0) (2026-10-18)


### Features

* Machine widget and page, async git, figures history, priority for people's chats ([#38](https://github.com/yeyo11/claudio/issues/38)) ([b81a471](https://github.com/yeyo11/claudio/commit/b81a4710562681f24d5dd738b6fd848ea87ce449))

## [0.4.1](https://github.com/yeyo11/claudio/compare/v0.4.0...v0.4.1) (2026-10-18)


### Bug fixes

* **core:** the execution that died at a limit keeps its cause when a replay stops it ([#36](https://github.com/yeyo11/claudio/issues/36)) ([2924f48](https://github.com/yeyo11/claudio/commit/2924f48d5896ed9b7ccba2743658bc9ac5998531))

## [0.4.0](https://github.com/yeyo11/claudio/compare/v0.3.0...v0.4.0) (2026-10-18)


### Features

* **accounts:** Refresh reads the real quota from the CLI's get_usage; the card names the plan, the per-model weekly limits and the credits ([#31](https://github.com/yeyo11/claudio/issues/31)) ([d369c9e](https://github.com/yeyo11/claudio/commit/d369c9ef31677a4057c03fb92f6e5685c16e866d))
* **settings:** Settings in eight groups with search, the Decisions screen as evidence, and the Supervisor as its decision point ([#34](https://github.com/yeyo11/claudio/issues/34)) ([ca86866](https://github.com/yeyo11/claudio/commit/ca8686698eadbc2ecfd92dd01c644c71c6d28dbd))


### Bug fixes

* **chat-ui:** a switch in the phone's context sheet keeps its pill shape ([#35](https://github.com/yeyo11/claudio/issues/35)) ([670a460](https://github.com/yeyo11/claudio/commit/670a4606b7c09b7550f40e144b3080939e92a299))


### Documentation

* **plans:** the process isolation study, completed from its transcript ([#32](https://github.com/yeyo11/claudio/issues/32)) ([65b9655](https://github.com/yeyo11/claudio/commit/65b9655bfc4daf0aba9ad15b9d1fbf5738c01ef0))

## [0.3.0](https://github.com/yeyo11/claudio/compare/v0.2.1...v0.3.0) (2026-10-17)


### Features

* **e2e:** the browser suite runs on GitHub, never on this machine; pnpm e2e:remote runs it on a pushed branch ([#29](https://github.com/yeyo11/claudio/issues/29)) ([c9817c9](https://github.com/yeyo11/claudio/commit/c9817c9b1513c3a25b9f99f6950ac05040504b2d))
* **ui:** the Claudio designer, and the typographic voice it brings ([#26](https://github.com/yeyo11/claudio/issues/26)) ([d2a25a8](https://github.com/yeyo11/claudio/commit/d2a25a869e929f837a7d5257db303f11c6f15f46))


### Performance

* **e2e:** balanced shards, and the three faults the old split hid (a spec selector, a leaked emulation, a Suggest tasks race) ([#30](https://github.com/yeyo11/claudio/issues/30)) ([217d0c5](https://github.com/yeyo11/claudio/commit/217d0c5767cdbc985785f992d6e845bc36e268f7))


### Documentation

* close out 2026-10-17: 0.2.1, the ledger, Collaborators run on real machines, and where the iroh defects stand ([#27](https://github.com/yeyo11/claudio/issues/27)) ([03ac872](https://github.com/yeyo11/claudio/commit/03ac872037fe806d1d51180e843c02958012772a))

## [0.2.1](https://github.com/yeyo11/claudio/compare/v0.2.0...v0.2.1) (2026-10-17)


### Bug fixes

* **core:** flaky core tests at the root: a Core shut down during boot starts nothing, and tests end what they start ([#18](https://github.com/yeyo11/claudio/issues/18)) ([110b21f](https://github.com/yeyo11/claudio/commit/110b21f15a619ae19e1718886bd0f5adf0617a6e))
* **core:** shutdown ends and waits for the gh, glab and provider probes the core started ([#20](https://github.com/yeyo11/claudio/issues/20)) ([07d0efe](https://github.com/yeyo11/claudio/commit/07d0efe6f00ba7d30fdd4b8dbdbee323349901ae))
* **rotation:** a limit wait goes on with the first account that has room, and a stopped task has its way back (R10, R11) ([#21](https://github.com/yeyo11/claudio/issues/21)) ([7f1ee09](https://github.com/yeyo11/claudio/commit/7f1ee0980d377f8348480128cf5525ba86199b8d))
* the e2e and web flakes a loaded machine showed, at their causes: shiki's first compile, the peer check's exiting processes, and five spec waits ([#24](https://github.com/yeyo11/claudio/issues/24)) ([42cbd4b](https://github.com/yeyo11/claudio/commit/42cbd4b3006e95d1f41f94259e38f1ad6478ad65))
* **web:** the pull request step of an orchestration reads "Push & open PR", not an unfilled template ([#16](https://github.com/yeyo11/claudio/issues/16)) ([068fcf4](https://github.com/yeyo11/claudio/commit/068fcf49c3b4bd21340dd704a3cbbce7c4937a2d))


### Documentation

* a short README as the repository's front door, the long sections as docs pages, the REST contract in docs/rest-api.md, and fresh media ([#19](https://github.com/yeyo11/claudio/issues/19)) ([def67a0](https://github.com/yeyo11/claudio/commit/def67a0764f6ec896737cdbd0de52581c3e4e49b))

## [0.2.0](https://github.com/yeyo11/claudio/compare/v0.1.0...v0.2.0) (2026-10-17)


### Features

* **collaborators:** agents read what teammates share, the assistant always and a project's chats when it opts in ([#13](https://github.com/yeyo11/claudio/issues/13)) ([6a63ab2](https://github.com/yeyo11/claudio/commit/6a63ab244a5955587f44e0d7dc3230c036b38123))
* **collaborators:** share a project between teammates' Claudio over iroh, P2P ([#7](https://github.com/yeyo11/claudio/issues/7)) ([ee907d3](https://github.com/yeyo11/claudio/commit/ee907d3a7892a93d2962451a5881f86e588dca38))


### Bug fixes

* **chat:** streaming answers stay legible, no gap above the composer, and the assistant uses the chat's composer ([#9](https://github.com/yeyo11/claudio/issues/9)) ([7c2de13](https://github.com/yeyo11/claudio/commit/7c2de13ddc75bd080a1a271d11de8ac7690afd53))
* **desktop:** the packed tree carries no group write, so a package built under umask 002 does not lock the guards out ([57cfaa4](https://github.com/yeyo11/claudio/commit/57cfaa4d4faa58dd24175e58b6d77ad9792e3902))
* e2e green on main: guarded runs under umask 002, lesson proposals, guard events, and out-of-date specs ([#5](https://github.com/yeyo11/claudio/issues/5)) ([ef3d95e](https://github.com/yeyo11/claudio/commit/ef3d95e2066d30fd9c1e2a265072a19f7030dd21))
* **orchestrator:** the workflow engine follows its journal, waits or rotates at a usage limit, and never hangs running ([#10](https://github.com/yeyo11/claudio/issues/10)) ([e15c794](https://github.com/yeyo11/claudio/commit/e15c794779afc26b0ff197a32967809895f5285f))
* **web:** a page whose service worker was stopped mid-boot no longer stays blank, and a failed wait says why ([#12](https://github.com/yeyo11/claudio/issues/12)) ([01d1e11](https://github.com/yeyo11/claudio/commit/01d1e1103dafaf699e08ef38c09adc972219ed2f))


### Documentation

* **plans:** test-scope and retry-loop guards for every agent, with an opt-in failure baseline ([#6](https://github.com/yeyo11/claudio/issues/6)) ([fa960c7](https://github.com/yeyo11/claudio/commit/fa960c7a95259513cdc46ad7813e67cb7fa43793))
* R12 to R16 closed with their pull requests, and where the project stands after collaborators ([#14](https://github.com/yeyo11/claudio/issues/14)) ([ba5fd30](https://github.com/yeyo11/claudio/commit/ba5fd304d346f7b652748e6a20b5172dab17d42d))

## 0.1.0 (2026-10-16)


### ⚠ BREAKING CHANGES

* Chat.claudioAssistant replaces agentryAssistant, the tunnel setting startWithClaudio replaces startWithAgentry, and the schemas ClaudioLanguage, ClaudioAssistantMarker, ClaudioReleaseInfo, ClaudioDistribution and StartClaudioAssistantChatRequest replace their Agentry names.

### Features

* **accounts:** an expired or incomplete sign-in is a state of the account ([c3480b0](https://github.com/yeyo11/claudio/commit/c3480b0e03f3314793f3a8baae557b2205f4b4ef))
* **accounts:** choose respects the chat's model; the limit path waits when no account can run it ([ed675be](https://github.com/yeyo11/claudio/commit/ed675be2a44275d1fad3e12747c4ebec79b82c8f))
* **accounts:** read each account's models from the CLI initialize handshake, cached per account ([5aeed68](https://github.com/yeyo11/claudio/commit/5aeed68dbc3c423e83aa6aafc2334585307b3f63))
* **api:** eval-head route for pin to HEAD and uncommitted eval files ([b92902b](https://github.com/yeyo11/claudio/commit/b92902bbb455aea6ffbd2e97e7da3b74d199d5ed))
* **api:** evals phase 2 routes, switch and chat-token denials (wip) ([660f399](https://github.com/yeyo11/claudio/commit/660f3992d435ce1170b991ae8173be5d46f8c41f))
* **api:** guard routes and the weakening checks ([95ac2bd](https://github.com/yeyo11/claudio/commit/95ac2bd8dc161a7ba9a3147c768f475c729c69d3))
* **api:** instruction eval routes, estimate and resume, chat-token guard ([a247aec](https://github.com/yeyo11/claudio/commit/a247aecd4fed9548d58b52ef3f0228ecf74dda66))
* **api:** instruction evals phase 2 routes, evalsPhase2 switch and chat-token denials ([4e1bd16](https://github.com/yeyo11/claudio/commit/4e1bd160a7d495e2ec4fc4564ef17d840976eb60))
* **api:** lesson routes, manual mining and the chat-token refusals ([6ada928](https://github.com/yeyo11/claudio/commit/6ada928e01dfda53c027fcce6b3a2e7412a45465))
* **api:** per-account model list, model fallback settings and suggestion routes ([6c55de9](https://github.com/yeyo11/claudio/commit/6c55de946c512bef4913b708e1718b298d6e1897))
* **api:** per-project Claude Docs routes (list, add or create, refresh, remove, ask) ([30f14e1](https://github.com/yeyo11/claudio/commit/30f14e10ce21a9f87c35099bbdf4adf8cec0c417))
* **api:** POST /chats/:id/account switches a chat's account on demand ([56ca47b](https://github.com/yeyo11/claudio/commit/56ca47b7cdcb4068349303d040c8b7da342b93c2))
* **api:** review gate routes (detail, retry, accept, reviewer roles) ([b63a527](https://github.com/yeyo11/claudio/commit/b63a5276df12a56b1942183a4d2e67b8e0ab44e5))
* **api:** routes to read a chat's context, compact it and keep session notes ([444b2d5](https://github.com/yeyo11/claudio/commit/444b2d5b7a74d1d6236db3d7b07db8073bb6e5e3))
* **api:** the terminal's routes, socket, gate and tickets ([e3d2ef7](https://github.com/yeyo11/claudio/commit/e3d2ef72cde1f1853de27094913ae2254807ff12))
* **chat-ui:** a ProseMirror message box, and MCP servers switched from its "+" ([27a45d8](https://github.com/yeyo11/claudio/commit/27a45d8cdc3ca0637bec474f971d84caadecbfe5))
* **chat-ui:** a pure model of how each tool call reads when opened ([416b04b](https://github.com/yeyo11/claudio/commit/416b04bb3dca6f3908300a0edb41ef1ac81db57e))
* **chat-ui:** an Account section in the composer's + menu to switch a chat's account ([b465ed1](https://github.com/yeyo11/claudio/commit/b465ed15df7e4d56d0414db7cd703d2a99339d23))
* **chat-ui:** an opened tool call reads as what happened, not as its JSON ([903e976](https://github.com/yeyo11/claudio/commit/903e976a7878b399c1f9f316105b1714699d4110))
* **chat-ui:** draw compactions as a divider with the summary folded in ([f05da6e](https://github.com/yeyo11/claudio/commit/f05da6e1ff531ecc610579c509677f5ef8fc90cb))
* **chat-ui:** fade the newest words of a streaming block in ([e5281fe](https://github.com/yeyo11/claudio/commit/e5281fe977c695ff357f80509c43e54ac57c4502))
* **chat-ui:** first partial at once and smooth text reveal ([70d3e8c](https://github.com/yeyo11/claudio/commit/70d3e8c4205c8bcb8506209d678bbf1bd67a2ef3))
* **chat-ui:** no jump when a streamed block is stored ([cf29ccc](https://github.com/yeyo11/claudio/commit/cf29ccc12bc422377f9032e7544c9fc9dd4731ee))
* **chat-ui:** preload the Markdown renderer when a chat opens (CHAT-7) ([759c54c](https://github.com/yeyo11/claudio/commit/759c54cc619088370b383e294b0646e7d7e6d300))
* **chat-ui:** show a guard block as a notice strip in the transcript ([1c1f89c](https://github.com/yeyo11/claudio/commit/1c1f89c585447e2493f89dcaf523fdbac13ea791))
* **chat-ui:** the composer's Account section shows an expired sign-in as Sign-in expired ([3802a8d](https://github.com/yeyo11/claudio/commit/3802a8d994a78fb65968bec7c2e26d12a48d6deb))
* **chat-ui:** the rules of what a chat has running beside it ([274cba2](https://github.com/yeyo11/claudio/commit/274cba20a2822c9c338bbb1e8203d4b38f9defcb))
* **chat:** colour code while it streams, calmer motion, repair half-written markdown (CHAT-6, CHAT-17, CHAT-18) ([2d1fdb8](https://github.com/yeyo11/claudio/commit/2d1fdb8ec6042e6d5a09c5e4946d2ce98f145a9d))
* **chat:** draw the person's message the moment Send is pressed ([d9b8057](https://github.com/yeyo11/claudio/commit/d9b8057f69acd40d7bd5ee66c5c572ca99b56cc1))
* **chat:** fewer reads and renders, partials as appends (CHAT-11, CHAT-12) ([a5305ed](https://github.com/yeyo11/claudio/commit/a5305edf5dd18f8f3840d9f26a080f74c2789459))
* **chat:** open a chat's stream where its transcript read ends ([9854c80](https://github.com/yeyo11/claudio/commit/9854c806d245f4830611ac84f443def1d44a378b))
* **chat:** scroll a new question to the top of the conversation ([17e6153](https://github.com/yeyo11/claudio/commit/17e6153a830557bf16ab92669f4361ceaee0c1b3))
* **connectors:** authorise a claude.ai connector through the CLI's mcp_authenticate ([ee7b295](https://github.com/yeyo11/claudio/commit/ee7b29591d4c4835c3dc2f2c1f2087f407c6751a))
* **connectors:** read the overview from the CLI's mcp_status, with the mcp list scrape as fallback ([3f970a2](https://github.com/yeyo11/claudio/commit/3f970a2a6255fc4aa815629bc9197ee5c1565137))
* contract, spend ledger migrations and the daily spend cap setting ([fd2f071](https://github.com/yeyo11/claudio/commit/fd2f07172234ffcce7c0c4d0bd90d4f224793e5e))
* **core,api:** review gate deterministic scans and chat-token refusals ([ccd49bc](https://github.com/yeyo11/claudio/commit/ccd49bc422358f99a2ecfe5e174e6a29358617bc))
* **core:** a sign-in failure marks the account and moves the turn like a limit ([6597a03](https://github.com/yeyo11/claudio/commit/6597a03416c3d5135126e1ccb80011d31b18a955))
* **core:** assistant drafts eval cases and accepts them through the eval write ([5ba42a6](https://github.com/yeyo11/claudio/commit/5ba42a63f0e14e62c62601d727acef2e1780c5fb))
* **core:** build ChecksFix so its history refusal comments on the card; docs and tests for the review fixes ([68c895e](https://github.com/yeyo11/claudio/commit/68c895e09ce1349a47b40b7aa13d891fedc49b0c))
* **core:** CLAUDE.md preview and lesson-to-instructions ([fa15879](https://github.com/yeyo11/claudio/commit/fa15879561c7aaae548a21facca2516b74daec68))
* **core:** compact a chat on purpose, keep session notes and show a compaction in usage ([976c05a](https://github.com/yeyo11/claudio/commit/976c05ae12c55487eb0acccdd113d872ccf9c464))
* **core:** compact the Developer's chat before a bounced card is taken back, behind the context.compact decision point ([9c5c119](https://github.com/yeyo11/claudio/commit/9c5c11902f2eb50b8ac932a7aef0275e3551f03a))
* **core:** daily spend cap ledger, start gate and starters ([ba73265](https://github.com/yeyo11/claudio/commit/ba732654c38fe47b69e1a5132dd3f9849b2a6124))
* **core:** deliver lessons in the journal handoff and into chats ([91c30d0](https://github.com/yeyo11/claudio/commit/91c30d0608fd83d35b1a7b6eb733ae103f2d1f04))
* **core:** eval file version 2 (pressure prompts, mustHold, k, judged) and pass@k metrics ([a3a10a4](https://github.com/yeyo11/claudio/commit/a3a10a48328050e9dbe04e7a4e16f637dfc42a8b))
* **core:** eval files and consent ([50bb54a](https://github.com/yeyo11/claudio/commit/50bb54ac846e5db701d17a58675df75ef2374511))
* **core:** eval judge for judged expectations, confined and fail-closed ([c57b486](https://github.com/yeyo11/claudio/commit/c57b486db40869d774bc3bae095716531e14d916))
* **core:** eval lanes, the throwaway worktrees of an instruction eval ([8475037](https://github.com/yeyo11/claudio/commit/84750379fc9514e7f7f5b96e80416d28f250e524))
* **core:** eval matchers, expectation checks and scoring ([205cadc](https://github.com/yeyo11/claudio/commit/205cadc02e3bd27f9865247e43c41bae6cec0e0d))
* **core:** eval runner v2 with pressure levels, judge and promotion gate ([27a8e1d](https://github.com/yeyo11/claudio/commit/27a8e1df882ec8866a4ff48a8a905b8412f3d3f2))
* **core:** eval runner with queue, limits, ceiling, cancel and restart ([bb06c58](https://github.com/yeyo11/claudio/commit/bb06c589d958cc307149aece8ab9e376261f04b1))
* **core:** eval service facade, export and startup recovery ([7fa93bc](https://github.com/yeyo11/claudio/commit/7fa93bc6f05d21285a14430547c44c99968b30ce))
* **core:** guard command, files, sweep and preflight ([2579c4c](https://github.com/yeyo11/claudio/commit/2579c4c88101dedd557c41f766a29030158ef248))
* **core:** guard engine with shell reader, rules and bypass corpus ([c375f9b](https://github.com/yeyo11/claudio/commit/c375f9b353b036b6ab04cd2c2359593ab2acfe20))
* **core:** guard events table, migration and store ([f498a19](https://github.com/yeyo11/claudio/commit/f498a19a368e99010a17e780be48ec08335de22b))
* **core:** guard every launch path: orchestrator runs, flow runs and opted-in chats ([14d9090](https://github.com/yeyo11/claudio/commit/14d90905d85242ca82e69366aace606814f232c7))
* **core:** guard health signals and per-task and per-run block counts ([6fb7b9b](https://github.com/yeyo11/claudio/commit/6fb7b9b869d9dc94c5987a75d6a20448fa32f2c5))
* **core:** guard program with output contract, deadline and rules-hash check ([9c14413](https://github.com/yeyo11/claudio/commit/9c14413bc2ef8c922403dd6662498a3ed77aa406))
* **core:** guard settings store and resolution ([dac648e](https://github.com/yeyo11/claudio/commit/dac648e20c7ed4a263b2fd6a5e2ec3516c5a0f35))
* **core:** instruction eval migration and store v2 (pressure, judgements, gate) ([b62969a](https://github.com/yeyo11/claudio/commit/b62969a7c0f95d09643a574554c31e84246cdba1))
* **core:** instruction eval tables and store ([d807f9b](https://github.com/yeyo11/claudio/commit/d807f9bb22e8a3460bc19251789451ffcc41e673))
* **core:** keep a chat's process warm while its stream is open (CHAT-13) ([ac45fbf](https://github.com/yeyo11/claudio/commit/ac45fbf1130fb29093681fb827eaa633e7239b3c))
* **core:** lesson miner, validator, matcher and the one-shot helper ([43bd95a](https://github.com/yeyo11/claudio/commit/43bd95a8fd50b3af9b2cb96ff5656e7e8e0574e3))
* **core:** lesson mining queue and the lesson.mine decision point ([ec43302](https://github.com/yeyo11/claudio/commit/ec4330294a666e305c20b60a6132e36e52498a45))
* **core:** lesson service and lesson proposals through memory proposals ([0466c2b](https://github.com/yeyo11/claudio/commit/0466c2b9d17c2aeb67983c0b2fd4550f49e208e3))
* **core:** lessons correction signals ([8c7075c](https://github.com/yeyo11/claudio/commit/8c7075c4a20ca9d09c918b2a3f6f00f907fbf8de))
* **core:** lessons migration, store, decay and settings ([f218c53](https://github.com/yeyo11/claudio/commit/f218c534dbc0a95f59cf462aee06ccb3162969d8))
* **core:** measure the machine and each chat's processes, and admit chats by memory ([7fa1fe1](https://github.com/yeyo11/claudio/commit/7fa1fe1f9fe9afee34f27be3efd299a80057e037))
* **core:** pass --max-turns, --fallback-model, thinking flags and --resume-session-at; set_max_thinking_tokens ([e5ccb58](https://github.com/yeyo11/claudio/commit/e5ccb58cdcf625d0a7163eafd936c5b35cee46fc))
* **core:** pattern grounding, worker context, retrieval rounds, delegation contract and fixer stop rules in the prompts ([edce9c1](https://github.com/yeyo11/claudio/commit/edce9c17afd9438135238444eb499491eb14dca1))
* **core:** per-project Claude Docs registry read and created through the Docs connector ([1b199b8](https://github.com/yeyo11/claudio/commit/1b199b8e101fd88de6221aac3376329c5b95b1c2))
* **core:** persist compactions and session notes, with a housekeeping claim shared across processes ([1ac825e](https://github.com/yeyo11/claudio/commit/1ac825ea72a89749abbd855a03ee959bef9b4505))
* **core:** read blocked_path, decision_reason, title, display_name and agent_id from can_use_tool ([68179cc](https://github.com/yeyo11/claudio/commit/68179cc934b99975e78ae0d0d938f50f4859c848))
* **core:** read compaction from the stream, call get_context_usage with a detail and parse its breakdown ([5b04a45](https://github.com/yeyo11/claudio/commit/5b04a457ba693af1feeaf25cec605926504ad25d))
* **core:** read per-model tokens, overage and utilization, and get_context_usage from the CLI ([08aa1d5](https://github.com/yeyo11/claudio/commit/08aa1d5dbc308731347f1e859845560d79999b29))
* **core:** read what was stored or handed out under the old product name ([84b0cc8](https://github.com/yeyo11/claudio/commit/84b0cc824e1080156aac3e4539bebe84fdfde7e0))
* **core:** refuse a switch to an account whose sign-in expired, as 409 sign-in-expired ([6d91379](https://github.com/yeyo11/claudio/commit/6d91379e13182fada750e3f96bcdb3b074ede234))
* **core:** report the guard's real availability in settings ([53a3238](https://github.com/yeyo11/claudio/commit/53a3238004f6a26f324c58682b1efd51594664ed))
* **core:** review diff collection and textconv-proof diffs ([237feaa](https://github.com/yeyo11/claudio/commit/237feaa5cbabfd579fea4e150a98e1c968a465a1))
* **core:** review gate migration and ReviewStore ([6c80cbd](https://github.com/yeyo11/claudio/commit/6c80cbd5d1d11c791f7bbc4ecbe6e8dc9b61f05a))
* **core:** review gate runner, fixer loop and orchestrator wiring ([de7e591](https://github.com/yeyo11/claudio/commit/de7e591200f66b80cb3a76d0713d098185b2e8c6))
* **core:** review gate schemas, roles, prompts and findings ([e615f83](https://github.com/yeyo11/claudio/commit/e615f834abb457cc95eba2a367617a6db75b096c))
* **core:** stop rules for the verification fixer, checks.fix history and plateau detection ([888ac81](https://github.com/yeyo11/claudio/commit/888ac8163f9b2414b21e0d7135018971c288b881))
* **core:** switch a chat's account on demand, queued while a turn runs ([a4c345c](https://github.com/yeyo11/claudio/commit/a4c345c55fde567d59a3c905ccd115fdf1937007))
* **core:** the terminal service, its host process and its rows ([04b24f0](https://github.com/yeyo11/claudio/commit/04b24f02337c1f5d65d18cf2c39714118d58a1a9))
* **core:** track what each running subagent is doing ([6c127a8](https://github.com/yeyo11/claudio/commit/6c127a84e1917e902df19c1e28538067857eebbd))
* **core:** wire guards into the Claude driver: settings args, markers, arming and liveness ([816522c](https://github.com/yeyo11/claudio/commit/816522c98ca68b336a0fc3431d46ee18d381d7dc))
* daily spend cap API and web ([e769ae0](https://github.com/yeyo11/claudio/commit/e769ae009721957c0de303b1ab029c5360d84ce6))
* **decisions:** account.model-fallback point, resolver and model-fallbacks.json (off by default) ([5efed1d](https://github.com/yeyo11/claudio/commit/5efed1d8d0d0afeb36a11fc207f0698d44a25eda))
* **flow:** a card held by the daily spend cap gets its own Keep going today pass ([6268075](https://github.com/yeyo11/claudio/commit/626807527e8d3f0fb27cbb40b039c3380d4430b9))
* optional team roles and path-scoped rules ([047d46f](https://github.com/yeyo11/claudio/commit/047d46f37f3de8883fa54f18dd6fe5d00e79af18))
* **packaging:** ship the guard program in the bundle, image and desktop app ([53cbc2f](https://github.com/yeyo11/claudio/commit/53cbc2fc064d7233e636276107f859013a9af9ac))
* **packaging:** ship the terminal host and node-pty in the bundle, image, chart and desktop app ([a605b66](https://github.com/yeyo11/claudio/commit/a605b66e4a48c0c276b9b40d2c0f515815c48034))
* **rename:** [@claudio](https://github.com/claudio) scope, CLAUDIO_* variables, MCP server, origin and storage keys ([91ff41f](https://github.com/yeyo11/claudio/commit/91ff41f3868ddc507e188d8d081e0b2fcb6ddd4b))
* **rename:** Claudio in the copy, the brand text, the PWA manifest, the desktop dialogs and the prompts ([84637e8](https://github.com/yeyo11/claudio/commit/84637e83011ea6d57468ebb48834ad07c03ebc00))
* **runtime:** Claudio's own runtime identity ([6667e9d](https://github.com/yeyo11/claudio/commit/6667e9d7424a3711d3b85a9d5bdc8e5e6fde0acb))
* **shared:** a subagent's activity and the subagent.activity event ([10f7b74](https://github.com/yeyo11/claudio/commit/10f7b74149d4c330431d13d22f261ac5dc90a5b3))
* **shared:** carry the CLI's structured tool result as detail ([d142e6f](https://github.com/yeyo11/claudio/commit/d142e6f26f0b6b2e0cb61bfa0e24f77fd3fcf823))
* **shared:** contract for guards ([fc47f18](https://github.com/yeyo11/claudio/commit/fc47f1801c7f18ffa28dc537c178806682e9546b))
* **shared:** instruction eval contract v2 (pressure, judged expectations, metrics, gate, eval-case proposal) ([09c5469](https://github.com/yeyo11/claudio/commit/09c5469ada867220613d03ba59d2717bf5f8d3a3))
* **shared:** instruction eval contract, constants and events ([5048a4f](https://github.com/yeyo11/claudio/commit/5048a4f8e0be1d4688b71bad80aac0298fcf4180))
* **shared:** review gate types, reviewer effort use and review.depth decision point ([ef111d5](https://github.com/yeyo11/claudio/commit/ef111d5bdc11bb48f7b92e73645e0eeb6c422279))
* **shared:** score the risk of each tool call from its name and input ([be4a0af](https://github.com/yeyo11/claudio/commit/be4a0afd5aeef4636a7c55488faa93b5c25f648e))
* **shared:** shared contract for lessons ([f39b018](https://github.com/yeyo11/claudio/commit/f39b018e01522d1746c792d28b5cf76639974cc0))
* **shared:** the context-control contract and compaction entries in the transcript ([3364d29](https://github.com/yeyo11/claudio/commit/3364d297e895d06da7605ede55db8858bafdfa21))
* **shared:** the terminal's types, its event and the regenerated schemas ([7ac7877](https://github.com/yeyo11/claudio/commit/7ac7877913128df8a6a597f8ce002d6e8d279b0d))
* show the risk of a tool call in the transcript, Step by step and the urgency question ([2b8e94a](https://github.com/yeyo11/claudio/commit/2b8e94a7f169a70936c542b2a4b44d12a9c13f07))
* **terminal:** warn in Settings that, with auth off, an agent with a shell can reach the terminal (T8-1) ([08069b8](https://github.com/yeyo11/claudio/commit/08069b8e42b0d298e51d64ca7dedbae9735d3f4b))
* **web:** a folded strip of what is running, and a card per branch under its step ([1d551e3](https://github.com/yeyo11/claudio/commit/1d551e3513514e6d8072fdd209d407b58cb86e02))
* **web:** a terminal opens in a window of its own and goes full screen ([2f005de](https://github.com/yeyo11/claudio/commit/2f005de977d8c6982fdd21589bfc20d132fec964))
* **web:** an expired sign-in is shown on the account, with a way to sign in again ([38810cc](https://github.com/yeyo11/claudio/commit/38810ccc6e3d86a2a3a60a760d4d6f0be858ad8d))
* **web:** authorise a connector from the Connectors page and wait for it to connect ([6c9f91f](https://github.com/yeyo11/claudio/commit/6c9f91f8da9715cc23215ad435ec210cc3a45c87))
* **web:** carry browser storage kept under the old product name over to Claudio's keys ([6f09d79](https://github.com/yeyo11/claudio/commit/6f09d79d83eed6d37c7974d7db5e544af7aec2e4))
* **web:** Claude Docs card on the project's Documents tab ([403284e](https://github.com/yeyo11/claudio/commit/403284ec605584d639ffc6df0520a4022557d5b4))
* **web:** connectors show a key beside needs authorisation and the tool count ([0e0a9ec](https://github.com/yeyo11/claudio/commit/0e0a9ec52d6341f2a3147539267118ffabe18e77))
* **web:** context breakdown panel, compact confirmation, session notes and header action ([3b57360](https://github.com/yeyo11/claudio/commit/3b573604010a1991a99e13bfe2a47a3ba2e2e36d))
* **web:** eval start dialog, run view, sample, history and member entry ([1842509](https://github.com/yeyo11/claudio/commit/1842509195f90050bcb303264f035d39fde699d3))
* **web:** evals list, editor and illustration in Team ([bda3652](https://github.com/yeyo11/claudio/commit/bda3652c6d6d610e723bdf542521d2bbe8c5808e))
* **web:** fixer rows and stop tags, check verdicts, plateau cause and switch ([99b8c89](https://github.com/yeyo11/claudio/commit/99b8c89c4d205d8fe2329550b6984ca976e05425))
* **web:** fuller model picker, effort levels per model, model fallback editor, per-segment model ([c5de054](https://github.com/yeyo11/claudio/commit/c5de0547da46f8d04029a67411d90723c69231f2))
* **web:** guards across the app: launch form, flow stages, project chats, header tag, block chip, health strings ([e540b81](https://github.com/yeyo11/claudio/commit/e540b81e0daca87f1bfa002630abd7fd3bfab1fd))
* **web:** instruction evals phase 2 screens: pressure editor, judged expectation, metrics, gate card, draft cases, trend and switch ([6e06df3](https://github.com/yeyo11/claudio/commit/6e06df36a5148a08667f478e65881b9dafbb8775))
* **web:** lessons in the Memory tab, Settings, project settings and the chat menu ([b3f9d26](https://github.com/yeyo11/claudio/commit/b3f9d2684f1a1291935b26e1f61064068eedbd59))
* **web:** patch subagent.activity in place and show each subagent's line ([f4b89de](https://github.com/yeyo11/claudio/commit/f4b89de5ef7b33438a49b0e2b2c4e4abb173ce79))
* **web:** review gate in the graph form, the verification card and the integration diff ([743e55e](https://github.com/yeyo11/claudio/commit/743e55e3fe6eeb42a093bb81018ca58d1fbfb9a7))
* **web:** Settings → Security → Guards card ([686bbdc](https://github.com/yeyo11/claudio/commit/686bbdcbe6cec0ce6722ea647d7948590afa51f1))
* **web:** the terminal lives in the status bar ([5319d17](https://github.com/yeyo11/claudio/commit/5319d17712f73c4731814ac312922ab1043fbeae))
* **web:** the terminal's dock, project page, phone screen, settings card and copy ([c311da4](https://github.com/yeyo11/claudio/commit/c311da4c4e08fef6126c6162afe0291bfdedcfe9))


### Bug fixes

* **accounts:** an account follows a new sign-in of the CLI in its dir ([fce8f37](https://github.com/yeyo11/claudio/commit/fce8f37ffa13f227ad97d07cf69b1ceee110f20a))
* **accounts:** limit state comes from the CLI's data, never from a failed turn ([4361175](https://github.com/yeyo11/claudio/commit/43611759d51d2b550668623ed1a4ff3841a3f43c))
* **accounts:** off an account that is out, a chat goes on with any account that has room instead of waiting for a reset ([2d79a7d](https://github.com/yeyo11/claudio/commit/2d79a7daac536d8a49aa4ad1722c5351df7e705a))
* **accounts:** pass CLAUDE_CONFIG_DIR for a default account configured elsewhere ([4102403](https://github.com/yeyo11/claudio/commit/4102403da453a915dab521e6aef19799603d8cf9))
* **accounts:** the default account keeps the CLI's own global config ([7b7af2f](https://github.com/yeyo11/claudio/commit/7b7af2f9c5a21c96d4c2db9b68951eccddcd2b17))
* **accounts:** the default account shows the email and plan the CLI reported ([accc9e1](https://github.com/yeyo11/claudio/commit/accc9e19ed0565e0aed68d822ff93b7ea1fe4ec4))
* **api,core:** refuse a chat token's typed /compact and mask Claudio's secrets in served notes ([2f11d4c](https://github.com/yeyo11/claudio/commit/2f11d4c832d798204ec6ca5f0bca7aee0d2d1eb6))
* **api:** a socket upgrade through the dev proxy, which carries no X-Forwarded-Host, is read by its Host ([aae1376](https://github.com/yeyo11/claudio/commit/aae13760954dda2237fd5bcfac1f7f2b0d74741a))
* **api:** ask the daily spend cap before a person's checks fix or document question ([7072682](https://github.com/yeyo11/claudio/commit/707268287574fc89b05c95850f0e39a15a357931))
* **api:** ask the daily spend cap before running a schedule now ([790da25](https://github.com/yeyo11/claudio/commit/790da25158fb8094a1490a4476f64a995f3e5539))
* **api:** end terminal sockets and tickets when who may get in changes ([b3edef2](https://github.com/yeyo11/claudio/commit/b3edef2373df6a58cd54bc49e95de1b24fac6714))
* **api:** generate OpenAPI schemas for the model fallback types ([ea08486](https://github.com/yeyo11/claudio/commit/ea084868f569a81b3e92355204004b7c08ef1a99))
* **api:** refuse a chat's token to approve or reject a memory proposal ([108b6ef](https://github.com/yeyo11/claudio/commit/108b6ef686c40dcfc73d43b0957228cbbfe3bc08))
* **api:** the dev proxy passes the real client, and the gate believes it only from loopback ([5bcfb6e](https://github.com/yeyo11/claudio/commit/5bcfb6e43a46399f036c7b765e47a0a6e782ae8a))
* **api:** the owner's auth token leaves the environment once the core has read it ([24010c5](https://github.com/yeyo11/claudio/commit/24010c55b6dd6db5f6a9faef5bc7b945faa4d651))
* **chat-ui:** close the last block of chat.css after merging main ([ffd52fb](https://github.com/yeyo11/claudio/commit/ffd52fb934e5b167ea002e58fde07c4ae7c57453))
* **core:** a task follows its chat's next result whenever its turn hit a usage limit, the rotation's account switch included ([3ee906f](https://github.com/yeyo11/claudio/commit/3ee906fb4f07a34a95204d1a8ef276dd21198ef2))
* **core:** a zombie in a chat's process tree no longer makes the peer check answer unknown ([d0870a7](https://github.com/yeyo11/claudio/commit/d0870a7774d31780a10af55355fdd4fc67cec848))
* **core:** an orchestration task follows its turn replayed on another account instead of staying running ([1d2b210](https://github.com/yeyo11/claudio/commit/1d2b21087a3ffea941e16012636b7303c50a068b))
* **core:** build diffs without running a repository's textconv or external diff drivers ([7ee8cad](https://github.com/yeyo11/claudio/commit/7ee8cad13f1d15c53f93a1c3300a81e2ce8d7a0b))
* **core:** deny git push to every run an orchestration starts ([2b8e346](https://github.com/yeyo11/claudio/commit/2b8e34627a648bde97034f13e355fc02d78c0d84))
* **core:** guard status runs the pre-launch checks instead of always saying available ([af90014](https://github.com/yeyo11/claudio/commit/af900144eb8835b145e3ac79e380bc52a4db569b))
* **core:** judged expectations are not decided by a matcher ([33b9692](https://github.com/yeyo11/claudio/commit/33b96922e6634f584ce0702c5bc279e0acfda2bb))
* **core:** keep credentials out of eval commands and overlays inside the lane ([5c63430](https://github.com/yeyo11/claudio/commit/5c6343042b162741b16dad4cba9e369450b9a888))
* **core:** one account at its limit no longer stops decisions or marks Claude at its limit ([298eaff](https://github.com/yeyo11/claudio/commit/298eaffe7e6570f8bb6bde3d33f2c14616c970c6))
* **core:** read fixer report rows written in backticks or as list items ([fc301db](https://github.com/yeyo11/claudio/commit/fc301db677e40cae8f6c8be8fb77ba5dca256e4c))
* **core:** wait for the first guard self-test instead of refusing, and keep tests unguarded by default ([9c02dfb](https://github.com/yeyo11/claudio/commit/9c02dfb491b11c5469e7ca9c2003d6cfa9aea267))
* **desktop:** ship node-pty beside the terminal host in the packaged app ([19f82ec](https://github.com/yeyo11/claudio/commit/19f82ecf355dc5bf92386da3adfdf05a9e2a38c4))
* **evals:** keep Phase 2's switch, drafts and judge spending with the person ([38ca5d8](https://github.com/yeyo11/claudio/commit/38ca5d87e85652b40f3254e369455f44c1a201dc))
* **lessons:** harden the validator, the redaction cuts and the chat's project settings ([5d889cc](https://github.com/yeyo11/claudio/commit/5d889cc1e729378dcfc891970a3ebb2b380ce102))
* name high risk in the step dot's title and keep a template role's writes ([6f04e83](https://github.com/yeyo11/claudio/commit/6f04e83586587fb81e065e5af89fc49ced38fa5b))
* **prompts:** names in pasted blocks, a no-code-fix stop, whole-description refine and clearer fixer and plateau texts ([f3b0fb8](https://github.com/yeyo11/claudio/commit/f3b0fb8ec0056efb7d425b9c85b683e05b5f5e2d))
* **risk:** scratch writes and deletes under the temp directories count as inside the working directory ([370fbf0](https://github.com/yeyo11/claudio/commit/370fbf078a53978d72ae398e532d23a41bd5db9c))
* **spend-cap:** a whole amount saves the cap, and its spec flips the cap's switch, not read-only's ([62197b7](https://github.com/yeyo11/claudio/commit/62197b7de4f4b2a4800db0b04ccc29d7b4dc33d6))
* **terminal:** closing a terminal removes it from the list ([04064b0](https://github.com/yeyo11/claudio/commit/04064b055c536d7b92a9ac9abb13007613253985))
* **terminal:** let go a client that holds the shell paused while the others keep up (T8-3) ([b2d2ad0](https://github.com/yeyo11/claudio/commit/b2d2ad0a13f2751e417d33c9be229c5983dab6c5))
* **terminal:** refuse processes Claudio starts for an agent outside a chat's tree (T8-2) ([f182f8d](https://github.com/yeyo11/claudio/commit/f182f8d17bc6c39d5a7f986dd95e9477c0413445))
* **test:** every test run cleans its own temp dirs ([760add1](https://github.com/yeyo11/claudio/commit/760add146fea733278782ba145946b260e50ee79))
* **ui:** a tooltip with nothing to show never stays open ([6e6b07c](https://github.com/yeyo11/claudio/commit/6e6b07cff11aee203272e2a543675103093e0e36))
* **web:** a Claude account's sign-in stacks its long authorize link ([fa7515e](https://github.com/yeyo11/claudio/commit/fa7515e2780c1451845931b0050ae4b7321f8eef))
* **web:** Accounts sits after Projects in the sidebar and is reachable from More on a phone ([5beb2d2](https://github.com/yeyo11/claudio/commit/5beb2d25294272c842deab35d35366aabab8f01f))
* **web:** close the finding card's comment so the stylesheet minifies ([9dc0211](https://github.com/yeyo11/claudio/commit/9dc0211dfebdafa1c4047f15c09666f89bf9ff54))
* **web:** close the review gate finding card's comment so the stylesheet minifies ([25c36e8](https://github.com/yeyo11/claudio/commit/25c36e8d281f1e67cdc07475bc7756adadc9ddab))
* **web:** close the unterminated media query in accounts.css ([07f0d8f](https://github.com/yeyo11/claudio/commit/07f0d8f0338a55d98d6f952bbd8a4e80f4db795b))
* **web:** drop a duplicate import of FlowSpendPass ([cff80cc](https://github.com/yeyo11/claudio/commit/cff80cc786853899e15baa631bcac4537133493d))
* **web:** floor the spend percentage and use the existing radius token ([add4f4e](https://github.com/yeyo11/claudio/commit/add4f4e93fc65d3cc41e8493764edc1473fb310c))
* **web:** offer Submit review only once the review posts are read ([0dd110b](https://github.com/yeyo11/claudio/commit/0dd110bc8ddd6eaec7b7d64e7f51ef134914eab6))
* **web:** plateau is a three-value control, percentages go through i18n, a shell is not read-only, the cap link is a touch target, glossary rows ([d8f8a69](https://github.com/yeyo11/claudio/commit/d8f8a695b80b687bbc8b1a8eec038737d9e70cb7))
* **web:** the compose update steps name Claudio's published image ([75d2624](https://github.com/yeyo11/claudio/commit/75d26241f613e6aac84187e2a317ed9799302a0f))
* **web:** the context panel and the compact confirmation give 44 px targets and a 16 px field on a phone ([3c20ee7](https://github.com/yeyo11/claudio/commit/3c20ee78f01af175c831c8c9ecadb0cff7f99a9c))
* **web:** the opened terminal panel takes the keyboard, and the e2e specs wait for the prompt ([8d716bd](https://github.com/yeyo11/claudio/commit/8d716bd2616d911331d9c9a1adeefe0b7d34fd13))
* **web:** the sign-in's authorize link is one line with an ellipsis ([c8b6c32](https://github.com/yeyo11/claudio/commit/c8b6c32d00a964bbb79f192262dc13e86786f1a9))
* **web:** the Terminal item sits beside the account in the status bar, with its name ([e346ef9](https://github.com/yeyo11/claudio/commit/e346ef97c78ea824dc7448701109db1c730fc497))
* **web:** the terminal screen no longer grows without end ([3114c57](https://github.com/yeyo11/claudio/commit/3114c57ccc1a02d2add9e94509896f06d860802f))
* **web:** the terminal tab strip never shows a scrollbar ([f93ffa5](https://github.com/yeyo11/claudio/commit/f93ffa50eb8cd18a29d1f55eb78f075e116f7bc8))
* **web:** the terminal's screen keeps --term-bg when xterm's own sheet loads after ours ([f1d656d](https://github.com/yeyo11/claudio/commit/f1d656d02c36e21d09dbaec0d8595ea40b9118b6))


### Performance

* **core:** send to a chat of ours without waiting for claude agents --json ([c7958d7](https://github.com/yeyo11/claudio/commit/c7958d7e5d064ecfbcf365d9433ab1525a0d38ab))


### Refactoring

* name every identifier, file, key and fixture of Claudio's own claudio ([d986675](https://github.com/yeyo11/claudio/commit/d986675d321791ace86b14292f9599ead2f270bb))
* **shared:** move unifiedOf and addedDiff into shared/patch ([fd57743](https://github.com/yeyo11/claudio/commit/fd57743eff057c3f53c167fd28b6b5fececacec5))
* **web:** the terminal is managed only from the status bar on a desktop ([2f626d5](https://github.com/yeyo11/claudio/commit/2f626d58c597a9d34fba886191f34f6bf9750c2d))


### Documentation

* **chat:** CHAT-19 is closed, the reading text stays at 14px / 1.65 ([a13525b](https://github.com/yeyo11/claudio/commit/a13525b3ce032192c7e89a3fc38602478cc974cd))
* CLAUDE.md, the README, .env.example and the UI-check skill name Claudio ([fe1f024](https://github.com/yeyo11/claudio/commit/fe1f024e4c7ac5bf6ec2ba1fdebbeeed10e5b2d9))
* context control as built, and the documents that mention it ([e2ab9bc](https://github.com/yeyo11/claudio/commit/e2ab9bc56b3c6695f25d3777659339b1c9d29dba))
* **design-system:** review gate reference screens, finding card and review section ([3e7812b](https://github.com/yeyo11/claudio/commit/3e7812b388973bb1aea75df46485c434fc02b4c5))
* **design-system:** risk, fixer verdicts, spend dialog, optional roles and rule target variants, and the glossary rows ([f19f90d](https://github.com/yeyo11/claudio/commit/f19f90d67b4918c95463b37c15904b36c283e42d))
* **design-system:** the daily spend cap's status bar item, Usage line, wait lines and dialog ([3bcf987](https://github.com/yeyo11/claudio/commit/3bcf98762a8fb2a2efccb0b20a49d94cc0e309f9))
* **design-system:** the terminal's reference screens, --term-* tokens and contrast test ([3a29a10](https://github.com/yeyo11/claudio/commit/3a29a10cdfdcdc816f741f3be443b26f70a3eacf))
* **design-system:** tool rows and live branches, drawn ([4c11e60](https://github.com/yeyo11/claudio/commit/4c11e6040804c7acee13b57a5137b2f15d8d2729))
* docs/resource-control.md and docs/plans/resource-control.md. ([7fa1fe1](https://github.com/yeyo11/claudio/commit/7fa1fe1f9fe9afee34f27be3efd299a80057e037))
* **evals:** feature doc, prompts row, status, team link and plan status ([cd2adc9](https://github.com/yeyo11/claudio/commit/cd2adc94a56b307aa0a2f10b0af744ef85921f7e))
* **evals:** record CLI facts F1 and F12, the rest blocked by a usage limit ([37d0205](https://github.com/yeyo11/claudio/commit/37d0205de382366e937c6856eef21395366fb407))
* **evals:** record the f0 blocker for the judge and pressure facts ([80a2e13](https://github.com/yeyo11/claudio/commit/80a2e1371e95ec81adcbff46ac4ce1d5248a0f9c))
* **guards:** add the guards feature doc and update the related docs, and finish the g10 merge ([8ac2338](https://github.com/yeyo11/claudio/commit/8ac23383861b68d5ee0c3e3deca501314e7f6b36))
* **guards:** security audit of the guards (g17) ([e7f88e8](https://github.com/yeyo11/claudio/commit/e7f88e8a750f742d49b2930a06a45ce430c25288))
* lessons from corrections, as built ([f1c3230](https://github.com/yeyo11/claudio/commit/f1c3230d309ab6a0c2306069205d5b4e1ebf7859))
* name Claudio's own documents, design reference and identifiers claudio ([98490e2](https://github.com/yeyo11/claudio/commit/98490e23622bf62e186673d2e488d673e093b770))
* outcomes for guards, lessons and evals, ecc report, status, README features and the release readiness report ([1769496](https://github.com/yeyo11/claudio/commit/1769496efe705f2b9509cedaba3ee2b79303c54c))
* **plans:** an expired sign-in is out, rotates, and a retry chooses again ([67f4039](https://github.com/yeyo11/claudio/commit/67f4039dc943484ce3e2c364be1f454934103076))
* **plans:** Claudio's default ports avoid both Agentry and the AVG stack ([0975683](https://github.com/yeyo11/claudio/commit/0975683a397fd2c6f3d8b5f6add3b60a6fe768cf))
* **plans:** collaborators — C0 complete: LAN and two-NAT runs, relay is the path across a carrier NAT ([c1d325f](https://github.com/yeyo11/claudio/commit/c1d325f07f8171f006f2605b97a3b43ac072b74a))
* **plans:** collaborators — C0 facts: iroh binding proved, watch* aborts, host process, byte ceiling ([519331e](https://github.com/yeyo11/claudio/commit/519331e715e81569acf99927011ad9cbbb7ec7e3))
* **plans:** collaborators — read-only P2P sharing of projects over iroh ([069c8a8](https://github.com/yeyo11/claudio/commit/069c8a8561a680b586634b215868ae4b2c3e46b9))
* **plans:** connectors from mcp_status — facts recorded, built in two parts ([a5ac0ee](https://github.com/yeyo11/claudio/commit/a5ac0ee6be8bd2f406dead6edde8cb190d3ad37e))
* **plans:** context control, guards, review gate, lessons, instruction evals and agent-run improvements ([a9157e7](https://github.com/yeyo11/claudio/commit/a9157e7bd695ce3fe4420b1a7dc15570b8fd0232))
* **plans:** live branches rebased on feat/claude-only, anchors re-checked ([3c7b687](https://github.com/yeyo11/claudio/commit/3c7b6877cb0376131e7ab828e176ed6b27e0218f))
* **plans:** readable tool rows, and what is running at a glance ([8fef57b](https://github.com/yeyo11/claudio/commit/8fef57b5db74f724d400d2f8ef4f98765c31a2db))
* **plans:** record the web side of models per account ([784ccc3](https://github.com/yeyo11/claudio/commit/784ccc387d004968395f1fb3f55f629d2051a634))
* **plans:** record what mcp_authenticate answers for a claude.ai connector ([301943a](https://github.com/yeyo11/claudio/commit/301943af6fc4f5488bc0e29395fb747280260db0))
* **plans:** resolve the open questions of the six ECC plans ([f02f34b](https://github.com/yeyo11/claudio/commit/f02f34b4fed2035c207cb43a3ee2d6ec35ac3120))
* **plans:** stage A2 (models per account via initialize, model fallback); mark SDK point 9 mcp built ([fd36a58](https://github.com/yeyo11/claudio/commit/fd36a58f347785f48e5bc94ec7c0cb6b1feb23ab))
* **plans:** switch a chat's account from the composer ([a740d57](https://github.com/yeyo11/claudio/commit/a740d578945cd961d659634735dfff16c76a7a65))
* **plans:** the C0 facts point at the spike in the repo ([04aa9cb](https://github.com/yeyo11/claudio/commit/04aa9cbec378c317bb02f6f6dba9ac8406f17106))
* **plans:** the flow has no spend pass yet ([9584a77](https://github.com/yeyo11/claudio/commit/9584a770bbc13f36a60fce581c106a665dbb8006))
* **plans:** the live-branches launch waits for context-control and agent-run-improvements ([08a2ad9](https://github.com/yeyo11/claudio/commit/08a2ad9efbf5246bae5700a2bed78c0ad3bbe89a))
* **plans:** the machine widget's design, option A of the resource-control plan ([7915267](https://github.com/yeyo11/claudio/commit/7915267f8dc52246f00fa66740db4e65a28c73f5))
* **plans:** the person's own terminal in Claudio, with the owner's decisions ([150e1f3](https://github.com/yeyo11/claudio/commit/150e1f34a18f4c807a73ac2621c37a6b1afe4a28))
* **readme:** link the MCP server doc by its new name ([9cedb31](https://github.com/yeyo11/claudio/commit/9cedb3142412e4556c22fc6c9ccf6ef77ebac517))
* **readme:** list subagent.activity among the /events types ([18b75f8](https://github.com/yeyo11/claudio/commit/18b75f83c8dd9ed59944cb62937999020ba057d7))
* **rename:** README, CLAUDE.md, CONTRIBUTING, docs and parity fixtures name Claudio; release restarts at 0.1.0 ([6192f78](https://github.com/yeyo11/claudio/commit/6192f7854a3b57ce4a8842b513371b88e8388d22))
* **reports:** checkpoint of 2026-10-16, everything in main ([aec29e5](https://github.com/yeyo11/claudio/commit/aec29e5f12bdabd90399a2c72bb6ff947bde30e5))
* **reports:** ideas from ECC worth bringing into Claudio, with the decisions taken ([a56d826](https://github.com/yeyo11/claudio/commit/a56d826e1fa6599de2d9c4abd27aecc6098747e8))
* **reports:** the Collaborators C0 spike's code and scrubbed results, kept in the repo ([96fc672](https://github.com/yeyo11/claudio/commit/96fc672bc7a853c1f498382310e6815bb25d2fdc))
* **requests:** a limit wait that ignores an account with room ([6772ff9](https://github.com/yeyo11/claudio/commit/6772ff9b4561decee8002efd3228b5d6ad508a9d))
* **requests:** a stopped task has no way back ([c153152](https://github.com/yeyo11/claudio/commit/c153152639dab1a3af30bcc9e73fb869706a1d47))
* **requests:** what the 2026-10-16 limit fixes closed, and what they left open ([4252509](https://github.com/yeyo11/claudio/commit/4252509aa285ba2e5a30c0993dafa8ae8a255a3e))
* **requests:** where the expired-login fix was started ([eb9a039](https://github.com/yeyo11/claudio/commit/eb9a039bf63558d813a53980503690596e1199c7))
* **review-gate:** document the gate as built, with its outcome and measured costs ([5bb38f2](https://github.com/yeyo11/claudio/commit/5bb38f2d6d9b6489eda703614f9fb1d54e9aa005))
* **review-gate:** record the CLI facts F1-F6 and the reviewer fixtures ([74b046b](https://github.com/yeyo11/claudio/commit/74b046ba4196e6e6ea5b8d3ae289b8053b263501))
* **status:** Claudio on main, verified with the full suite ([b5437ef](https://github.com/yeyo11/claudio/commit/b5437efeccab8bcf250c7d68ff0b22fbcfa760fa))
* team and flow, notifications, decision engine, security model, assistant, settings, deploy, README rows, status and the plan's outcome ([21a5918](https://github.com/yeyo11/claudio/commit/21a5918acb28d381df0cf95e8f93f7cf6c20b9bb))
* terminal security audit report ([6fa43a1](https://github.com/yeyo11/claudio/commit/6fa43a10f11f525fa4ff31277bbd6ffa4f5dbd5e))
* **terminal:** record the t0 facts spike and correct the plan ([826d3dc](https://github.com/yeyo11/claudio/commit/826d3dcef9080982162f7fe300429d31e7645912))
* **terminal:** the status bar panel, the close contract and the design variant ([a9e9550](https://github.com/yeyo11/claudio/commit/a9e9550ae4d3a8256a9ce0f9c11ec336e304c46a))
* the fork plan is built, the provider points are gone, and accounts switch before waiting ([d2fb3b4](https://github.com/yeyo11/claudio/commit/d2fb3b4fa2bb49603dcf64f81b59e89f86b02a63))
* the owner's open requests, so none is lost again ([63350cd](https://github.com/yeyo11/claudio/commit/63350cd7683cc76814f7b328cf5f42931b16b9f0))
* the tool rows and live branches feature, its outcome and the design notes ([2bb09b6](https://github.com/yeyo11/claudio/commit/2bb09b6bcc85b381d9bd0b1e0abc7c27faabe78e))

## Changelog

This file is maintained by [release-please](https://github.com/googleapis/release-please) from the
commit messages. Do not edit it by hand.
