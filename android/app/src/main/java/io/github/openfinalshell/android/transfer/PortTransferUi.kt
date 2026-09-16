package io.github.openfinalshell.android.transfer

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.openfinalshell.android.MainViewModel
import io.github.openfinalshell.android.R
import io.github.openfinalshell.android.core.sftp.RemoteTextEncoding
import io.github.openfinalshell.android.core.sftp.RemoteTextEditor

@Composable
fun SftpTransferActions(viewModel: MainViewModel, onDownloadDirectory: (Uri) -> Unit) {
    val context = LocalContext.current
    val state by viewModel.portTransfer.collectAsStateWithLifecycle()
    var showEncodings by remember { mutableStateOf(false) }
    val upload = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        uris.forEach { uri -> runCatching { context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION) } }
        if (uris.isNotEmpty()) viewModel.uploadDocuments(uris)
    }
    val directory = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let {
            runCatching { context.contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            viewModel.uploadDocuments(listOf(it), directory = true)
        }
    }
    val destination = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let { if (viewModel.setTransferDownloadTree(it)) onDownloadDirectory(it) }
    }
    val packed = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let {
            runCatching { context.contentResolver.takePersistableUriPermission(it, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
            viewModel.uploadPackedDirectory(it)
        }
    }
    Column {
        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            TextButton(onClick = { upload.launch(arrayOf("*/*")) }) { Text(stringResource(R.string.port_upload_files)) }
            TextButton(onClick = { directory.launch(null) }) { Text(stringResource(R.string.port_upload_directory)) }
            TextButton(onClick = { packed.launch(null) }) { Text(stringResource(R.string.port_pack_upload)) }
            TextButton(onClick = { destination.launch(viewModel.configuredDownloadTree()) }) { Text(stringResource(R.string.action_choose_directory)) }
        }
        Text(stringResource(R.string.port_resume_note), style = MaterialTheme.typography.labelSmall)
        Box {
            TextButton(onClick = { showEncodings = true }) {
                Text(stringResource(R.string.port_editor_encoding, RemoteTextEncoding.entries.first { it.id == state.editorEncoding }.label))
            }
            DropdownMenu(expanded = showEncodings, onDismissRequest = { showEncodings = false }) {
                RemoteTextEncoding.entries.forEach { encoding ->
                    DropdownMenuItem(text = {
                        Text(encoding.label + if (RemoteTextEditor.isEncodingAvailable(encoding)) "" else " · " + stringResource(R.string.port_encoding_unavailable))
                    }, onClick = { viewModel.chooseRemoteEditorEncoding(encoding.id); showEncodings = false })
                }
            }
        }
    }
}

@Composable
fun SftpDownloadButton(path: String, viewModel: MainViewModel, onDownloadDirectory: (Uri) -> Unit) {
    val chooser = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
        uri?.let { if (viewModel.setTransferDownloadTree(it)) { onDownloadDirectory(it); viewModel.downloadDocument(path, it) } }
    }
    TextButton(onClick = {
        if (viewModel.configuredDownloadTree() == null) chooser.launch(null) else viewModel.downloadDocument(path)
    }) { Text(stringResource(R.string.action_download)) }
}

