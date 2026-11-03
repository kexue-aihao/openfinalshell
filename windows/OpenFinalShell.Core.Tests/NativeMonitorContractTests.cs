using OpenFinalShell.Core;

public static class NativeMonitorContractTests
{
    public static void Run(Action<bool, string> check)
    {
        const string first = """
@@UPTIME@@
1000.00 2000.00
@@LOAD@@
0.10 0.20 0.30 1/100 123
@@CPU@@
cpu 100 0 50 800 0 0 0 0
cpu0 50 0 25 400 0 0 0 0
cpu1 50 0 25 400 0 0 0 0
@@MEM@@
MemTotal: 100000
MemAvailable: 40000
SwapTotal: 8000
SwapFree: 3000
@@NET@@
eth0 1000 2000
lo 100000 100000
@@DISKIO@@
sda 10 20
sda1 10 20
@@DF@@
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 100 70 30 70% /
tmpfs 100 2 98 2% /run
@@PROCS@@
10 12.5 3.0 sshd
11 1.0 1.0 worker process
@@SOCK@@
sockets: used 33
TCP: inuse 10 orphan 1 tw 2 alloc 20 mem 1
UDP: inuse 4 mem 1
TCP6: inuse 3
UDP6: inuse 2
@@TCP@@
01 4
0A 2
""";
        const string second = """
@@UPTIME@@
1002.00 2004.00
@@LOAD@@
0.50 0.40 0.30 2/100 125
@@CPU@@
cpu 110 0 70 870 0 0 0 0
cpu0 60 0 35 420 0 0 0 0
cpu1 50 0 35 450 0 0 0 0
@@MEM@@
MemTotal: 100000
MemAvailable: 35000
SwapTotal: 8000
SwapFree: 3000
@@NET@@
eth0 10000 10000
@@DISKIO@@
sda 20 40
@@DF@@
Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/sda1 100 75 25 75% /
@@PROCS@@
10 22.0 4.0 sshd
@@SOCK@@
sockets: used 35
TCP: inuse 12 orphan 1 tw 3 alloc 21 mem 1
UDP: inuse 4 mem 1
TCP6: inuse 3
@@TCP@@
01 7
0A 1
""";

        var firstFrame = NativeMonitorParser.Parse(first, null, 1000, 0);
        var snapshot = firstFrame.Snapshot;
        check(snapshot.Cpu.PerCore.Count == 2 && snapshot.Cpu.PerCore.All(value => value == 0), "monitor parser exposes per-core CPU baseline");
        check(snapshot.DiskFs?.Count == 1 && snapshot.DiskFs[0].UsePct == 70 && snapshot.DiskIo?.Count == 1, "monitor parser parses disk capacity and excludes partitions");
        check(snapshot.TopProcesses?.Count == 2 && snapshot.TopProcesses[0].Name == "sshd" && snapshot.TopProcesses[1].Name == "worker process", "monitor parser preserves process names containing spaces and sorts by CPU");
        check(snapshot.Connections is { SocketsUsed: 33, TcpInUse: 13, TcpOrphan: 1, TcpTimeWait: 2, UdpInUse: 6 }, "monitor parser aggregates IPv4 and IPv6 socket counters");

        var secondFrame = NativeMonitorParser.Parse(second, firstFrame.Counters, 3000, 2, 42.5);
        snapshot = secondFrame.Snapshot;
        check(Math.Abs(snapshot.Cpu.UsagePct - 30) < 0.01 && snapshot.Cpu.PerCore.Count == 2 && Math.Abs(snapshot.Cpu.PerCore[0] - 50) < 0.01, "monitor parser calculates total and per-core CPU deltas");
        check(snapshot.Network.Single().RxBps == 4500 && snapshot.Network.Single().TxBps == 4000, "monitor parser calculates interface byte rates");
        check(snapshot.DiskIo?.Single() is { ReadBps: 2560, WriteBps: 5120 }, "monitor parser calculates disk I/O byte rates");
        check(snapshot.TcpStates is { Count: 2 } && snapshot.TcpStates["ESTABLISHED"] == 7 && snapshot.TcpStates["LISTEN"] == 1, "monitor parser maps TCP state counters");
        check(snapshot.ConnectionLatencyMs == 42.5 && snapshot.UptimeSeconds == 1002 && snapshot.Memory.UsedKb == 65000, "monitor parser preserves latency, uptime, and memory usage");

        var malformedRejected = false;
        try { NativeMonitorParser.Parse("@@UPTIME@@\nnot-a-counter\n", null, 1, 1); }
        catch (InvalidDataException) { malformedRejected = true; }
        check(malformedRejected, "monitor parser rejects incomplete or malformed required metrics");
    }
}
