package io.github.openfinalshell.android

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle

@Composable
fun OpenFinalShellApp(viewModel: MainViewModel) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    var tab by remember { mutableIntStateOf(0) }
    MaterialTheme {
        Scaffold(topBar = { TopAppBar(title = { Text("OpenFinalShell") }) }) { padding ->
            Column(Modifier.fillMaxSize().padding(padding)) {
                TabRow(selectedTabIndex = tab) {
                    listOf(R.string.tab_connections, R.string.tab_terminal, R.string.tab_monitor).forEachIndexed { index, label ->
                        Tab(selected = tab == index, onClick = { tab = index }, text = { Text(stringResource(label)) })
                    }
                }
                when (tab) {
                    0 -> ConnectionsScreen(state, viewModel)
                    1 -> TerminalScreen(state)
                    else -> MonitorScreen(state)
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
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(stringResource(R.string.saved_connections), style = MaterialTheme.typography.titleMedium)
        LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(state.profiles, key = { it.id }) { profile ->
                Card(Modifier.fillMaxWidth()) {
                    Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                        Column {
                            Text(profile.name, style = MaterialTheme.typography.titleSmall)
                            Text("${profile.username}@${profile.host}:${profile.port}")
                        }
                        Button(onClick = { viewModel.connect(profile, password) }) { Text(stringResource(R.string.action_connect)) }
                    }
                }
            }
        }
        OutlinedTextField(name, { name = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.label_name)) })
        OutlinedTextField(host, { host = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.label_host)) })
        OutlinedTextField(port, { port = it.filter(Char::isDigit) }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.label_port)) })
        OutlinedTextField(username, { username = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.label_username)) })
        OutlinedTextField(
            password,
            { password = it },
            Modifier.fillMaxWidth(),
            label = { Text(stringResource(R.string.label_password)) },
            visualTransformation = PasswordVisualTransformation()
        )
        Button(
            onClick = {
                val parsedPort = port.toIntOrNull() ?: 22
                if (name.isNotBlank() && host.isNotBlank() && username.isNotBlank()) {
                    viewModel.addProfile(name, host, parsedPort, username)
                    name = ""
                    host = ""
                    username = ""
                }
            },
            modifier = Modifier.fillMaxWidth()
        ) { Text(stringResource(R.string.action_add_connection)) }
        Text(
            when (state.status) {
                "Ready" -> stringResource(R.string.status_ready)
                "Profile saved" -> stringResource(R.string.status_profile_saved)
                "Connection requested" -> stringResource(R.string.status_connection_requested)
                else -> state.status
            },
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun TerminalScreen(state: AndroidUiState) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.tab_terminal), style = MaterialTheme.typography.titleMedium)
        Text(if (state.selectedProfileId == null) stringResource(R.string.terminal_select_connection) else stringResource(R.string.terminal_transport_pending))
    }
}

@Composable
private fun MonitorScreen(state: AndroidUiState) {
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.tab_monitor), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(R.string.monitor_latency_pending))
    }
}
