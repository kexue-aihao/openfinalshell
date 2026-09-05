import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const cmake = readFileSync('native/rdp-worker/CMakeLists.txt', 'utf8')
const buildScript = readFileSync('scripts/buildRdpWorker.mjs', 'utf8')
const checkScript = readFileSync('scripts/checkRdpWorkerPackage.mjs', 'utf8')
const smokeScript = readFileSync('scripts/smokeRdpWorker.mjs', 'utf8')
const adapter = readFileSync('native/rdp-worker/freerdp_adapter.cpp', 'utf8')
const protocolTest = readFileSync('native/rdp-worker/test/protocol.test.mjs', 'utf8')

describe('RDP native FreeRDP build contract', () => {
  it('links both FreeRDP core and client pkg-config modules for 2.x and 3.x', () => {
    expect(cmake).toContain('pkg_check_modules(FREERDP2 QUIET freerdp2 freerdp-client2)')
    expect(cmake).toContain('pkg_check_modules(FREERDP3 QUIET freerdp3 freerdp-client3)')
    expect(cmake).toContain('_CRT_SECURE_NO_WARNINGS NOMINMAX')
    expect(cmake).toContain('target_link_options(ofs-rdp-worker PRIVATE ${FREERDP_LDFLAGS_OTHER})')
    expect(cmake).toContain('find_package(FreeRDP-Client3 CONFIG QUIET)')
    expect(cmake).toContain('target_link_libraries(ofs-rdp-worker PRIVATE freerdp3 freerdp-client3 winpr3)')
  })

  it('lets native QA require a real FreeRDP backend instead of accepting the mock fallback', () => {
    expect(cmake).toContain('option(OFS_RDP_REQUIRE_FREERDP')
    expect(cmake).toContain('CMake targets were not found')
    expect(buildScript).toContain("hasFlag('--require-freerdp')")
    expect(buildScript).toContain("-DOFS_RDP_REQUIRE_FREERDP=${requireFreerdp ? 'ON' : 'OFF'}")
    expect(buildScript).toContain('process.env.CMAKE_TOOLCHAIN_FILE')
  })

  it('only passes -A to Visual Studio generators so Ninja builds remain portable', () => {
    expect(buildScript).toContain('function detectCmakeGenerator()')
    expect(buildScript).toContain('process.env.CMAKE_GENERATOR')
    expect(buildScript).toContain('supportsGeneratorPlatform(generator)')
    expect(buildScript).toContain("generator ?? 'an unknown generator'")
  })

  it('discovers MSYS2 FreeRDP prefixes and their license layout for staging', () => {
    expect(buildScript).toContain("spawnSync('pkg-config', ['--variable=prefix', module]")
    expect(buildScript).toContain('add(resolve(result.stdout.trim()))')
    expect(buildScript).toContain('runtimeNamesFromLdd(executablePath, root)')
    expect(buildScript).toContain("join(rootParent, 'usr', 'bin', 'ldd.exe')")
    expect(buildScript).toContain("join(base, 'share', 'licenses', name, 'LICENSE')")
    expect(buildScript).toContain("join(base, 'share', 'licenses', name, 'LICENSE.md')")
  })

  it('self-tests runnable packaged workers when FreeRDP is required', () => {
    expect(checkScript).toContain("spawnSync(workerPath, ['--self-test']")
    expect(checkScript).toContain('PATH: [dirname(workerPath), system32, systemRoot]')
    expect(checkScript).toContain("hello.workerVersion !== 'freerdp'")
    expect(checkScript).toContain("capabilities.includes('mock')")
    expect(checkScript).toContain('if (requireFreerdp && canRunTarget(platform, arch)) assertFreerdpCapability(packagedPath)')
  })

  it('keeps runtime dependencies and third-party notices in the packaged RDP worker directory', () => {
    expect(buildScript).toContain("const runtimeManifestName = 'rdp-worker-runtime.json'")
    expect(buildScript).toContain("const thirdPartyNoticeName = 'THIRD-PARTY-NOTICES.rdp-worker.txt'")
    expect(buildScript).toContain("for (const root of vcpkgRoots()) copyFrom(join(root, 'bin'))")
    expect(checkScript).toContain('Windows FreeRDP package must stage FreeRDP/WinPR runtime DLLs')
    expect(checkScript).toContain('Packaged RDP runtime dependency checksum differs from staged file')
    expect(checkScript).toContain('Packaged RDP license file checksum differs from staged file')
    expect(checkScript).toContain('runtime manifest must include at least one redistributed dependency license')
  })

  it('has an environment-gated real Windows x64 RDP backend smoke', () => {
    expect(smokeScript).toContain('OFS_TEST_RDP_HOST')
    expect(smokeScript).toContain("process.arch !== 'x64'")
    expect(smokeScript).toContain("workerVersion, 'freerdp'")
    expect(smokeScript).toContain("{ op: 'credential', kind: 'password', value: config.password }")
    expect(smokeScript).toContain("{ op: 'certificate', requestId: entry.requestId, accept: true }")
    expect(smokeScript).toContain("{ op: 'resize', width: 800, height: 600, dpi: 96 }")
  })

  it('runs native protocol CTest in mock and FreeRDP backend modes', () => {
    expect(protocolTest).toContain('detectWorkerVersion()')
    expect(protocolTest).toMatch(/if \(workerVersion === 'mock'\)\s*\{\s*testMainWorkerInteroperability\(\)/)
    expect(protocolTest).toMatch(/else if \(workerVersion === 'freerdp'\)\s*testFreeRdpStartWaitsForCredentialWithoutMockFrame\(\)/)
    expect(protocolTest).toContain("FreeRDP build never emits a mock framebuffer before authentication")
  })

  it('correlates native clipboard responses through a request ledger instead of one overwritten id', () => {
    expect(adapter).toContain('std::deque<std::uint32_t> pendingClipboardRequests')
    expect(adapter).toContain('pendingClipboardRequests.push_back(command.requestId)')
    expect(adapter).toContain('pendingClipboardRequests.front()')
    expect(adapter).toContain('pendingClipboardRequests.pop_front()')
    expect(adapter).not.toContain('pendingClipboardRequest = requestId')
  })

  it('owns every FreeRDP API call on one event thread and queues stdin commands', () => {
    expect(adapter).toContain('std::thread eventThread')
    expect(adapter).toContain('std::deque<Command> commands')
    expect(adapter).toContain('bool submit(Command command)')
    expect(adapter).toContain('void processCommands()')
    expect(adapter).not.toContain('connectThread')
  })

  it('uses the RDPEDISP monitor-layout API for dynamic resolution', () => {
    expect(adapter).toContain('#include <freerdp/client/disp.h>')
    expect(adapter).toContain('freerdp_client_load_addins')
    expect(adapter).toContain('FreeRDP_SupportDisplayControl')
    expect(adapter).toContain('SendMonitorLayout(disp, 1, &layout)')
    expect(adapter).not.toContain('freerdp_input_send_synchronize_event')
  })

  it('builds and executes the strict Unicode conversion test under CTest', () => {
    expect(cmake).toContain('add_executable(ofs-rdp-unicode-test')
    expect(cmake).toContain('add_test(NAME worker_unicode COMMAND ofs-rdp-unicode-test)')
  })
})
