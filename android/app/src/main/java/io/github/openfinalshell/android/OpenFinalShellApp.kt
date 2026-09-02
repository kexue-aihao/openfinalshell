package io.github.openfinalshell.android

import android.content.Intent
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.filled.List
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import android.net.Uri
import io.github.openfinalshell.android.storage.AndroidSettings
import io.github.openfinalshell.android.core.model.ConnectionProfile
import io.github.openfinalshell.android.core.model.SessionState
import io.github.openfinalshell.android.core.ssh.SftpEntry
import io.github.openfinalshell.android.core.terminal.TerminalCursorStyle
import io.github.openfinalshell.android.update.UpdateState
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.viewinterop.AndroidView
import io.github.openfinalshell.android.ui.OpenFinalShellTheme
import io.github.openfinalshell.android.ui.OpenFinalShellSpacing
import io.github.openfinalshell.android.terminal.SshTerminalView

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun OpenFinalShellApp(
    viewModel: MainViewModel,
    settingsViewModel: SettingsViewModel,
    lanSyncViewModel: LanSyncViewModel
) {
    val state by viewModel.state.collectAsStateWithLifecycle()
    val settingsState by settingsViewModel.state.collectAsStateWithLifecycle()
    val lanSyncState by lanSyncViewModel.state.collectAsStateWithLifecycle()
    val snackbarHost = remember { SnackbarHostState() }
    val statusText = uiStatusText(state.status)
    // Keep the existing page indexes so session state and ViewModel calls remain unchanged.
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var showMore by rememberSaveable { mutableStateOf(false) }
    var deferredUpdateTag by rememberSaveable { mutableStateOf<String?>(null) }
    var installAfterPermission by rememberSaveable { mutableStateOf(false) }
    val updatePermissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) {
        if (installAfterPermission && settingsViewModel.canInstallPackages()) {
            settingsViewModel.installUpdate()
        }
        installAfterPermission = false
    }
    val requestUpdateInstall = {
        if (settingsViewModel.canInstallPackages()) {
            settingsViewModel.installUpdate()
        } else {
            installAfterPermission = true
            updatePermissionLauncher.launch(settingsViewModel.installPermissionIntent())
        }
    }

    LaunchedEffect(settingsState.update) {
        if (settingsState.update !is UpdateState.Ready) deferredUpdateTag = null
    }
    LaunchedEffect(state.status) {
        if (state.status.key != StatusKey.READY) snackbarHost.showSnackbar(statusText)
    }

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

    val darkTheme = when (settingsState.settings.theme) {
        "dark" -> true
        "light" -> false
        else -> isSystemInDarkTheme()
    }
    val primary = runCatching { Color(android.graphics.Color.parseColor(settingsState.settings.accentColor)) }
        .getOrDefault(Color(0xFF1677FF))
    OpenFinalShellTheme(darkTheme = darkTheme, accentColor = primary) {
        val readyUpdate = settingsState.update as? UpdateState.Ready
        if (readyUpdate != null && deferredUpdateTag != readyUpdate.release.tagName) {
            UpdateReadyDialog(
                versionName = readyUpdate.release.versionName,
                onDefer = { deferredUpdateTag = readyUpdate.release.tagName },
                onInstall = {
                    deferredUpdateTag = readyUpdate.release.tagName
                    requestUpdateInstall()
                }
            )
        }
        BoxWithConstraints(Modifier.fillMaxSize()) {
            val wideLayout = maxWidth >= 600.dp
            // More destinations must not make the previous primary destination look selected.
            val primaryTab = if (tab in 0..3) tab else -1
            val pageTitle = when (tab) {
                0 -> R.string.tab_connections
                1 -> R.string.tab_terminal
                2 -> R.string.tab_sftp
                3 -> R.string.tab_monitor
                4 -> R.string.tab_forwards
                5 -> R.string.tab_sync
                else -> R.string.tab_settings
            }
            Scaffold(
                topBar = {
                    TopAppBar(
                        title = {
                            Column {
                                Text(androidx.compose.ui.res.stringResource(pageTitle))
                                if (tab in 1..3) {
                                    val selected = state.selectedSessionId?.let { state.sessions[it] }
                                    selected?.profile?.let {
                                        Text(
                                            text = "${it.username}@${it.host}",
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1
                                        )
                                    }
                                }
                            }
                        }
                    )
                },
                bottomBar = {
                    if (!wideLayout) {
                        MainNavigationBar(
                            selected = primaryTab,
                            moreSelected = tab >= 4,
                            onSelect = { index -> tab = index },
                            onMore = { showMore = true }
                        )
                    }
                },
                snackbarHost = { SnackbarHost(snackbarHost) }
            ) { padding ->
                Row(Modifier.fillMaxSize().padding(padding)) {
                    if (wideLayout) {
                        MainNavigationRail(
                            selected = primaryTab,
                            moreSelected = tab >= 4,
                            onSelect = { index -> tab = index },
                            onMore = { showMore = true }
                        )
                    }
                    Column(Modifier.fillMaxSize().weight(1f)) {
                        when (tab) {
                            0 -> ConnectionsScreen(state, viewModel)
                            1 -> TerminalScreen(
                                state,
                                viewModel,
                                settingsState.settings.terminalFontSize,
                                settingsState.settings.terminalCursorStyle
                            )
                            2 -> SftpScreen(state, viewModel)
                            3 -> MonitorScreen(state, viewModel)
                            4 -> ForwardScreen(state, viewModel)
                            5 -> LanSyncScreen(lanSyncState, lanSyncViewModel)
                            else -> SettingsScreen(settingsViewModel, settingsState, viewModel, state, requestUpdateInstall)
                        }
                    }
                }
            }
        }
        if (showMore) {
            ModalBottomSheet(onDismissRequest = { showMore = false }) {
                MoreNavigationItem(R.string.tab_forwards, Icons.AutoMirrored.Filled.ArrowForward) {
                    tab = 4
                    showMore = false
                }
                MoreNavigationItem(R.string.tab_sync, Icons.Filled.Refresh) {
                    tab = 5
                    showMore = false
                }
                MoreNavigationItem(R.string.tab_settings, Icons.Filled.Settings) {
                    tab = 6
                    showMore = false
                }
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

@Composable
private fun MainNavigationBar(
    selected: Int,
    moreSelected: Boolean,
    onSelect: (Int) -> Unit,
    onMore: () -> Unit
) {
    val connectionsLabel = androidx.compose.ui.res.stringResource(R.string.tab_connections)
    val terminalLabel = androidx.compose.ui.res.stringResource(R.string.tab_terminal)
    val sftpLabel = androidx.compose.ui.res.stringResource(R.string.tab_sftp)
    val monitorLabel = androidx.compose.ui.res.stringResource(R.string.tab_monitor)
    val moreLabel = androidx.compose.ui.res.stringResource(R.string.nav_more)
    NavigationBar {
        NavigationBarItem(
            selected = selected == 0,
            onClick = { onSelect(0) },
            icon = { Icon(Icons.Filled.Home, contentDescription = null) },
            label = { Text(connectionsLabel, maxLines = 1) },
            modifier = Modifier.semantics {
                contentDescription = connectionsLabel
            }
        )
        NavigationBarItem(
            selected = selected == 1,
            onClick = { onSelect(1) },
            icon = { Icon(Icons.Filled.Edit, contentDescription = null) },
            label = { Text(terminalLabel, maxLines = 1) },
            modifier = Modifier.semantics {
                contentDescription = terminalLabel
            }
        )
        NavigationBarItem(
            selected = selected == 2,
            onClick = { onSelect(2) },
            icon = { Icon(Icons.AutoMirrored.Filled.List, contentDescription = null) },
            label = { Text(sftpLabel, maxLines = 1) },
            modifier = Modifier.semantics {
                contentDescription = sftpLabel
            }
        )
        NavigationBarItem(
            selected = selected == 3,
            onClick = { onSelect(3) },
            icon = { Icon(Icons.Filled.Info, contentDescription = null) },
            label = { Text(monitorLabel, maxLines = 1) },
            modifier = Modifier.semantics {
                contentDescription = monitorLabel
            }
        )
        NavigationBarItem(
            selected = moreSelected,
            onClick = onMore,
            icon = { Icon(Icons.Filled.MoreVert, contentDescription = null) },
            label = { Text(moreLabel) },
            modifier = Modifier.semantics {
                contentDescription = moreLabel
            }
        )
    }
}

@Composable
private fun MainNavigationRail(
    selected: Int,
    moreSelected: Boolean,
    onSelect: (Int) -> Unit,
    onMore: () -> Unit
) {
    val moreLabel = androidx.compose.ui.res.stringResource(R.string.nav_more)
    NavigationRail {
        MainNavigationRailItem(0, selected, R.string.tab_connections, Icons.Filled.Home, onSelect)
        MainNavigationRailItem(1, selected, R.string.tab_terminal, Icons.Filled.Edit, onSelect)
        MainNavigationRailItem(2, selected, R.string.tab_sftp, Icons.AutoMirrored.Filled.List, onSelect)
        MainNavigationRailItem(3, selected, R.string.tab_monitor, Icons.Filled.Info, onSelect)
        NavigationRailItem(
            selected = moreSelected,
            onClick = onMore,
            icon = { Icon(Icons.Filled.MoreVert, contentDescription = null) },
            label = { Text(moreLabel) },
            modifier = Modifier.semantics {
                contentDescription = moreLabel
            }
        )
    }
}

@Composable
private fun ColumnScope.MainNavigationRailItem(
    index: Int,
    selected: Int,
    labelRes: Int,
    icon: ImageVector,
    onSelect: (Int) -> Unit
) {
    val label = androidx.compose.ui.res.stringResource(labelRes)
    NavigationRailItem(
        selected = selected == index,
        onClick = { onSelect(index) },
        icon = { Icon(icon, contentDescription = null) },
        label = { Text(label, maxLines = 1) },
        modifier = Modifier.semantics {
            contentDescription = label
        }
    )
}

@Composable
private fun MoreNavigationItem(label: Int, icon: ImageVector, onClick: () -> Unit) {
    val labelText = androidx.compose.ui.res.stringResource(label)
    ListItem(
        headlineContent = { Text(labelText) },
        leadingContent = { Icon(icon, contentDescription = null) },
        modifier = Modifier
            .heightIn(min = 56.dp)
            .clickable(onClick = onClick)
            .semantics {
                contentDescription = labelText
                role = Role.Button
            }
    )
}

@Composable
@OptIn(ExperimentalMaterial3Api::class)
private fun ConnectionsScreen(state: AndroidUiState, viewModel: MainViewModel) {
    var name by remember { mutableStateOf("") }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("22") }
    var username by remember { mutableStateOf("") }
    var password by remember { mutableStateOf("") }
    var privateKeyId by remember { mutableStateOf<String?>(null) }
    var showAddConnectionForm by rememberSaveable { mutableStateOf(state.profiles.isEmpty()) }
    var privateKeyMenuExpanded by remember { mutableStateOf(false) }
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
            HorizontalDivider(modifier = Modifier.padding(vertical = OpenFinalShellSpacing.Small))
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    androidx.compose.ui.res.stringResource(R.string.add_connection_title),
                    style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.weight(1f)
                )
                TextButton(onClick = { showAddConnectionForm = !showAddConnectionForm }) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_add_connection))
                }
            }
        }
        if (showAddConnectionForm) {
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
        if (state.privateKeys.isNotEmpty()) {
            item {
                val selectedKeyName = state.privateKeys.firstOrNull { it.id == privateKeyId }?.name
                    ?: androidx.compose.ui.res.stringResource(R.string.private_key_none)
                ExposedDropdownMenuBox(
                    expanded = privateKeyMenuExpanded,
                    onExpandedChange = { privateKeyMenuExpanded = it }
                ) {
                    OutlinedTextField(
                        value = selectedKeyName,
                        onValueChange = {},
                        readOnly = true,
                        modifier = Modifier.fillMaxWidth().menuAnchor(
                            MenuAnchorType.PrimaryNotEditable,
                            enabled = true
                        ),
                        label = { Text(androidx.compose.ui.res.stringResource(R.string.label_private_key)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = privateKeyMenuExpanded) }
                    )
                    ExposedDropdownMenu(
                        expanded = privateKeyMenuExpanded,
                        onDismissRequest = { privateKeyMenuExpanded = false }
                    ) {
                        DropdownMenuItem(
                            text = { Text(androidx.compose.ui.res.stringResource(R.string.private_key_none)) },
                            onClick = {
                                privateKeyId = null
                                privateKeyMenuExpanded = false
                            }
                        )
                        state.privateKeys.forEach { key ->
                            DropdownMenuItem(
                                text = { Text(key.name) },
                                onClick = {
                                    privateKeyId = key.id
                                    privateKeyMenuExpanded = false
                                }
                            )
                        }
                    }
                }
            }
        }
        item {
            Button(
                onClick = {
                    viewModel.saveProfile(name, host, port.toInt(), username, password, privateKeyId = privateKeyId)
                    name = ""
                    host = ""
                    port = "22"
                    username = ""
                    password = ""
                    privateKeyId = null
                    showAddConnectionForm = false
                },
                enabled = formValid,
                modifier = Modifier.fillMaxWidth()
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_add_connection)) }
        }
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
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = OpenFinalShellSpacing.MinimumTouchTarget)
            .clickable(role = Role.Button, onClick = onSelect),
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
                    Text(sessionStateText(it.state), Modifier.padding(horizontal = 8.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
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
    var pendingDeletePath by remember { mutableStateOf<String?>(null) }
    var transferAction by rememberSaveable { mutableStateOf("upload") }
    var showDirectoryForm by rememberSaveable { mutableStateOf(false) }
    var showRenameForm by rememberSaveable { mutableStateOf(false) }

    pendingDeletePath?.let { targetPath ->
        AlertDialog(
            onDismissRequest = { pendingDeletePath = null },
            title = { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) },
            text = { Text(targetPath, fontFamily = FontFamily.Monospace) },
            confirmButton = {
                TextButton(
                    onClick = {
                        viewModel.deleteSftp(targetPath)
                        pendingDeletePath = null
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeletePath = null }) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_cancel))
                }
            }
        )
    }

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
        Row(
            Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
            horizontalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)
        ) {
            TextButton(onClick = { viewModel.browseSftp(parent) }, enabled = path != "/") {
                Text(androidx.compose.ui.res.stringResource(R.string.action_parent))
            }
            TextButton(onClick = { showDirectoryForm = !showDirectoryForm }) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_create))
            }
            TextButton(onClick = { showRenameForm = !showRenameForm }) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_rename))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)) {
            FilterChip(
                selected = transferAction == "upload",
                onClick = { transferAction = "upload" },
                label = { Text(androidx.compose.ui.res.stringResource(R.string.action_upload)) }
            )
            FilterChip(
                selected = transferAction == "download",
                onClick = { transferAction = "download" },
                label = { Text(androidx.compose.ui.res.stringResource(R.string.action_download)) }
            )
        }
        if (transferAction == "upload") {
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
        } else {
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
        }
        if (showDirectoryForm) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)) {
                OutlinedTextField(
                    value = directoryName,
                    onValueChange = { directoryName = it },
                    modifier = Modifier.weight(1f),
                    label = { Text(androidx.compose.ui.res.stringResource(R.string.label_directory_name)) },
                    singleLine = true
                )
                Button(
                    onClick = { viewModel.createSftpDirectory(directoryName); directoryName = ""; showDirectoryForm = false },
                    enabled = directoryName.isNotBlank()
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_create)) }
            }
        }
        if (showRenameForm) {
            OutlinedTextField(
                value = renamePath,
                onValueChange = { renamePath = it },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.label_rename_path)) },
                singleLine = true
            )
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)) {
                OutlinedTextField(
                    value = renameName,
                    onValueChange = { renameName = it },
                    modifier = Modifier.weight(1f),
                    label = { Text(androidx.compose.ui.res.stringResource(R.string.label_new_name)) },
                    singleLine = true
                )
                Button(
                    onClick = { viewModel.renameSftp(renamePath, renameName); renamePath = ""; renameName = ""; showRenameForm = false },
                    enabled = renamePath.isNotBlank() && renameName.isNotBlank()
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_rename)) }
            }
        }
        if (state.sftpEntries.isEmpty()) {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.sftp_empty_title),
                body = androidx.compose.ui.res.stringResource(R.string.sftp_empty_body)
            )
        } else {
            LazyColumn(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = OpenFinalShellSpacing.Small)) {
                items(state.sftpEntries, key = { it.path }) { entry ->
                    SftpEntryRow(entry, onDelete = { pendingDeletePath = it }, viewModel = viewModel)
                }
            }
        }
        if (state.transfers.isNotEmpty()) {
            MetricCard(androidx.compose.ui.res.stringResource(R.string.transfer_queue)) {
                state.transfers.forEach { transfer ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(transfer.remotePath, maxLines = 1)
                            Text(
                                "${transferStateText(transfer.state)} ${transfer.bytesTransferred}/${transfer.bytesTotal.coerceAtLeast(0)}",
                                style = MaterialTheme.typography.labelSmall
                            )
                            transfer.error?.let { error -> ErrorState(error) }
                        }
                        when (transfer.state) {
                            io.github.openfinalshell.android.core.sftp.TransferState.RUNNING,
                            io.github.openfinalshell.android.core.sftp.TransferState.QUEUED -> TextButton(onClick = { viewModel.pauseTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_pause)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.PAUSED -> TextButton(onClick = { viewModel.resumeTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_resume)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.FAILED,
                            io.github.openfinalshell.android.core.sftp.TransferState.CANCELED -> TextButton(onClick = { viewModel.retryTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_retry)) }
                            io.github.openfinalshell.android.core.sftp.TransferState.COMPLETED -> Unit
                        }
                        if (transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.COMPLETED &&
                            transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.FAILED &&
                            transfer.state != io.github.openfinalshell.android.core.sftp.TransferState.CANCELED
                        ) {
                            TextButton(onClick = { viewModel.cancelTransfer(transfer.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_cancel)) }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SftpEntryRow(
    entry: SftpEntry,
    viewModel: MainViewModel,
    onDelete: (String) -> Unit
) {
    val directory = entry.type == SftpEntry.Type.DIRECTORY
    Card(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(start = OpenFinalShellSpacing.Medium, top = OpenFinalShellSpacing.Small, bottom = OpenFinalShellSpacing.Small, end = OpenFinalShellSpacing.Small), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (directory) "[DIR] ${entry.name}" else entry.name, fontFamily = if (directory) FontFamily.Default else FontFamily.Monospace, maxLines = 2)
                Text(entry.path, style = MaterialTheme.typography.labelSmall, maxLines = 1)
            }
            if (directory) {
                TextButton(onClick = { viewModel.browseSftp(entry.path) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_open)) }
            } else {
                TextButton(
                    onClick = { onDelete(entry.path) },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
            }
        }
    }
}

@Composable
private fun TerminalScreen(
    state: AndroidUiState,
    viewModel: MainViewModel,
    terminalFontSize: Int,
    terminalCursorStyle: String
) {
    val sessionId = state.selectedSessionId
    val session = sessionId?.let { state.sessions[it] }
    val actionsScroll = rememberScrollState()
    val controller = sessionId
        ?.takeIf { it in state.terminalSessionIds }
        ?.let(viewModel::terminalController)
    val terminalDescription = androidx.compose.ui.res.stringResource(R.string.tab_terminal)
    // Observing the emulator snapshot invalidates the Android view without putting terminal bytes
    // into a Compose Text node or the global UI state.
    val terminalSnapshot = controller?.snapshot?.collectAsStateWithLifecycle()?.value

    LaunchedEffect(sessionId, session?.state) {
        if (sessionId != null && session?.state == SessionState.READY) {
            // The Android view immediately replaces this initial size with its measured rows/columns.
            viewModel.openShell(sessionId, 80, 24)
        }
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 10.dp).imePadding(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(session?.profile?.name ?: androidx.compose.ui.res.stringResource(R.string.tab_terminal), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium)
            Text(
                session?.state?.let { sessionStateText(it) }
                    ?: androidx.compose.ui.res.stringResource(R.string.terminal_no_session),
                style = MaterialTheme.typography.labelMedium
            )
        }
        if (sessionId == null) {
            EmptyState(
                title = androidx.compose.ui.res.stringResource(R.string.terminal_select_connection),
                body = androidx.compose.ui.res.stringResource(R.string.terminal_select_body)
            )
            return@Column
        }
        if (controller == null) {
            Surface(
                modifier = Modifier.fillMaxWidth().weight(1f).heightIn(min = 180.dp),
                color = MaterialTheme.colorScheme.surfaceContainerLowest
            ) {
                Box(contentAlignment = Alignment.Center) {
                    Text(
                        androidx.compose.ui.res.stringResource(
                            R.string.terminal_connecting,
                            session?.profile?.host ?: androidx.compose.ui.res.stringResource(R.string.terminal_unknown_host)
                        ),
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        } else {
            AndroidView(
                factory = { context -> SshTerminalView(context) },
                modifier = Modifier.fillMaxWidth().weight(1f).heightIn(min = 180.dp),
                update = { terminalView ->
                    terminalView.contentDescription = terminalDescription
                    terminalView.bind(
                        nextController = controller,
                        fontSizeSp = terminalFontSize,
                        cursorStyle = when (terminalCursorStyle) {
                            "line" -> TerminalCursorStyle.BAR
                            "underline" -> TerminalCursorStyle.UNDERLINE
                            else -> TerminalCursorStyle.BLOCK
                        },
                        input = { bytes -> viewModel.sendTerminalInput(sessionId, bytes) },
                        resize = { cols, rows -> viewModel.resizeTerminal(sessionId, cols, rows) }
                    )
                    terminalSnapshot // Keep this update lambda subscribed to emulator screen changes.
                    terminalView.refresh()
                }
            )
        }
        Row(Modifier.fillMaxWidth().horizontalScroll(actionsScroll), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            TextButton(onClick = { viewModel.sendTerminalInput(sessionId, "\n") }) { Text(androidx.compose.ui.res.stringResource(R.string.action_enter)) }
            TextButton(onClick = { viewModel.clearTerminal(sessionId) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_clear)) }
            TextButton(
                onClick = { viewModel.disconnect(sessionId) },
                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
            ) { Text(androidx.compose.ui.res.stringResource(R.string.action_disconnect)) }
        }
    }
}

@Composable
private fun sessionStateText(state: SessionState): String = uiStatusText(
    UiStatus(
        when (state) {
            SessionState.CONNECTING -> StatusKey.CONNECTING
            SessionState.AUTHENTICATING -> StatusKey.AUTHENTICATING
            SessionState.READY -> StatusKey.CONNECTED
            SessionState.RECONNECTING -> StatusKey.RECONNECTING
            SessionState.CLOSED -> StatusKey.DISCONNECTED
        }
    )
)

@Composable
private fun transferStateText(state: io.github.openfinalshell.android.core.sftp.TransferState): String =
    androidx.compose.ui.res.stringResource(
        when (state) {
            io.github.openfinalshell.android.core.sftp.TransferState.QUEUED -> R.string.transfer_state_queued
            io.github.openfinalshell.android.core.sftp.TransferState.RUNNING -> R.string.transfer_state_running
            io.github.openfinalshell.android.core.sftp.TransferState.PAUSED -> R.string.transfer_state_paused
            io.github.openfinalshell.android.core.sftp.TransferState.COMPLETED -> R.string.transfer_state_completed
            io.github.openfinalshell.android.core.sftp.TransferState.FAILED -> R.string.transfer_state_failed
            io.github.openfinalshell.android.core.sftp.TransferState.CANCELED -> R.string.transfer_state_canceled
        }
    )

@Composable
private fun forwardTypeText(type: String): String = androidx.compose.ui.res.stringResource(
    when (type) {
        "remote" -> R.string.forward_type_remote
        "dynamic" -> R.string.forward_type_dynamic
        else -> R.string.forward_type_local
    }
)

@Composable
private fun forwardRuntimeStateText(state: String?): String = androidx.compose.ui.res.stringResource(
    if (state == "active") R.string.forward_state_active else R.string.forward_state_stopped
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ForwardScreen(state: AndroidUiState, viewModel: MainViewModel) {
    var type by remember { mutableStateOf("local") }
    var label by remember { mutableStateOf("") }
    var bindAddr by remember { mutableStateOf("127.0.0.1") }
    var bindPort by remember { mutableStateOf("0") }
    var dstHost by remember { mutableStateOf("127.0.0.1") }
    var dstPort by remember { mutableStateOf("22") }
    var profileId by remember(state.profiles, state.selectedProfileId) {
        mutableStateOf(state.selectedProfileId ?: state.profiles.firstOrNull()?.id.orEmpty())
    }
    var autoStart by remember { mutableStateOf(false) }
    var pendingDeleteId by remember { mutableStateOf<String?>(null) }
    val selectedProfile = state.profiles.firstOrNull { it.id == profileId }
    val port = bindPort.toIntOrNull()
    val destinationPort = dstPort.toIntOrNull()
    val valid = selectedProfile != null && bindAddr.isNotBlank() && port?.let { it in 1..65535 } == true &&
        (type == "dynamic" || (dstHost.isNotBlank() && destinationPort?.let { it in 1..65535 } == true))

    pendingDeleteId?.let { targetId ->
        val target = state.forwards.firstOrNull { it.id == targetId }
        AlertDialog(
            onDismissRequest = { pendingDeleteId = null },
            title = { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) },
            text = { Text(target?.label ?: targetId) },
            confirmButton = {
                TextButton(
                    onClick = {
                        target?.let(viewModel::deleteForward)
                        pendingDeleteId = null
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteId = null }) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_cancel))
                }
            }
        )
    }

    LazyColumn(
        Modifier.fillMaxSize().imePadding(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text(androidx.compose.ui.res.stringResource(R.string.forward_title), style = MaterialTheme.typography.titleMedium)
            Text(androidx.compose.ui.res.stringResource(R.string.forward_description), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
        if (state.forwards.isEmpty()) {
            item { EmptyState(androidx.compose.ui.res.stringResource(R.string.forward_empty_title), androidx.compose.ui.res.stringResource(R.string.forward_empty_body)) }
        } else {
            items(state.forwards, key = { it.id }) { rule ->
                val runtime = state.forwardStates[rule.id]
                val profileName = state.profiles.firstOrNull { it.id == rule.profileId }?.name ?: rule.profileId
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(rule.label, style = MaterialTheme.typography.titleSmall)
                                Text("${forwardTypeText(rule.type)} ${rule.bindAddr}:${rule.bindPort} -> ${rule.dstHost ?: "SOCKS5"}:${rule.dstPort ?: "-"}", style = MaterialTheme.typography.bodySmall)
                                Text(profileName + " | " + forwardRuntimeStateText(runtime?.state), style = MaterialTheme.typography.labelSmall)
                            }
                            if (runtime?.state == "active") {
                                TextButton(onClick = { viewModel.stopForward(rule.id) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_stop)) }
                            } else {
                                TextButton(onClick = { viewModel.startForward(rule) }) { Text(androidx.compose.ui.res.stringResource(R.string.action_start)) }
                            }
                        }
                        runtime?.error?.let { ErrorState(it) }
                        TextButton(
                            onClick = { pendingDeleteId = rule.id },
                            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                        ) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
                    }
                }
            }
        }
        item { HorizontalDivider(modifier = Modifier.padding(vertical = 6.dp)) }
        item { Text(androidx.compose.ui.res.stringResource(R.string.forward_add_title), style = MaterialTheme.typography.titleMedium) }
        item {
            Text(androidx.compose.ui.res.stringResource(R.string.forward_profile), style = MaterialTheme.typography.labelLarge)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                state.profiles.forEach { profile ->
                    FilterChip(selected = profile.id == profileId, onClick = { profileId = profile.id }, label = { Text(profile.name) })
                }
            }
        }
        item {
            ChoiceRow(
                androidx.compose.ui.res.stringResource(R.string.forward_type), type,
                listOf("local" to null, "remote" to null, "dynamic" to null)
            ) { type = it }
        }
        item { OutlinedTextField(label, { label = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.forward_label)) }, singleLine = true) }
        item { OutlinedTextField(bindAddr, { bindAddr = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.forward_bind_address)) }, singleLine = true) }
        item { OutlinedTextField(bindPort, { bindPort = it.filter(Char::isDigit).take(5) }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.forward_bind_port)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true) }
        if (type != "dynamic") {
            item { OutlinedTextField(dstHost, { dstHost = it }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.forward_destination_host)) }, singleLine = true) }
            item { OutlinedTextField(dstPort, { dstPort = it.filter(Char::isDigit).take(5) }, Modifier.fillMaxWidth(), label = { Text(androidx.compose.ui.res.stringResource(R.string.forward_destination_port)) }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number), singleLine = true) }
        }
        item { SettingsSwitchRow(androidx.compose.ui.res.stringResource(R.string.forward_auto_start), autoStart) { autoStart = it } }
        item {
            Button(
                onClick = {
                    viewModel.saveForward(profileId, type, label, bindAddr, port ?: 0, dstHost, destinationPort, autoStart)
                    label = ""
                },
                enabled = valid,
                modifier = Modifier.fillMaxWidth()
            ) { Text(androidx.compose.ui.res.stringResource(R.string.forward_save)) }
        }
    }
}

