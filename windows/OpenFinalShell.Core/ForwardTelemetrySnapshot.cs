namespace OpenFinalShell.Core;

public sealed record ForwardTelemetrySnapshot(string ForwardId, long ActiveConnections, long TotalBytes);
