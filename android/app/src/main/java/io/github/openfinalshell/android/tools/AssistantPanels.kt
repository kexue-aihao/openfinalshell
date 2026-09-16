package io.github.openfinalshell.android.tools

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import io.github.openfinalshell.android.R
import io.github.openfinalshell.android.core.ai.AiClient

@Composable
private fun ErrorStatus(code: String?) {
    if(code==null) return
    val key=when(code) {
        "unauthorized" -> R.string.tools_unauthorized
        "forbidden" -> R.string.tools_forbidden
        "not_found" -> R.string.tools_not_found
        "rate_limit" -> R.string.tools_rate_limit
        "missing_token" -> R.string.tools_missing_token
        "invalid_url" -> R.string.tools_invalid_url
        "context_limit" -> R.string.tools_context_limit
        "cancelled" -> R.string.tools_cancelled
        "conflict" -> R.string.tools_conflict
        "timeout" -> R.string.tools_timeout
        else -> R.string.tools_failed
    }
    Text(stringResource(key),color=MaterialTheme.colorScheme.error)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AiSettingsSection(vm: AssistantViewModel = viewModel()) {
    val state by vm.state.collectAsState()
    val profile=state.selected
    var deepSeekPreset by remember { mutableStateOf(false) }
    var draftRevision by remember { mutableIntStateOf(0) }
    var name by remember(profile?.id,profile?.updatedAt,draftRevision) { mutableStateOf(profile?.name ?: if(deepSeekPreset) "DeepSeek" else "OpenAI") }
    var url by remember(profile?.id,profile?.updatedAt,draftRevision) { mutableStateOf(profile?.baseUrl ?: if(deepSeekPreset) "https://api.deepseek.com/v1" else "https://api.openai.com/v1") }
    var model by remember(profile?.id,profile?.updatedAt,draftRevision) { mutableStateOf(profile?.model ?: if(deepSeekPreset) "deepseek-chat" else "gpt-4o-mini") }
    var token by remember(profile?.id,profile?.updatedAt,draftRevision) { mutableStateOf("") }
    var expanded by remember { mutableStateOf(false) }
    var modelsExpanded by remember { mutableStateOf(false) }
    val saved=profile!=null && name==profile.name && url==profile.baseUrl && model==profile.model && token.isEmpty()
    Column(verticalArrangement=Arrangement.spacedBy(8.dp)) {
        Text(stringResource(R.string.tools_ai_settings),style=MaterialTheme.typography.titleMedium)
        Box {
            TextButton(onClick={expanded=true}) { Text(profile?.name ?: stringResource(R.string.tools_new_profile)) }
            DropdownMenu(expanded,onDismissRequest={expanded=false}) {
                state.profiles.forEach { p -> DropdownMenuItem(text={Text(p.name)},onClick={vm.select(p);expanded=false}) }
                DropdownMenuItem(text={Text(stringResource(R.string.tools_new_profile))},onClick={deepSeekPreset=false;draftRevision++;vm.select(null);expanded=false})
            }
        }
        FlowRow {
            TextButton(onClick={deepSeekPreset=false;draftRevision++;vm.select(null)}) { Text("OpenAI") }
            TextButton(onClick={deepSeekPreset=true;draftRevision++;vm.select(null)}) { Text("DeepSeek") }
        }
        OutlinedTextField(name,{name=it},label={Text(stringResource(R.string.tools_name))},modifier=Modifier.fillMaxWidth())
        OutlinedTextField(url,{url=it},label={Text(stringResource(R.string.tools_base_url))},modifier=Modifier.fillMaxWidth())
        OutlinedTextField(model,{model=it},label={Text(stringResource(R.string.tools_model))},modifier=Modifier.fillMaxWidth())
        OutlinedTextField(token,{token=it},label={Text(stringResource(if(profile?.hasToken==true) R.string.tools_replace_token else R.string.tools_token))},visualTransformation=PasswordVisualTransformation(),modifier=Modifier.fillMaxWidth())
        FlowRow {
            Button(onClick={vm.save(name,url,model,token.ifBlank { null })}) { Text(stringResource(R.string.tools_save)) }
            TextButton(onClick={vm.save(name,url,model,null,true)},enabled=profile?.hasToken==true) { Text(stringResource(R.string.tools_clear_token)) }
            TextButton(onClick=vm::deleteProfile,enabled=profile!=null) { Text(stringResource(R.string.tools_delete)) }
        }
        FlowRow {
            TextButton(onClick=vm::test,enabled=saved && profile?.hasToken==true) { Text(stringResource(R.string.tools_test)) }
            TextButton(onClick=vm::discover,enabled=saved && profile?.hasToken==true) { Text(stringResource(R.string.tools_models)) }
            Box {
                TextButton(onClick={modelsExpanded=true},enabled=saved && state.models.isNotEmpty()) { Text(stringResource(R.string.tools_choose_model)) }
                DropdownMenu(modelsExpanded,onDismissRequest={modelsExpanded=false},modifier=Modifier.heightIn(max=320.dp)) {
                    state.models.forEach { m -> DropdownMenuItem(text={Column {
                        Text(m.id)
                        Text(stringResource(when(m.image) { "yes"->R.string.tools_image_yes; "no"->R.string.tools_image_no; else->R.string.tools_image_unknown }),style=MaterialTheme.typography.labelSmall)
                    }},onClick={vm.chooseModel(m.id);modelsExpanded=false}) }
                }
            }
        }
        if(!saved) Text(stringResource(R.string.tools_save_first),style=MaterialTheme.typography.labelSmall)
        state.latency?.let { Text(stringResource(R.string.tools_latency,it)) }
        TextButton(onClick=vm::probe,enabled=saved && profile?.hasToken==true) { Text(stringResource(R.string.tools_image_test)) }
        if(state.image!=null) Text(stringResource(R.string.tools_image_accepted))
        ErrorStatus(state.error)
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AssistantTools(sessionId: String?, selectedText: String, onInsert: (String,String)->Unit,
    onExecute: (String,String,()->Unit)->Unit, vm: AssistantViewModel = viewModel()) {
    var open by remember { mutableStateOf(false) }
    var target by remember { mutableStateOf<String?>(null) }
    var section by remember { mutableStateOf(0) }
    val state by vm.state.collectAsState()
    val clipboard=LocalClipboardManager.current
    var prompt by remember { mutableStateOf("") }
    var context by remember { mutableStateOf("") }
    var stream by remember { mutableStateOf(true) }
    var command by remember { mutableStateOf("") }
    var commandName by remember { mutableStateOf("") }
    var snippetId by remember { mutableStateOf<String?>(null) }
    var groupId by remember { mutableStateOf<String?>(null) }
    var groupName by remember { mutableStateOf("") }
    var editingGroupId by remember { mutableStateOf<String?>(null) }
    var search by remember { mutableStateOf("") }
    TextButton(onClick={target=sessionId;context="";open=true;vm.refresh()}) { Text(stringResource(R.string.tools_open)) }
    if(!open) return
    val canInsert=target!=null && target==sessionId
    AlertDialog(onDismissRequest={open=false},title={Text(stringResource(R.string.tools_open))},
        confirmButton={TextButton(onClick={open=false}) { Text(stringResource(R.string.tools_close)) }},
        text={ Column(Modifier.fillMaxWidth().heightIn(max=560.dp).verticalScroll(rememberScrollState()),verticalArrangement=Arrangement.spacedBy(8.dp)) {
            TabRow(selectedTabIndex=section) {
                listOf(R.string.tools_ai,R.string.tools_commands,R.string.tools_history).forEachIndexed { index,label ->
                    Tab(selected=section==index,onClick={section=index},text={Text(stringResource(label))})
                }
            }
            if(section==0) {
                if(state.profiles.isEmpty()) Text(stringResource(R.string.tools_configure_first))
                state.profiles.forEach { p -> Row {
                    RadioButton(selected=state.selected?.id==p.id,onClick={vm.select(p)})
                    Text(p.name+" · "+p.model,modifier=Modifier.weight(1f))
                } }
                OutlinedTextField(prompt,{prompt=it},label={Text(stringResource(R.string.tools_question))},modifier=Modifier.fillMaxWidth())
                TextButton(onClick={context=selectedText},enabled=selectedText.isNotBlank() && selectedText.length<=AiClient.CONTEXT_LIMIT) { Text(stringResource(R.string.tools_add_selection)) }
                if(selectedText.length>AiClient.CONTEXT_LIMIT) {
                    Text(stringResource(R.string.tools_context_length,selectedText.length))
                    ErrorStatus("context_limit")
                }
                if(context.isNotEmpty()) {
                    Text(stringResource(R.string.tools_context_length,context.length))
                    Text(context.take(500))
                    TextButton(onClick={context=""}) { Text(stringResource(R.string.tools_remove_context)) }
                }
                Row { Checkbox(stream,{stream=it}); Text(stringResource(R.string.tools_stream)) }
                FlowRow {
                    Button(onClick={vm.ask(prompt,context,stream)},enabled=state.selected?.hasToken==true && prompt.isNotBlank() && !state.busy) { Text(stringResource(R.string.tools_send)) }
                    TextButton(onClick=vm::stop,enabled=state.busy) { Text(stringResource(R.string.tools_stop)) }
                    TextButton(onClick=vm::clear) { Text(stringResource(R.string.tools_clear)) }
                }
                if(state.busy) LinearProgressIndicator(modifier=Modifier.fillMaxWidth())
                ErrorStatus(state.error)
                if(state.answer.isNotEmpty()) {
                    Text(state.answer)
                    TextButton(onClick={clipboard.setText(AnnotatedString(state.answer))}) { Text(stringResource(R.string.tools_copy)) }
                    Regex("```(?:bash|sh|shell|zsh|console|powershell|cmd)?[^\\n]*\\n([\\s\\S]*?)```",RegexOption.IGNORE_CASE)
                        .findAll(state.answer).map { it.groupValues[1].trimEnd('\n','\r') }.filter { it.isNotBlank() }.forEach { cmd ->
                            Text(cmd)
                            FlowRow {
                                TextButton(onClick={clipboard.setText(AnnotatedString(cmd))}) { Text(stringResource(R.string.tools_copy)) }
                                TextButton(onClick={target?.let { onInsert(it,cmd) }},enabled=canInsert && !state.busy) { Text(stringResource(R.string.tools_insert)) }
                            }
                        }
                }
            } else if(section==1) {
                OutlinedTextField(search,{search=it},label={Text(stringResource(R.string.tools_search))})
                state.snippets.filter { it.name.contains(search,true) || it.content.contains(search,true) }.forEach { row ->
                    FlowRow {
                        TextButton(onClick={snippetId=row.id;commandName=row.name;command=row.content;groupId=row.groupId}) { Text(row.name) }
                        TextButton(onClick={vm.deleteSnippet(row.id)}) { Text(stringResource(R.string.tools_delete)) }
                    }
                }
                TextButton(onClick={snippetId=null;commandName="";command="";groupId=null}) { Text(stringResource(R.string.tools_new_command)) }
                OutlinedTextField(commandName,{commandName=it},label={Text(stringResource(R.string.tools_name))})
                OutlinedTextField(command,{command=it},label={Text(stringResource(R.string.tools_command))},modifier=Modifier.fillMaxWidth())
                state.groups.forEach { group -> Row {
                    RadioButton(groupId==group.id,onClick={groupId=if(groupId==group.id)null else group.id})
                    TextButton(onClick={editingGroupId=group.id;groupName=group.name},modifier=Modifier.weight(1f)) { Text(group.name) }
                    TextButton(onClick={vm.deleteGroup(group.id);if(groupId==group.id)groupId=null}) { Text(stringResource(R.string.tools_delete)) }
                } }
                OutlinedTextField(groupName,{groupName=it},label={Text(stringResource(R.string.tools_group))})
                FlowRow {
                    TextButton(onClick={editingGroupId=null;groupName=""}) { Text(stringResource(R.string.tools_new_group)) }
                    TextButton(onClick={vm.saveGroup(editingGroupId,groupName);editingGroupId=null;groupName=""},enabled=groupName.isNotBlank()) { Text(stringResource(R.string.tools_save_group)) }
                }
                FlowRow {
                    Button(onClick={vm.saveSnippet(snippetId,commandName,command,groupId)},enabled=commandName.isNotBlank() && command.isNotBlank()) { Text(stringResource(R.string.tools_save)) }
                    TextButton(onClick={target?.let { onInsert(it,command.trimEnd('\r','\n')) }},enabled=canInsert && command.isNotBlank()) { Text(stringResource(R.string.tools_insert)) }
                }
                TextButton(onClick={val submitted=command;target?.let { onExecute(it,submitted) { vm.recordSubmittedCommand(submitted) } }},enabled=canInsert && command.isNotBlank()) { Text(stringResource(R.string.tools_execute)) }
                ErrorStatus(state.error)
            } else {
                Row { Checkbox(state.saveHistory,vm::historyEnabled); Text(stringResource(R.string.tools_record_history)) }
                Text(stringResource(R.string.tools_history_privacy))
                OutlinedTextField(search,{search=it},label={Text(stringResource(R.string.tools_search))})
                TextButton(onClick=vm::clearHistory) { Text(stringResource(R.string.tools_clear)) }
                state.history.filter { it.second.contains(search,true) }.forEach { row ->
                    Text(row.second)
                    TextButton(onClick={target?.let { onInsert(it,row.second.trimEnd('\r','\n')) }},enabled=canInsert) { Text(stringResource(R.string.tools_insert)) }
                }
            }
        } })
}
