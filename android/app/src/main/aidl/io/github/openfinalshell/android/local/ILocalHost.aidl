// The interface the app uses to ask a Shizuku user service — which runs as the ADB shell uid, or as
// root when Shizuku itself runs as root — to start a PTY host.
//
// The service does not carry terminal bytes. It copies the host binary into a private directory,
// verifies it, executes it, and reports the loopback port; the terminal traffic then goes directly
// over that socket. Routing a terminal through Binder would mean the deprecated `newProcess` path
// and its missing tty support.

// AIDL requires ids on either all methods or none, so declaring the cleanup transaction id forces
// the rest to be numbered too. Reordering or renaming these is a breaking change to the interface,
// which is what USER_SERVICE_VERSION in ShizukuHostLauncher exists to signal.

package io.github.openfinalshell.android.local;

interface ILocalHost {
    /**
     * Tells the service what to execute and what it must look like.
     *
     * Called once after binding. The digest is compared before every launch, so a helper swapped
     * between the app reading it and the service copying it is refused rather than executed.
     */
    void configure(String helperPath, String helperSha256) = 1;

    /**
     * Copies, verifies and starts the host. Returns the loopback port it bound, or 0 on failure.
     *
     * A port of 0 rather than an exception because a failed launch is an expected outcome — the
     * helper may simply not be executable in this device's configuration — and AIDL exceptions
     * across a service boundary carry far less useful detail.
     */
    int start(in String[] args) = 2;

    /** "<uid> <selinux context>", for the tier badge and for diagnosing a denial. */
    String describe() = 3;

    /** Terminates every host this service started. */
    void stopAll() = 4;

    /** Shizuku calls this to clean up; the process is not killed for us, so it exits here. */
    void destroy() = 16777114;
}
