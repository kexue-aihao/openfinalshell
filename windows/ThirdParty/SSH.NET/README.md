# SSH.NET 2026.0.0 with terminal receive flow control

Pinned upstream: https://github.com/sshnet/SSH.NET/tree/2026.0.0

- Commit: 7b2fd3dbf2c86a80a7b06cea020aa5f821c9902e
- Source archive: https://github.com/sshnet/SSH.NET/archive/refs/tags/2026.0.0.zip
- Archive SHA-256: 7CB344979999C750C9B48E17F0550E0AF8DBC9865BD7ECAD4126FBA7D176C979
- License: MIT, retained in LICENSE and included in the desktop output.

The sources under Renci.SshNet are upstream sources with the changes recorded
in consumption-window.patch. The local project targets net10.0, matching Core,
and pins BouncyCastle 2.7.0 and Logging.Abstractions 8.0.3. It builds from source;
it does not load the SSH.NET NuGet binary or use reflection to alter SSH internals.

Upstream session channels advertise a 0x7fffffff-byte receive window and return
credit when packets arrive. This permits a large unread ShellStream buffer even
when the application's own queue is bounded. CreateBoundedShellStream opts into
a smaller receive window (256 KiB by default), decrements it on receipt and
returns consumed credit from raw Read calls in at least one-packet batches.
The network listener never waits for an application queue. Receive accounting
uses a separate lock; sending window adjustments happens outside that lock and
outside the stream buffer lock. Extended channel data joins the same byte stream
and consumes the same window. A peer exceeding the advertised window raises an
explicit channel error. Standard shell factories, SFTP, exec and forwarding
channels retain upstream behavior.

The bounded factory is deliberately for raw-byte consumption only. Use
Read(byte[], int, int), Read(Span<byte>) or ReadByte. ReadLine, Expect, parameterless
Read and event-only consumers do not acknowledge credit and must not be used on
this opt-in stream. OpenFinalShell has exactly one background raw reader.

The application disconnects the SSH session before disposing the shell to release
SSH.NET's synchronous Flush send-window wait. Canceling a started terminal write
closes that transport, because continuing after a partially sent input sequence
cannot preserve input semantics.

Regression coverage is in OpenFinalShell.NativeSsh.Tests: packet splitting,
full application queue, bounded internal buffer, independent exec during backpressure,
resume without byte loss, cancellation, reconnect and an optional 2.5-million-line
SSH burst checked by SHA-256 (OFS_SSH_BURST_STRESS=1).