@Composable
private fun LanSyncScreen(state: LanSyncUiState, viewModel: LanSyncViewModel) {
    var pairingCode by remember { mutableStateOf("") }
    val localizedMessage = state.message?.let { uiStatusText(it) }
    LazyColumn(
        Modifier.fillMaxSize().imePadding(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text(androidx.compose.ui.res.stringResource(R.string.sync_title), style = MaterialTheme.typography.titleMedium)
            Text(androidx.compose.ui.res.stringResource(R.string.sync_description), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodySmall)
        }
        item {
            Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)) {
                Button(onClick = viewModel::scan, enabled = state.phase != "scanning") {
                    Text(androidx.compose.ui.res.stringResource(R.string.sync_scan))
                }
                if (state.receiver == null) {
                    Button(onClick = viewModel::startReceiver, enabled = state.phase != "starting") {
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_start_receiver))
                    }
                } else {
                    Button(onClick = viewModel::stopReceiver) {
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_stop_receiver))
                    }
                }
            }
        }
        state.receiver?.let { receiver ->
            item {
                Card(Modifier.fillMaxWidth()) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_receiver_ready), style = MaterialTheme.typography.titleSmall)
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_receiver_port, receiver.tcpPort))
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_pairing_code, receiver.pairingCode), style = MaterialTheme.typography.titleLarge)
                    }
                }
            }
        }
        if (state.phase == "incoming") {
            item {
                Card(Modifier.fillMaxWidth(), border = BorderStroke(2.dp, MaterialTheme.colorScheme.primary)) {
                    Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_confirmation_required), style = MaterialTheme.typography.titleSmall)
                        Text(androidx.compose.ui.res.stringResource(R.string.sync_confirmation_body))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Button(onClick = viewModel::acceptIncoming) { Text(androidx.compose.ui.res.stringResource(R.string.sync_accept)) }
                            TextButton(onClick = viewModel::rejectIncoming) { Text(androidx.compose.ui.res.stringResource(R.string.sync_reject)) }
                        }
                    }
                }
            }
        }
        item {
            OutlinedTextField(
                value = pairingCode,
                onValueChange = { pairingCode = it.filter(Char::isDigit).take(6) },
                modifier = Modifier.fillMaxWidth(),
                label = { Text(androidx.compose.ui.res.stringResource(R.string.sync_pairing_code_input)) },
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                singleLine = true
            )
        }
        if (state.peers.isEmpty()) {
            item { EmptyState(androidx.compose.ui.res.stringResource(R.string.sync_no_devices), androidx.compose.ui.res.stringResource(R.string.sync_scan_hint)) }
        } else {
            item { Text(androidx.compose.ui.res.stringResource(R.string.sync_devices), style = MaterialTheme.typography.titleSmall) }
            items(state.peers, key = { "${it.deviceId}@${it.address}:${it.tcpPort}" }) { peer ->
                val selected = state.selectedPeer?.deviceId == peer.deviceId && state.selectedPeer?.address == peer.address
                Card(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = OpenFinalShellSpacing.MinimumTouchTarget)
                        .clickable(role = Role.Button) { viewModel.selectPeer(peer) },
                    border = if (selected) BorderStroke(2.dp, MaterialTheme.colorScheme.primary) else null
                ) {
                    Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(peer.deviceName, style = MaterialTheme.typography.titleSmall)
                            Text(
                                androidx.compose.ui.res.stringResource(
                                    R.string.sync_peer_metadata,
                                    peer.address,
                                    peer.tcpPort,
                                    peer.appVersion
                                ),
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                        Button(onClick = { viewModel.send(peer, pairingCode) }, enabled = pairingCode.length == 6 && state.phase != "sending") {
                            Text(androidx.compose.ui.res.stringResource(R.string.sync_send))
                        }
                    }
                }
            }
        }
        localizedMessage?.let { message ->
            item {
                if (state.phase == "error") ErrorState(message)
                else Text(message, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        state.lastResult?.let { result ->
            item {
                Text(androidx.compose.ui.res.stringResource(R.string.sync_last_result, result.profiles, result.forwards, result.secrets, result.skipped))
            }
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
        monitor.error?.let { item { ErrorState(androidx.compose.ui.res.stringResource(R.string.status_monitor_failed)) } }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SettingsScreen(
    viewModel: SettingsViewModel,
    state: SettingsUiState,
    mainViewModel: MainViewModel,
    mainState: AndroidUiState,
    onRequestUpdateInstall: () -> Unit
) {
    val settings = state.settings
    val context = LocalContext.current
    val defaultPrivateKeyName = androidx.compose.ui.res.stringResource(R.string.private_key_default_name)
    var transferPassphrase by remember { mutableStateOf("") }
    var pendingDeleteKeyId by remember { mutableStateOf<String?>(null) }
    val privateKeyPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri?.let {
            val displayName = it.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')
                ?.ifBlank { defaultPrivateKeyName }
                ?: defaultPrivateKeyName
            mainViewModel.importPrivateKey(it, displayName)
        }
    }
    val exportPicker = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/json")) { uri: Uri? ->
        uri?.let { mainViewModel.exportPortable(it, transferPassphrase, includeSecrets = true, encryptAll = true) }
    }
    val importPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        uri?.let { mainViewModel.importPortable(it, transferPassphrase) }
    }
    val directoryPicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri: Uri? ->
        if (uri != null) {
            runCatching {
                context.contentResolver.takePersistableUriPermission(
                    uri,
                    Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                )
            }
            viewModel.setDownloadDirectoryUri(uri.toString())
        }
    }
    pendingDeleteKeyId?.let { keyId ->
        val key = mainState.privateKeys.firstOrNull { it.id == keyId }
        AlertDialog(
            onDismissRequest = { pendingDeleteKeyId = null },
            title = { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) },
            text = { Text(key?.name.orEmpty()) },
            confirmButton = {
                TextButton(
                    onClick = {
                        key?.let(mainViewModel::deletePrivateKey)
                        pendingDeleteKeyId = null
                    },
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                ) { Text(androidx.compose.ui.res.stringResource(R.string.action_delete)) }
            },
            dismissButton = {
                TextButton(onClick = { pendingDeleteKeyId = null }) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_cancel))
                }
            }
        )
    }
    LazyColumn(
        Modifier.fillMaxSize(),
        contentPadding = androidx.compose.foundation.layout.PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item { Text(androidx.compose.ui.res.stringResource(R.string.settings_title), style = MaterialTheme.typography.titleLarge) }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_general)) {
                ChoiceRow(
                    androidx.compose.ui.res.stringResource(R.string.settings_language),
                    settings.language,
                    AndroidLocales.options.map { it.tag to it.labelRes }
                ) { viewModel.setLanguage(it) }
                ChoiceRow(
                    androidx.compose.ui.res.stringResource(R.string.settings_theme),
                    settings.theme,
                    listOf("system" to R.string.settings_theme_system, "light" to R.string.settings_theme_light, "dark" to R.string.settings_theme_dark)
                ) { viewModel.setTheme(it) }
                SettingsSwitchRow(androidx.compose.ui.res.stringResource(R.string.settings_mask_hosts), settings.maskHosts, viewModel::setMaskHosts)
                SettingsSwitchRow(androidx.compose.ui.res.stringResource(R.string.settings_auto_updates), settings.autoCheckUpdates, viewModel::setAutoCheckUpdates)
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_terminal)) {
                NumberSetting(
                    label = androidx.compose.ui.res.stringResource(R.string.settings_terminal_font_size),
                    value = settings.terminalFontSize,
                    range = 10..32,
                    onChange = viewModel::setTerminalFontSize
                )
                ChoiceRow(
                    androidx.compose.ui.res.stringResource(R.string.settings_cursor),
                    settings.terminalCursorStyle,
                    listOf("block" to R.string.settings_cursor_block, "line" to R.string.settings_cursor_line, "underline" to R.string.settings_cursor_underline)
                ) { viewModel.setTerminalCursorStyle(it) }
                NumberSetting(
                    label = androidx.compose.ui.res.stringResource(R.string.settings_scrollback),
                    value = settings.terminalScrollbackLines,
                    range = 200..20_000,
                    onChange = viewModel::setTerminalScrollbackLines
                )
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_sftp)) {
                ChoiceRow(
                    androidx.compose.ui.res.stringResource(R.string.settings_sftp_concurrency),
                    settings.sftpConcurrency.toString(),
                    (1..8).map { it.toString() to null }
                ) { viewModel.setSftpConcurrency(it.toInt()) }
                ChoiceRow(
                    androidx.compose.ui.res.stringResource(R.string.settings_sftp_conflict),
                    settings.sftpConflictPolicy,
                    listOf("ask" to R.string.settings_conflict_ask, "overwrite" to R.string.settings_conflict_overwrite, "skip" to R.string.settings_conflict_skip)
                ) { viewModel.setSftpConflictPolicy(it) }
                SettingsSwitchRow(androidx.compose.ui.res.stringResource(R.string.settings_sftp_hidden), settings.sftpShowHiddenFiles, viewModel::setSftpShowHiddenFiles)
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_monitor)) {
                NumberSetting(
                    label = androidx.compose.ui.res.stringResource(R.string.settings_monitor_interval),
                    value = settings.monitorIntervalSeconds,
                    range = 2..60,
                    onChange = viewModel::setMonitorIntervalSeconds
                )
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_storage)) {
                Text(androidx.compose.ui.res.stringResource(R.string.settings_download_directory), style = MaterialTheme.typography.labelLarge)
                Text(
                    settings.downloadDirectoryUri ?: androidx.compose.ui.res.stringResource(R.string.settings_download_directory_default),
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 3
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { directoryPicker.launch(settings.downloadDirectoryUri?.let(Uri::parse)) }) {
                        Text(androidx.compose.ui.res.stringResource(R.string.action_choose_directory))
                    }
                    if (settings.downloadDirectoryUri != null) {
                        TextButton(onClick = { viewModel.setDownloadDirectoryUri(null) }) {
                            Text(androidx.compose.ui.res.stringResource(R.string.action_clear))
                        }
                    }
                }
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_security)) {
                Text(androidx.compose.ui.res.stringResource(R.string.settings_private_keys), style = MaterialTheme.typography.labelLarge)
                if (mainState.privateKeys.isEmpty()) {
                    Text(androidx.compose.ui.res.stringResource(R.string.settings_private_keys_empty), color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else {
                    mainState.privateKeys.forEach { key ->
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(key.name)
                                Text(key.originalPath.orEmpty(), style = MaterialTheme.typography.bodySmall, maxLines = 2)
                            }
                            TextButton(
                                onClick = { pendingDeleteKeyId = key.id },
                                colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                            ) {
                                Text(androidx.compose.ui.res.stringResource(R.string.action_delete))
                            }
                        }
                    }
                }
                Button(onClick = { privateKeyPicker.launch(arrayOf("*/*")) }) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_import_private_key))
                }
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_backup)) {
                OutlinedTextField(
                    value = transferPassphrase,
                    onValueChange = { transferPassphrase = it },
                    modifier = Modifier.fillMaxWidth(),
                    label = { Text(androidx.compose.ui.res.stringResource(R.string.settings_backup_passphrase)) },
                    visualTransformation = PasswordVisualTransformation(),
                    singleLine = true
                )
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(
                        onClick = { exportPicker.launch("openfinalshell-export.json") },
                        enabled = transferPassphrase.length >= 8
                    ) { Text(androidx.compose.ui.res.stringResource(R.string.action_export)) }
                    Button(
                        onClick = { importPicker.launch(arrayOf("application/json", "text/plain")) },
                        enabled = transferPassphrase.length >= 8
                    ) { Text(androidx.compose.ui.res.stringResource(R.string.action_import)) }
                }
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_updates)) {
                UpdatePanel(state, viewModel, onRequestUpdateInstall)
            }
        }
        item {
            SettingsSection(androidx.compose.ui.res.stringResource(R.string.settings_about)) {
                Text(androidx.compose.ui.res.stringResource(R.string.settings_version, BuildConfig.VERSION_NAME))
                Text(androidx.compose.ui.res.stringResource(R.string.settings_about_body), color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)
    ) {
        Column(
            modifier = Modifier.padding(OpenFinalShellSpacing.Large),
            verticalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)
        ) {
            Text(title, style = MaterialTheme.typography.titleMedium)
            content()
        }
    }
}

