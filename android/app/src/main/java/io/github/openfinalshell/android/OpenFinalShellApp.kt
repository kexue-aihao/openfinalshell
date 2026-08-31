package io.github.openfinalshell.android

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.ScrollableTabRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.ssh.SftpEntry

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OpenFinalShellApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }

    state.hostKeyPrompt?.let { prompt ->
        AlertDialog(
            onDismissRequest = viewModel::rejectHostKey,
            title = { Text(androidx.compose.ui.res.stringResource(R.string.host_key_title)) },
            text = {
                Text(
                    androidx.compose.ui.res.stringResource(
                        R.string.host_key_message,
                        prompt.host,
                        prompt.port,
                        prompt.keyType,
                        prompt.fingerprint
                    )
                )
            },
            confirmButton = {
                TextButton(onClick = viewModel::acceptHostKey) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_trust))
                }
            },
            dismissButton = {
                TextButton(onClick = viewModel::rejectHostKey) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_reject))
                }
            }
        )
    }

    MaterialTheme {
        Scaffold(
            topBar = { TopAppBar(title = { Text(androidx.compose.ui.res.stringResource(R.string.app_name)) }) },
            bottomBar = {
                Surface(tonalElevation = 2.dp, modifier = Modifier.navigationBarsPadding()) {
                    Text(
                        text = state.status,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelMedium
                    )
                }
            }
        ) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                ScrollableTabRow(
                    selectedTabIndex = tab,
                    edgePadding = 12.dp,
                    containerColor = MaterialTheme.colorScheme.surface
                ) {
                    listOf(R.string.tab_connections, R.string.tab_terminal, R.string.tab_sftp, R.string.tab_monitor)
                        .forEachIndexed { index, label ->
                            Tab(
                                selected = tab == index,
                                onClick = { tab = index },
                                text = { Text(androidx.compose.ui.res.stringResource(label)) }
                            )
                        }
                }
                when (tab) {
                    0 -> ConnectionsScreen(state, viewModel)
                    1 -> TerminalScreen(state, viewModel)
                    2 -> SftpScreen(state, viewModel)
                    else -> MonitorScreen(state, viewModel)
                }
            }
        }
    }
}

@Composable
private fun ConnectionsScreen(state: AndroidUiState, viewModel: MainViewModel) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    val formValid = name.isNotBlank() && host.isNotBlank() && username.isNotBlank() &&
        (port.toIntOrNull()?.let { it in 1..65535 } == true)

    LazyColumn(
        modifier = Modifier.fillMaxSize().imePadding(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text(androidx.compose.ui.res.stringResource(R.string.saved_connections), style = MaterialTheme.typography.titleMedium)
        }
        if (state.profiles.isEmpty()) {
            item {
                EmptyState(
                    title = androidx.compose.ui.res.stringResource(R.string.connections_empty_title),
                    body = androidx.compose.ui.res.stringResource(R.string.connections_empty_body)
                )
            }
        } else {
            items(state.profiles, key = { it.id }) { profile ->
                ConnectionCard(
                    profile = profile,
                    selected = profile.id == state.selectedProfileId,
                    session = state.sessions.values.firstOrNull { it.profile.id == profile.id && it.state != SessionState.CLOSED },
                    onSelect = { viewModel.selectProfile(profile) },
                    onConnect = { viewModel.connect(profile, password) }
                )
            }
        }
        item {
            HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp))
            Text(androidx.compose.ui.res.stringResource(R.string.add_connection_title), style = MaterialTheme.typography.titleMedium)
        }
        item {
            OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_name)) }, singleLine = true)
        }
        item {
            OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_host)) }, singleLine = true)
        }
        item {
            OutlinedTextField(
                port, { port = it.filter(Char::isDigit).take(5) }, Modifier.fillMaxWidth(),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_port)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true
            )
        }
        item {
            OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_username)) }, singleLine = true)
        }
        item {
            OutlinedTextField(
                password, { password = it }, Modifier.fillMaxWidth(),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_password)) },
                visualTransformation = PasswordVisualTransformation(), singleLine = true
            )
        }
        item {
            Button(
                onClick = {
                    viewModel.addProfile(name, host, port.toInt(), username, password)
                    name = ""
                    host = ""
                    port = "22"
                    username = ""
                    password = ""
                },
                enabled = formValid,
                modifier = Modifier.fillMaxWidth()
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_add_connection)) }
        }
    }
}