/** Dialog state belongs to the ViewModel, so navigation/rotation never requeues operations. */
@Composable
fun PortTransferDialogs(viewModel: MainViewModel) {
    val state by viewModel.portTransfer.collectAsStateWithLifecycle()
    state.conflictPath?.let { path ->
        AlertDialog(onDismissRequest = { viewModel.resolveTransferConflict(false) },
            title = { Text(stringResource(R.string.port_conflict_title)) }, text = { Text(path) },
            confirmButton = { TextButton(onClick = { viewModel.resolveTransferConflict(true) }) { Text(stringResource(R.string.settings_conflict_overwrite)) } },
            dismissButton = { TextButton(onClick = { viewModel.resolveTransferConflict(false) }) { Text(stringResource(R.string.settings_conflict_skip)) } })
    }
    state.editor?.let { original ->
        var discard by remember { mutableStateOf(false) }
        var search by remember { mutableStateOf("") }
        var editorValue by remember(original.path) { mutableStateOf(TextFieldValue(state.editorText)) }
        LaunchedEffect(state.editorText) {
            if (editorValue.text != state.editorText) editorValue = TextFieldValue(state.editorText)
        }
        val close = { if (state.editorText != original.text) discard = true else viewModel.closeRemoteEditor() }
        Dialog(onDismissRequest = { if (!state.editorBusy) close() }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
            Surface(Modifier.fillMaxSize()) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(original.path, style = MaterialTheme.typography.titleMedium)
                    Text(RemoteTextEncoding.entries.first { it.id == original.encoding }.label + (if (original.eol == "mixed") "" else " · " + original.eol.uppercase()) +
                        if (original.hasBom) " · BOM" else "", style = MaterialTheme.typography.labelSmall)
                    if (original.eol == "mixed") Text(stringResource(R.string.port_eol_mixed), style = MaterialTheme.typography.labelSmall)
                    Row {
                        TextButton(onClick = { close() }, enabled = !state.editorBusy) { Text(stringResource(R.string.port_close)) }
                        TextButton(onClick = { viewModel.saveRemoteEditor() }, enabled = !state.editorBusy && state.editorText != original.text) { Text(stringResource(R.string.port_save)) }
                    }
                    if (state.editorBusy) LinearProgressIndicator(Modifier.fillMaxWidth())
                    OutlinedTextField(value = search, onValueChange = { search = it }, modifier = Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.port_find)) }, singleLine = true)
                    if (search.isNotEmpty()) Row {
                        Text(stringResource(R.string.port_find_count, Regex(Regex.escape(search)).findAll(state.editorText).count()))
                        TextButton(onClick = {
                            val next = state.editorText.indexOf(search, editorValue.selection.end).takeIf { it >= 0 }
                                ?: state.editorText.indexOf(search)
                            if (next >= 0) editorValue = editorValue.copy(selection = TextRange(next, next + search.length))
                        }) { Text(stringResource(R.string.port_find)) }
                    }
                    OutlinedTextField(value = editorValue, onValueChange = { editorValue = it; viewModel.editRemoteText(it.text) }, modifier = Modifier.fillMaxWidth().weight(1f),
                        textStyle = LocalTextStyle.current.copy(fontFamily = FontFamily.Monospace), enabled = !state.editorBusy)
                }
            }
        }
        if (discard) AlertDialog(onDismissRequest = { discard = false }, title = { Text(stringResource(R.string.port_discard)) },
            confirmButton = { TextButton(onClick = { discard = false; viewModel.closeRemoteEditor() }) { Text(stringResource(R.string.port_close)) } },
            dismissButton = { TextButton(onClick = { discard = false }) { Text(stringResource(R.string.action_cancel)) } })
        if (state.editorConflict) AlertDialog(onDismissRequest = {}, title = { Text(stringResource(R.string.port_editor_conflict)) },
            text = { Text(stringResource(R.string.port_editor_reload)) },
            confirmButton = { TextButton(onClick = { viewModel.openRemoteEditor(original.path, original.encoding) }) { Text(stringResource(R.string.action_refresh)) } },
            dismissButton = { TextButton(onClick = { viewModel.dismissEditorConflict() }) { Text(stringResource(R.string.action_cancel)) } })
        if (state.nonAtomicConfirmation) AlertDialog(onDismissRequest = viewModel::cancelNonAtomicSave,
            title = { Text(stringResource(R.string.port_non_atomic)) }, text = { Text(stringResource(R.string.port_non_atomic_warning)) },
            confirmButton = { TextButton(onClick = { viewModel.saveRemoteEditor(true) }) { Text(stringResource(R.string.port_save)) } },
            dismissButton = { TextButton(onClick = viewModel::cancelNonAtomicSave) { Text(stringResource(R.string.action_cancel)) } })
    }
    state.messageRes?.let { message ->
        AlertDialog(onDismissRequest = viewModel::clearTransferMessage,
            title = { Text(stringResource(R.string.tab_sftp)) }, text = { Text(stringResource(message)) },
            confirmButton = { TextButton(onClick = viewModel::clearTransferMessage) { Text(stringResource(R.string.port_close)) } })
    }
}