@Composable
private fun SettingsSwitchRow(label: String, checked: Boolean, onCheckedChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = OpenFinalShellSpacing.MinimumTouchTarget),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(label, Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChoiceRow(label: String, selected: String, options: List<Pair<String, Int?>>, onSelected: (String) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(label, style = MaterialTheme.typography.labelLarge)
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            options.forEach { (value, resource) ->
                FilterChip(
                    selected = value == selected,
                    onClick = { onSelected(value) },
                    label = { Text(resource?.let { androidx.compose.ui.res.stringResource(it) } ?: value) }
                )
            }
        }
    }
}

@Composable
private fun NumberSetting(label: String, value: Int, range: IntRange, onChange: (Int) -> Unit) {
    var text by remember(value) { mutableStateOf(value.toString()) }
    OutlinedTextField(
        value = text,
        onValueChange = { next ->
            val filtered = next.filter(Char::isDigit).take(5)
            text = filtered
            filtered.toIntOrNull()?.takeIf { it in range }?.let(onChange)
        },
        modifier = Modifier.fillMaxWidth(),
        label = { Text(label) },
        supportingText = { Text(range.first.toString() + " - " + range.last.toString()) },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        singleLine = true
    )
}

@Composable
private fun UpdatePanel(state: SettingsUiState, viewModel: SettingsViewModel, onRequestUpdateInstall: () -> Unit) {
    when (val update = state.update) {
        UpdateState.Idle -> Text(androidx.compose.ui.res.stringResource(R.string.update_not_checked))
        UpdateState.Checking -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            CircularProgressIndicator(modifier = Modifier.width(20.dp).heightIn(min = 20.dp), strokeWidth = 2.dp)
            Text(androidx.compose.ui.res.stringResource(R.string.update_checking))
        }
        is UpdateState.UpToDate -> {
            Text(androidx.compose.ui.res.stringResource(R.string.update_up_to_date, update.currentVersion))
            Button(onClick = viewModel::checkForUpdates) { Text(androidx.compose.ui.res.stringResource(R.string.action_check_updates)) }
        }
        is UpdateState.Available -> {
            Text(androidx.compose.ui.res.stringResource(R.string.update_available, update.release.versionName, update.apk.asset.name))
            Button(onClick = viewModel::downloadUpdate) { Text(androidx.compose.ui.res.stringResource(R.string.action_download_update)) }
        }
        is UpdateState.Downloading -> {
            val ratio = if (update.totalBytes > 0) update.downloadedBytes.toFloat() / update.totalBytes else 0f
            Text(androidx.compose.ui.res.stringResource(R.string.update_downloading, formatBytes(update.downloadedBytes), formatBytes(update.totalBytes)))
            LinearProgressIndicator(
                progress = { ratio.coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth()
            )
            TextButton(onClick = viewModel::cancelDownload) { Text(androidx.compose.ui.res.stringResource(R.string.action_cancel)) }
        }
        is UpdateState.Ready -> {
            Text(androidx.compose.ui.res.stringResource(R.string.update_ready, update.release.versionName))
            if (viewModel.canInstallPackages()) {
                Button(onClick = onRequestUpdateInstall) { Text(androidx.compose.ui.res.stringResource(R.string.action_install_update)) }
            } else {
                Button(onClick = onRequestUpdateInstall) {
                    Text(androidx.compose.ui.res.stringResource(R.string.action_allow_install))
                }
            }
        }
        UpdateState.Canceled -> {
            Text(androidx.compose.ui.res.stringResource(R.string.update_canceled))
            Button(onClick = viewModel::checkForUpdates) { Text(androidx.compose.ui.res.stringResource(R.string.action_check_updates)) }
        }
        is UpdateState.Installing -> Text(androidx.compose.ui.res.stringResource(R.string.update_installing, update.versionName))
        is UpdateState.Installed -> Text(androidx.compose.ui.res.stringResource(R.string.update_installed, update.versionName))
        is UpdateState.Failed -> {
            Text(androidx.compose.ui.res.stringResource(R.string.update_failed), color = MaterialTheme.colorScheme.error)
            if (update.retryable) Button(onClick = viewModel::checkForUpdates) { Text(androidx.compose.ui.res.stringResource(R.string.action_retry)) }
        }
    }
    if (state.saving) Text(androidx.compose.ui.res.stringResource(R.string.settings_saving), style = MaterialTheme.typography.labelSmall)
}