@Composable
private fun ConnectionCard(
    profile: ConnectionProfile,
    selected: Boolean,
    session: io.github.openfinalshell.android.core.ssh.SessionSnapshot?,
    onSelect: () -> Unit,
    onConnect: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable(onClick = onSelect),
        border = if (selected) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null,
        colors = CardDefaults.cardColors(
            containerColor = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainerLow
        )
    ) {
        Column(Modifier.fillMaxWidth().padding(14.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(profile.name, style = MaterialTheme.typography.titleSmall)
                    Text("${profile.username}@${profile.host}:${profile.port}", style = MaterialTheme.typography.bodyMedium, maxLines = 2)
                }
                Button(onClick = onConnect) { Text(androidx.compose.ui.res.stringResource(R.string.action_connect)) }
            }
            session?.let {
                Surface(
                    color = if (it.state == SessionState.READY) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceVariant,
                    shape = MaterialTheme.shapes.small
                ) {
                    Text(it.state.name, Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
}

@Composable
private fun SftpScreen(state: AndroidUiState, viewModel: MainViewModel) {
    val path = state.sftpPath
    val parent = path.trimEnd('/').substringBeforeLast('/', "").ifBlank { "/" }
    var uploadLocalPath by remember { mutableStateOf("") }
    var uploadRemotePath by remember(path) { mutableStateOf(path.trimEnd('/') + "/") }
    var downloadRemotePath by remember(path) { mutableStateOf("") }
    var downloadLocalPath by remember { mutableStateOf("") }
    var directoryName by remember { mutableStateOf("") }
    var renamePath by remember { mutableStateOf("") }
    var renameName by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(androidx.compose.ui.res.stringResource(R.string.tab_sftp), style = MaterialTheme.typography.titleMedium)
                Text(path, fontFamily = FontFamily.Monospace, maxLines = 2)
            }
            Button(onClick = { viewModel.browseSftp() }, enabled = state.selectedSessionId != null) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_refresh))
            }
        }
        if (state.selectedSessionId == null) {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.sftp_connect_title),
                body = androidx.compose.ui.res.stringResource(R.string.sftp_connect_body)
            )
            return@Column
        }
        Button(onClick = { viewModel.browseSftp(parent) }, enabled = path != "/") {
            Text(androidx.compose.ui.res.stringResource(R.string.action_parent))
        }
        OutlinedTextField(
            value = uploadLocalPath,
            onValueChange = { uploadLocalPath = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(androidx.compose.ui.res.stringResource(R.string.label_local_file)) },
            singleLine = true
        )
        OutlinedTextField(
            value = uploadRemotePath,
            onValueChange = { uploadRemotePath = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(androidx.compose.ui.res.stringResource(R.string.label_remote_path)) },
            singleLine = true
        )
        Button(
            onClick = { viewModel.uploadSftp(uploadLocalPath, uploadRemotePath) },
            enabled = uploadLocalPath.isNotBlank() && uploadRemotePath.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text(androidx.compose.ui.res.stringResource(R.string.action_upload)) }
        OutlinedTextField(
            value = downloadRemotePath,
            onValueChange = { downloadRemotePath = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(androidx.compose.ui.res.stringResource(R.string.label_remote_file)) },
            singleLine = true
        )
        OutlinedTextField(
            value = downloadLocalPath,
            onValueChange = { downloadLocalPath = it },
            modifier = Modifier.fillMaxWidth(),
            label = { Text(androidx.compose.ui.res.stringResource(R.string.label_local_destination)) },
            singleLine = true
        )
        Button(
            onClick = { viewModel.downloadSftp(downloadRemotePath, downloadLocalPath) },
            enabled = downloadRemotePath.isNotBlank() && downloadLocalPath.isNotBlank(),
            modifier = Modifier.fillMaxWidth()
        ) { Text(androidx.compose.ui.res.stringResource(R.string.action_download)) }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = directoryName,
                onValueChange = { directoryName = it },
                modifier = Modifier.weight(1f),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_directory_name)) },
                singleLine = true
            )
            Button(
                onClick = { viewModel.createSftpDirectory(directoryName); directoryName = "" },
                enabled = directoryName.isNotBlank()
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_create)) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(
                value = renamePath,
                onValueChange = { renamePath = it },
                modifier = Modifier.weight(1f),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_rename_path)) },
                singleLine = true
            )
            OutlinedTextField(
                value = renameName,
                onValueChange = { renameName = it },
                modifier = Modifier.weight(1f),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_new_name)) },
                singleLine = true
            )
            Button(
                onClick = { viewModel.renameSftp(renamePath, renameName); renamePath = ""; renameName = "" },
                enabled = renamePath.isNotBlank() && renameName.isNotBlank()
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_rename)) }
        }
        if (state.sftpEntries.isEmpty()) {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.sftp_empty_title),
                body = androidx.compose.ui.res.stringResource(R.string.sftp_empty_body)
            )
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 8.dp)) {
                items(state.sftpEntries, key = { it.path }) { entry -> SftpEntryRow(entry, viewModel) }
            }
        }
        if (state.transfers.isNotEmpty()) {
            MetricCard(androidx.compose.ui.res.stringResource(R.string.transfer_queue)) {
                state.transfers.forEach { transfer ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(transfer.remotePath, maxLines = 1)
                            Text(
                                "${transfer.state.name} ${transfer.bytesTransferred}/${transfer.bytesTotal.coerceAtLeast(0)}",
                                style = MaterialTheme.typography.labelSmall
                            )
                            transfer.error?.let { error -> Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelSmall) }
                        }
                        when (transfer.state) {
                            io.github.openfinalshell.android.core.sftp.TransferState.RUNNING,
                            io.github.openfinalshell.android.core.sftp.TransferState.QUEUED -> Button(onClick = { viewModel.pauseTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_pause)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.PAUSED -> Button(onClick = { viewModel.resumeTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_resume)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.FAILED,
                            io.github.openfinalshell.android.core.sftp.TransferState.CANCELED -> Button(onClick = { viewModel.retryTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_retry)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.COMPLETED -> Unit
                        }
                        if (transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.COMPLETED &&
                            transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.FAILED &&
                            transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.CANCELED
                        ) {
                            Button(onClick = { viewModel.cancelTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_cancel)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SftpEntryRow(entry: SftpEntry, viewModel: MainViewModel) {
    val directory = entry.type == SftpEntry.Type.DIRECTORY
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (directory) "[DIR] ${entry.name}" else entry.name, fontFamily = if (directory) FontFamily.Default else FontFamily.Monospace, maxLines = 2)
                Text(entry.path, style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
            if (directory) {
                Button(onClick = { viewModel.browseSftp(entry.path) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_open)) }
            } else {
                Button(onClick = { viewModel.deleteSftp(entry.path) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
            }
        }
    }
}

@Composable
private fun TerminalScreen(state: AndroidUiState, viewModel: MainViewModel) {
    val sessionId = state.selectedSessionId
    val session = sessionId?.let { state.sessions[it] }
    val output = sessionId?.let { state.terminalOutput[it].orEmpty() }.orEmpty()
    val outputScroll = rememberScrollState()
    val actionsScroll = rememberScrollState()
    var input by remember(sessionId) { mutableStateOf("") }

    LaunchedEffect(sessionId, output) { outputScroll.scrollTo(outputScroll.maxValue) }
    LaunchedEffect(sessionId, session?.state) {
        if (sessionId != null && session?.state == SessionState.READY) viewModel.openShell(sessionId, 80, 24)
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 10.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(session?.profile?.name ?: androidx.compose.ui.res.stringResource(R.string.tab_terminal), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text(session?.state?.name ?: androidx.compose.ui.res.stringResource(R.string.terminal_no_session), style = MaterialTheme.typography.labelMedium)
        }
        if (sessionId == null) {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.terminal_select_connection),
                body = androidx.compose.ui.res.stringResource(R.string.terminal_select_body)
            )
            return@Column
        }
        Box(Modifier.fillMaxWidth().weight(1f).heightIn(min = 180.dp).background(Color.Black).verticalScroll(outputScroll).padding(10.dp)) {
            Text(
                text = output.ifEmpty { androidx.compose.ui.res.stringResource(R.string.terminal_connecting, session?.profile?.host ?: "server") },
                color = Color(0xffd6ffd6), fontFamily = FontFamily.Monospace
            )
        }
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
            BasicTextField(
                value = input, onValueChange = { input = it },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp).border(1.dp, MaterialTheme.colorScheme.outline).padding(12.dp),
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace), maxLines = 4
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = { viewModel.sendTerminalInput(sessionId, input); input = "" }, enabled = input.isNotEmpty()) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_send))
            }
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(actionsScroll), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { viewModel.sendTerminalInput(sessionId, "\n") }) { Text(androidx.compose.ui.res.stringResource(R.string.action_enter)) }
            Button(onClick = { viewModel.clearTerminal(sessionId) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_clear)) }
            Button(onClick = { viewModel.disconnect(sessionId) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_disconnect)) }
        }
    }
}

