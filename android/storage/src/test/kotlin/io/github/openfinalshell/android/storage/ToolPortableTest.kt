package io.github.openfinalshell.android.storage

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class ToolPortableTest {
    private class Memory: ToolDao {
        val p=mutableMapOf<String,AiProfileEntity>()
        val s=mutableMapOf<String,CommandSnippetEntity>()
        val g=mutableMapOf<String,CommandGroupEntity>()
        val h=mutableMapOf<String,CommandHistoryEntity>()
        override suspend fun profiles()=p.values.toList()
        override suspend fun profile(id:String)=p[id]
        override suspend fun save(profile:AiProfileEntity) { p[profile.id]=profile }
        override suspend fun deleteProfile(id:String) { p.remove(id) }
        override suspend fun snippets()=s.values.toList()
        override suspend fun save(snippet:CommandSnippetEntity) { s[snippet.id]=snippet }
        override suspend fun deleteSnippet(id:String) { s.remove(id) }
        override suspend fun groups()=g.values.toList()
        override suspend fun save(group:CommandGroupEntity) { g[group.id]=group }
        override suspend fun deleteGroup(id:String) { g.remove(id) }
        override suspend fun ungroup(id:String) { s.replaceAll { _,row->if(row.groupId==id)row.copy(groupId=null) else row } }
        override suspend fun history()=h.values.toList()
        override suspend fun save(history:CommandHistoryEntity) { h[history.id]=history }
        override suspend fun deleteHistory(id:String) { h.remove(id) }
    }
    @Test fun goldenDesktopCommandsRoundTripAndDuplicateRemapsGroup() = runBlocking {
        val path=listOf(File("../../shared-schema/fixtures/command-library.json"),File("shared-schema/fixtures/command-library.json")).first { it.exists() }
        val root=Json.parseToJsonElement(path.readText()).jsonObject
        val dao=Memory()
        assertEquals(1,ToolPortable.import(root,dao,ImportConflict.SKIP).applied)
        assertEquals(root,ToolPortable.export(dao))
        assertEquals(0,ToolPortable.import(root,dao,ImportConflict.SKIP).applied)
        assertEquals(1,ToolPortable.import(root,dao,ImportConflict.DUPLICATE).applied)
        val duplicate=dao.s.values.first { it.id!="fixture-command" }
        assertNotEquals("fixture-group",duplicate.groupId)
        assertEquals("维护工具",dao.g[duplicate.groupId]?.name)
    }
    @Test fun exportOmitsAiHistoryAndAvoidsSyntheticGroupCollision() = runBlocking {
        val dao=Memory()
        dao.save(AiProfileEntity("ai","ai","https://example.com/v1","m",true,"SECRET-REFERENCE",1))
        dao.save(CommandHistoryEntity("history","HISTORY-REFERENCE",1))
        dao.save(CommandGroupEntity("android-ungrouped","User group"))
        dao.save(CommandSnippetEntity("s","name","echo ok",null,1))
        val root=ToolPortable.export(dao)
        assertEquals(setOf("snippets","snippetGroups"),root.keys)
        assertFalse(root.toString().contains("SECRET-REFERENCE"))
        assertFalse(root.toString().contains("HISTORY-REFERENCE"))
        assertNotEquals("android-ungrouped",root["snippets"]!!.jsonArray.single().jsonObject["groupId"]!!.jsonPrimitive.content)
    }
    @Test fun invalidCommandsAreRejectedWithoutErasingExistingRows() = runBlocking {
        val dao=Memory()
        dao.save(CommandSnippetEntity("keep","keep","echo keep",null,1))
        val invalid=Json.parseToJsonElement("""{"snippets":[{"id":"bad","name":"bad","command":"\u0000"}]}""").jsonObject
        assertEquals(1,ToolPortable.import(invalid,dao,ImportConflict.OVERWRITE).invalid)
        assertEquals(setOf("keep"),dao.s.keys)
    }
}
