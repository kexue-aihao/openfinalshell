package io.github.openfinalshell.android.tools

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import io.github.openfinalshell.android.core.ai.*
import io.github.openfinalshell.android.storage.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import java.util.UUID

data class AssistantState(
    val profiles: List<AiProfile> = emptyList(), val selected: AiProfile? = null,
    val models: List<AiModel> = emptyList(), val answer: String = "", val busy: Boolean = false,
    val error: String? = null, val latency: Long? = null, val image: String? = null,
    val snippets: List<CommandSnippetEntity> = emptyList(), val groups: List<CommandGroupEntity> = emptyList(),
    val history: List<Pair<String,String>> = emptyList(), val saveHistory: Boolean = false
)
class AssistantViewModel(app: Application): AndroidViewModel(app) {
    private val database = AppDatabase.create(app)
    private val repository = ToolRepository(database,AndroidCredentialStore(app,database))
    private val client = AiClient(repository::resolve)
    private val mutable = MutableStateFlow(AssistantState())
    val state: StateFlow<AssistantState> = mutable.asStateFlow()
    private var requestId: String? = null
    private var chatJob: Job? = null
    private var selectionEpoch = 0L
    private var initialSelection = true
    init { refresh() }
    private fun action(block: suspend () -> Unit) {
        val epoch=selectionEpoch
        viewModelScope.launch {
            try { block() } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if(epoch==selectionEpoch) mutable.update { it.copy(error = if(e is AiFailure) e.code else "operation_failed") } }
        }
    }
    fun refresh() = action {
        val profiles = repository.profiles()
        val historyFlag = database.documents().find("tools.history.enabled")?.json == "true"
        val snippets=repository.snippets(); val groups=repository.groups(); val history=repository.history()
        mutable.update { old -> old.copy(profiles=profiles,selected=profiles.find { it.id==old.selected?.id } ?: if(initialSelection) profiles.firstOrNull() else null,
            snippets=snippets,groups=groups,history=history,saveHistory=historyFlag) }
        initialSelection=false
    }
    fun select(profile: AiProfile?) { stop(); selectionEpoch++; initialSelection=false; mutable.update { it.copy(selected=profile, models=emptyList(),error=null,latency=null,image=null) } }
    fun save(name: String,url: String,model: String,token: String?,clear: Boolean=false) {
        val old=state.value.selected; val epoch=selectionEpoch
        action {
            val selected = repository.saveProfile(old,name,url,model,token,clear)
            val profiles=repository.profiles()
            mutable.update { if(epoch==selectionEpoch) it.copy(selected=selected,profiles=profiles,error=null,latency=null,image=null) else it.copy(profiles=profiles) }
        }
    }
    fun deleteProfile() {
        val profile=state.value.selected ?: return
        val epoch=selectionEpoch
        stop()
        action {
            repository.deleteProfile(profile.id)
            mutable.update { if(epoch==selectionEpoch) it.copy(selected=null,models=emptyList(),latency=null,image=null) else it }
            refresh()
        }
    }
    fun discover() = action {
        val profile=state.value.selected ?: return@action
        val models=withContext(Dispatchers.IO) { client.models(profile.id) }
        if(state.value.selected==profile) mutable.update { it.copy(models=models,error=null) }
    }
    fun chooseModel(model: String) {
        val old=state.value.selected ?: return; val epoch=selectionEpoch
        action {
            val updated=repository.saveProfile(old,old.name,old.baseUrl,model,null)
            val profiles=repository.profiles()
            mutable.update { if(epoch==selectionEpoch) it.copy(selected=updated,profiles=profiles,latency=null,image=null) else it.copy(profiles=profiles) }
        }
    }
    fun test() = action {
        val profile=state.value.selected ?: return@action
        val latency=withContext(Dispatchers.IO) { client.test(profile.id) }
        if(state.value.selected==profile) mutable.update { it.copy(latency=latency,error=null) }
    }
    fun probe() = action {
        val profile=state.value.selected ?: return@action
        val result=withContext(Dispatchers.IO) { client.probeImage(profile.id) }
        if(state.value.selected==profile) mutable.update { it.copy(image=result,error=null) }
    }
    fun ask(prompt: String,context: String,stream: Boolean) {
        val profile=state.value.selected ?: return
        stop()
        val id=UUID.randomUUID().toString(); requestId=id
        val text=if(context.isEmpty()) prompt else "$prompt\n\nUser-selected terminal context:\n$context"
        mutable.update { it.copy(busy=true,answer="",error=null) }
        chatJob=viewModelScope.launch {
            try {
                client.chat(id,profile.id,text,stream).collect { event ->
                    if(requestId==id && event is AiEvent.Delta) mutable.update { it.copy(answer=it.answer+event.text) }
                }
            } catch(e: CancellationException) { throw e }
            catch(e: Exception) { if(requestId==id) mutable.update { it.copy(error=if(e is AiFailure) e.code else "network") } }
            finally { if(requestId==id) { requestId=null; mutable.update { it.copy(busy=false) } } }
        }
    }
    fun stop() { requestId?.let(client::cancel); requestId=null; chatJob?.cancel(); chatJob=null; mutable.update { it.copy(busy=false) } }
    fun clear() { stop(); mutable.update { it.copy(answer="",error=null) } }
    fun saveSnippet(id: String?,name: String,command: String,group: String?) = action {
        repository.saveSnippet(id,name,command,group); refresh()
    }
    fun deleteSnippet(id: String) = action { repository.deleteSnippet(id); refresh() }
    fun saveGroup(id: String?,name: String) = action { repository.saveGroup(id,name); refresh() }
    fun deleteGroup(id: String) = action { repository.deleteGroup(id); refresh() }
    fun historyEnabled(enabled: Boolean) = action {
        database.documents().upsert(DocumentEntity("tools.history.enabled",enabled.toString()))
        mutable.update { it.copy(saveHistory=enabled) }
    }
    fun recordSubmittedCommand(command: String) = action { if(state.value.saveHistory) { repository.recordCommand(command); refresh() } }
    fun clearHistory() = action { repository.clearHistory(); refresh() }
    override fun onCleared() { stop(); client.close(); database.close() }
}
