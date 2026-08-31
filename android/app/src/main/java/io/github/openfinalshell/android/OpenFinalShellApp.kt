package io.github.openfinalshell.android

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.openfinalshell.android.core.model.SessionState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OpenFinalShellApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    MaterialTheme {
        Scaffold(topBar = { TopAppBar(title = { Text("OpenFinalShell") }) }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                TabRow(selectedTabIndex = tab) {
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
private fun SftpScreen(state: AndroidUiState, viewModel: MainViewModel) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("SFTP", style = MaterialTheme.typography.titleMedium)
            Button(onClick = { viewModel.browseSftp() }, enabled = state.selectedSessionId != null) { Text("Refresh") }
        }
        Text(state.sftpPath, fontFamily = FontFamily.Monospace)
        if (state.selectedSessionId == null) {
            Text("Connect to a server to browse files")
            return@Column
        }
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(state.sftpEntries, key = { it.path }) { entry ->
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    Text((if (entry.type == io.github.openfinalshell.android.core.ssh.SftpEntry.Type.DIRECTORY) "[DIR] " else "") + entry.name,
                        modifier = Modifier.weight(1f))
                    if (entry.type == io.github.openfinalshell.android.core.ssh.SftpEntry.Type.DIRECTORY) {
                        Button(onClick = { viewModel.browseSftp(entry.path) }) { Text("Open") }
                    } else {
                        Button(onClick = { viewModel.deleteSftp(entry.path) }) { Text("Delete") }
                    }
                }
            }
        }
        Text(state.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ConnectionsScreen(state: AndroidUiState, viewModel: MainViewModel) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    Column(
        Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        Text(androidx.compose.ui.res.stringResource(R.string.saved_connections), style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.profiles, key = { it.id }) { profile ->
                val session = state.sessions.values.firstOrNull { it.profile.id == profile.id && it.state != SessionState.CLOSED }
                Card(
                    Modifier.fillMaxWidth().clickable { viewModel.selectProfile(profile) }
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(profile.name, style = MaterialTheme.typography.titleSmall)
                            Text("${profile.username}@${profile.host}:${profile.port}")
                            if (session != null) Text(session.state.name)
                        }
                        Button(onClick = { viewModel.connect(profile, password) }) {
                            Text(androidx.compose.ui.res.stringResource(R.string.action_connect))
                        }
                    }
                }
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_name)) })
        OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_host)) })
        OutlinedTextField(port, { port = it.filter(Char::isDigit) }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_port)) })
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.label_username)) })
        OutlinedTextField(
            password,
            { password = it },
            Modifier.fillMaxWidth(),
            label = { Text(androidx.compose.ui.res.stringResource(R.string.label_password)) },
            visualTransformation = PasswordVisualTransformation()
        )
        Button(
            onClick = {
                val parsedPort = port.toIntOrNull() ?: 22
                if (name.isNotBlank() && host.isNotBlank() && username.isNotBlank()) {
                    viewModel.addProfile(name, host, parsedPort, username, password)
                    name = ""
                    host = ""
                    username = ""
                    password = ""
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text(androidx.compose.ui.res.stringResource(R.string.action_add_connection)) }
        Text(state.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TerminalScreen(state: AndroidUiState, viewModel: MainViewModel) {
    val sessionId = state.selectedSessionId
    val session = sessionId?.let { state.sessions[it] }
    val output = sessionId?.let { state.terminalOutput[it].orEmpty() }.orEmpty()
    val scrollState = rememberScrollState()
    var input by remember(sessionId) { mutableStateOf("") }

    LaunchedEffect(sessionId, output) {
        scrollState.scrollTo(scrollState.maxValue)
    }
    LaunchedEffect(sessionId, session?.state) {
        if (sessionId != null && session?.state == SessionState.READY) {
            viewModel.openShell(sessionId, 80, 24)
        }
    }

    Column(Modifier.fillMaxSize().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text(session?.profile?.name ?: "Terminal", style = MaterialTheme.typography.titleMedium)
            Text(session?.state?.name ?: "No session")
        }
        if (sessionId == null) {
            Text(androidx.compose.ui.res.stringResource(R.string.terminal_select_connection))
            return@Column
        }
        Text(
            text = output.ifEmpty { "Connecting to ${session?.profile?.host ?: "server"}..." },
            modifier = Modifier
                .fillMaxWidth()
                .weight(1f)
                .background(Color.Black)
                .verticalScroll(scrollState)
                .padding(10.dp),
            color = Color(0xffd6ffd6),
            fontFamily = FontFamily.Monospace
        )
        Row(Modifier.fillMaxWidth(), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            BasicTextField(
                value = input,
                onValueChange = { input = it },
                modifier = Modifier
                    .weight(1f)
                    .border(1.dp, MaterialTheme.colorScheme.outline)
                    .padding(12.dp),
                textStyle = MaterialTheme.typography.bodyLarge.copy(fontFamily = FontFamily.Monospace),
                singleLine = false
            )
            Spacer(Modifier.width(8.dp))
            Button(onClick = {
                viewModel.sendTerminalInput(sessionId, input)
                input = ""
            }) { Text("Send") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { viewModel.sendTerminalInput(sessionId, "\n") }) { Text("Enter") }
            Button(onClick = { viewModel.clearTerminal(sessionId) }) { Text("Clear") }
            Button(onClick = { viewModel.disconnect(sessionId) }) { Text("Disconnect") }
        }
    }
}

@Composable
private fun MonitorScreen(state: AndroidUiState, viewModel: MainViewModel) {
    val monitor = state.monitor
    val snapshot = monitor.snapshot
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(androidx.compose.ui.res.stringResource(R.string.tab_monitor), style = MaterialTheme.typography.titleMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { if (monitor.running) viewModel.stopMonitoring() else viewModel.startMonitoring() }) {
                Text(if (monitor.running) "Stop" else "Start")
            }
            Button(onClick = viewModel::refreshPortTraffic, enabled = state.selectedSessionId != null) { Text("Ports") }
        }
        Text("Direct latency: ${monitor.directLatencyMs?.let { "$it ms" } ?: "--"}")
        Text("Connection latency: ${monitor.connectionLatencyMs?.let { "$it ms" } ?: "--"}")
        monitor.staticInfo?.let { info ->
            Text("${info.hostname} | ${info.distro} | ${info.kernel} ${info.arch} | ${info.cpuCores} cores")
        }
        snapshot?.let {
            Text("CPU ${it.cpu.usagePct}%   Load ${it.cpu.loadAvg.joinToString(" / ") { value -> "%.2f".format(value) }}")
            Text("Memory ${it.mem.usedKb} / ${it.mem.totalKb} KiB")
            if (it.net.isNotEmpty()) Text("Network: " + it.net.joinToString { net -> "${net.iface} ${net.rxBps}/${net.txBps} B/s" })
            it.diskFs?.let { disks -> if (disks.isNotEmpty()) Text("Disk: " + disks.joinToString { disk -> "${disk.mount} ${disk.usePct}%" }) }
        } ?: Text(androidx.compose.ui.res.stringResource(R.string.monitor_latency_pending))
        monitor.ports?.let { ports ->
            Text("Port traffic", style = MaterialTheme.typography.titleSmall)
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                items(ports.ports, key = { it.port }) { port ->
                    Text("${port.port}: ${port.connections} connections, ${if (port.ratesAvailable) "${port.rxBps}/${port.txBps} B/s" else "rate unavailable"}")
                }
            }
        }
        Text(state.status, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
