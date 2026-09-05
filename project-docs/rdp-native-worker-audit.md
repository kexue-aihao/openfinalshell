# RDP Native Worker Audit

> Updated 2026-09-04 after the Windows x64 FreeRDP implementation and build-system follow-up.
> Scope: `native/rdp-worker/**`, `scripts/buildRdpWorker.mjs`,
> `scripts/checkRdpWorkerPackage.mjs`, `scripts/smokeRdpWorker.mjs`, and RDP integration code.

## Summary

The repository now contains both the backend-neutral OFSR protocol worker and a real FreeRDP
adapter. A Windows x64 worker built with FreeRDP advertises `workerVersion:"freerdp"` and the
`freerdp` capability; packaged builds reject mock-only workers. Local protocol, CTest, build,
runtime staging, and package-gate checks pass.

The remaining B2 acceptance gap is environmental rather than an unimplemented backend: no real
RDP server credentials are configured on this development machine, so the real-server smoke suite
skips. Authentication, certificate handling, framebuffer delivery, input, resize, clipboard, and
disconnect paths still need to be exercised together against an actual server before claiming
end-to-end production validation.

## Protocol And Host Integration

Implemented and covered by automated tests:

- A bounded 16-byte `OFSR` framed transport with strict JSON/control validation and a 64 MiB
  payload ceiling.
- Worker-first handshake and capability validation. Production requires a genuine FreeRDP worker;
  mock capability negotiation remains available for protocol tests.
- Password delivery occurs in a one-shot credential frame after startup and never in argv or the
  renderer. Certificate prompts use correlated request ids and strict policy rejects without
  involving the renderer prompt flow.
- Framebuffer messages use bounded dirty rectangles. Main-to-renderer MessagePort delivery keeps
  at most two unacknowledged frames, retains only the latest replacement frame under pressure,
  pauses Worker stdout while stalled, and recovers on ACK or a 500 ms timeout.
- Close, failure, reconnect, and Worker replacement preserve session identity while ignoring late
  events from an older Worker or MessagePort generation.

## FreeRDP Backend

Implemented in `freerdp_adapter.cpp`:

- FreeRDP allocation, settings population, connect/event-loop/disconnect lifecycle, and stable
  failure reporting.
- Username, domain, and one-shot password authentication without persisting credentials in the
  native worker.
- Certificate verification callbacks with prompt and strict-reject behavior.
- GDI framebuffer initialization and dirty-region BGRA frame publication.
- Keyboard, Unicode, pointer, button, and wheel input forwarding.
- Dynamic display resize through the display-control channel, with bounded dimensions.
- Text clipboard exchange through `cliprdr`.

The worker advertises `freerdp` only when compiled with the real adapter and linked dependencies.
The package checker rejects a mock worker when `--require-freerdp` is enabled.

## Build And Packaging

Windows x64 is the enabled native-worker release target.

- The build script honors `CMAKE_GENERATOR` or detects CMake's default generator. It passes `-A`
  only to Visual Studio generators; Ninja builds the host architecture without an unsupported
  platform argument. Non-host Windows architectures require a suitable Visual Studio generator
  or explicit cross-compilation toolchain.
- FreeRDP can be discovered through vcpkg/CMake packages or MSYS2 `pkg-config` prefixes.
- MSYS2 staging uses `ldd` to copy the worker's actual transitive DLL dependencies rather than an
  entire runtime prefix.
- Runtime manifests, third-party notices, and discovered dependency licenses are staged and then
  checksum-verified in packaged resources. MSYS2 `share/licenses/<package>/LICENSE*` layouts are
  supported.
- The current Windows x64 Ninja/MSYS2 build configures cleanly, passes all three CTests, passes the
  Node protocol test and package gate, and self-tests as a FreeRDP worker.

macOS, Linux, and Windows ARM64 native RDP packages remain disabled pending platform-specific
FreeRDP build, runtime dependency, and acceptance validation. Those targets must not silently ship
a mock worker as production RDP support.

## Real-Server Smoke Status

`scripts/smokeRdpWorker.mjs` is an opt-in real-server harness. It checks a FreeRDP self-test,
handshake, credential exchange, certificate handling, ready plus first framebuffer, input,
resize, clipboard, and graceful close. A certificate-rejection scenario can also be required.

The latest run skipped safely because `OFS_TEST_RDP_HOST`, `OFS_TEST_RDP_USERNAME`, and
`OFS_TEST_RDP_PASSWORD` were not present. `OFS_TEST_RDP_PORT`, `OFS_TEST_RDP_DOMAIN`,
`OFS_TEST_RDP_TIMEOUT_MS`, `OFS_TEST_RDP_EXPECT_CERT_PROMPT`, and
`OFS_TEST_RDP_CERT_REJECT` refine configured runs. No real-server PASS is claimed in this audit.

## Remaining Work

1. Run the smoke suite against an authorized Windows RDP test server and retain evidence for the
   accepted connection and certificate-rejection scenarios.
2. Validate unexpected network disconnect and application-level reconnect against that server;
   the current harness validates Worker connect/control/close behavior, while manager reconnect is
   covered by deterministic unit tests.
3. Perform the platform build, dependency, signing/notarization, and real-server matrix before
   enabling macOS, Linux, or Windows ARM64 native RDP packaging.
4. Complete release security and third-party-license review using the exact dependency versions
   contained in the final distributable.