@Composable
private fun UpdateReadyDialog(versionName: String, onDefer: () -> Unit, onInstall: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDefer,
        title = { Text(androidx.compose.ui.res.stringResource(R.string.update_ready_dialog_title)) },
        text = { Text(androidx.compose.ui.res.stringResource(R.string.update_ready_dialog_message, versionName)) },
        confirmButton = {
            TextButton(onClick = onInstall) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_install_and_restart))
            }
        },
        dismissButton = {
            TextButton(onClick = onDefer) {
                Text(androidx.compose.ui.res.stringResource(R.string.action_later))
            }
        }
    )
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
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow)
    ) {
        Column(
            Modifier.padding(OpenFinalShellSpacing.Large),
            verticalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.XSmall)
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            content()
        }
    }
}

@Composable
private fun EmptyState(title: String, body: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = MaterialTheme.shapes.medium
    ) {
        Column(
            Modifier.fillMaxWidth().padding(vertical = OpenFinalShellSpacing.XLarge, horizontal = OpenFinalShellSpacing.Large),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(OpenFinalShellSpacing.Small)
        ) {
        Text(title, style = MaterialTheme.typography.titleSmall)
        Text(body, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

@Composable
private fun ErrorState(message: String) {
    Surface(
        modifier = Modifier.fillMaxWidth(),
        color = MaterialTheme.colorScheme.errorContainer,
        contentColor = MaterialTheme.colorScheme.onErrorContainer,
        shape = MaterialTheme.shapes.medium
    ) {
        Text(
            text = message,
            modifier = Modifier.padding(OpenFinalShellSpacing.Medium),
            style = MaterialTheme.typography.bodySmall
        )
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
