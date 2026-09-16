package io.github.openfinalshell.android.transfer

import io.github.openfinalshell.android.core.sftp.RemoteTextDocument

data class PortTransferState(
    val conflictPath: String? = null,
    val messageRes: Int? = null,
    val editor: RemoteTextDocument? = null,
    val editorText: String = "",
    val editorEncoding: String = "utf8",
    val editorBusy: Boolean = false,
    val nonAtomicConfirmation: Boolean = false,
    val editorConflict: Boolean = false
)