@Composable
private fun MonitorScreen(state: AndroidUiState, viewModel: MainViewModel) {
    val monitor = state.monitor
    val snapshot = monitor.snapshot
    LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(androidx.compose.ui.res.stringResource(R.string.tab_monitor), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
                Button(onClick = { if (monitor.running) viewModel.stopMonitoring() else viewModel.startMonitoring() }) {
                    Text(androidx.compose.ui.res.stringResource(if (monitor.running) R.string.action_stop else R.string.action_start))
                }
            }
        }
        item {
            Button(onClick = viewModel::refreshPortTraffic, enabled = state.selectedSessionId != null) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_ports))
            }
        }
        item { LatencyCard(monitor) }
        monitor.staticInfo?.let { info ->
            item {
                MetricCard(androidx.compose.ui.res.stringResource(R.string.monitor_server_info)) {
                    Text("${info.hostname} | ${info.distro}")
                    Text("${info.kernel} ${info.arch} | ${info.cpuCores} ${androidx.compose.ui.res.stringResource(R.string.monitor_cores)}")
                    if (info.ips.isNotEmpty()) Text(info.ips.joinToString())
                }
            }
        }
        snapshot?.let { current ->
            item {
                MetricCard(androidx.compose.ui.res.stringResource(R.string.monitor_resources)) {
                    Text(androidx.compose.ui.res.stringResource(R.string.monitor_cpu, current.cpu.usagePct, current.cpu.loadAvg.joinToString(" / ") { value -> "%.2f".format(value) }))
                    Text(androidx.compose.ui.res.stringResource(R.string.monitor_memory, formatBytes(current.mem.usedKb * 1024), formatBytes(current.mem.totalKb * 1024)))
                    current.net.firstOrNull()?.let { net -> Text(androidx.compose.ui.res.stringResource(R.string.monitor_network, net.iface, formatBytes(net.rxBps), formatBytes(net.txBps))) }
                }
            }
            current.diskFs?.takeIf { it.isNotEmpty() }?.let { disks ->
                item {
                    MetricCard(androidx.compose.ui.res.stringResource(R.string.monitor_disk)) {
                        disks.take(4).forEach { disk -> Text("${disk.mount}: ${"%.1f".format(disk.usePct)}%") }
                    }
                }
            }
        } ?: item {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.monitor_waiting_title),
                body = androidx.compose.ui.res.stringResource(R.string.monitor_latency_pending)
            )
        }
        monitor.ports?.let { ports ->
            item {
                MetricCard(androidx.compose.ui.res.stringResource(R.string.monitor_port_traffic)) {
                    if (ports.ports.isEmpty()) {
                        Text(androidx.compose.ui.res.stringResource(R.string.monitor_ports_empty))
                    } else {
                        ports.ports.take(20).forEach { port ->
                            Text(
                                if (port.ratesAvailable) androidx.compose.ui.res.stringResource(R.string.monitor_port_rate, port.port, port.connections, formatBytes(port.rxBps), formatBytes(port.txBps))
                                else androidx.compose.ui.res.stringResource(R.string.monitor_port_no_rate, port.port, port.connections)
                            )
                        }
                    }
                }
            }
        }
        monitor.error?.let { error -> item { Text(error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) } }
    }
}

@Composable
private fun LatencyCard(monitor: io.github.openfinalshell.android.core.monitor.MonitorState) {
    MetricCard(androidx.compose.ui.res.stringResource(R.string.monitor_latency)) {
        Text(androidx.compose.ui.res.stringResource(R.string.monitor_direct_latency, monitor.directLatencyMs?.let { "$it ms" } ?: "--"))
        Text(androidx.compose.ui.res.stringResource(R.string.monitor_connection_latency, monitor.connectionLatencyMs?.let { "$it ms" } ?: "--"))
    }
}

@Composable
private fun MetricCard(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            content()
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Column(Modifier.fillMaxWidth().padding(vertical = 24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
    }
}

private fun formatBytes(value: Long): String {
    if (value < 1024) return "$value B"
    val units = arrayOf("KiB", "MiB", "GiB", "TiB")
    var amount = value.toDouble()
    var index = -1
    while (amount >= 1024 && index < units.lastIndex) {
        amount /= 1024
        index++
    }
    return "%.1f ${units[index]}".format(amount)
}
