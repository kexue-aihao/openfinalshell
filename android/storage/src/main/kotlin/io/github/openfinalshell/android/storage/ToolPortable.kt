package io.github.openfinalshell.android.storage

import kotlinx.serialization.json.*
import java.util.UUID

/** Only command library data is portable. AI profiles, tokens and history never enter this graph. */
object ToolPortable {
    suspend fun export(dao: ToolDao?): JsonObject {
        if(dao==null) return JsonObject(emptyMap())
        val snippets=dao.snippets(); val groups=dao.groups().toMutableList()
        var ungrouped="android-ungrouped"
        while(groups.any { it.id==ungrouped }) ungrouped+="-1"
        if(snippets.any { it.groupId==null }) groups.add(CommandGroupEntity(ungrouped,"Commands"))
        return buildJsonObject {
            put("snippetGroups",JsonArray(groups.map { group -> buildJsonObject {
                put("id",group.id);put("name",group.name);put("order",group.sortOrder)
            } }))
            put("snippets",JsonArray(snippets.mapIndexed { index,row -> buildJsonObject {
                put("id",row.id);put("groupId",row.groupId ?: ungrouped);put("name",row.name)
                put("command",row.content);put("autoEnter",false);put("order",index)
            } }))
        }
    }
    data class Result(val applied: Int=0,val skipped: Int=0,val invalid: Int=0)
    suspend fun import(root: JsonObject, dao: ToolDao?, conflict: ImportConflict): Result {
        if(dao==null) return Result()
        val mapped=mutableMapOf<String,String>()
        val groups=dao.groups().associateBy { it.id };val snippets=dao.snippets().associateBy { it.id }
        var skipped=0;var invalid=0;var applied=0
        require((root["snippetGroups"] as? JsonArray).orEmpty().size<=10000 && (root["snippets"] as? JsonArray).orEmpty().size<=10000) { "command library limit" }
        fun text(obj: JsonObject,key: String,max: Int): String? = (obj[key] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotBlank() && it.length<=max && !it.contains('\u0000') }
        for(element in (root["snippetGroups"] as? JsonArray).orEmpty().take(10000)) {
            val obj=element as? JsonObject
            if(obj==null) { invalid++;continue }
            val id=text(obj,"id",200);val name=text(obj,"name",200)
            if(id==null || name==null) { invalid++;continue }
            if(conflict==ImportConflict.SKIP && id in groups) { mapped[id]=id;skipped++;continue }
            val target=if(conflict==ImportConflict.DUPLICATE) UUID.randomUUID().toString() else id
            mapped[id]=target;dao.save(CommandGroupEntity(target,name,(obj["order"] as? JsonPrimitive)?.intOrNull ?: 0))
        }
        for(element in (root["snippets"] as? JsonArray).orEmpty().take(10000)) {
            val obj=element as? JsonObject
            if(obj==null) { invalid++;continue }
            val id=text(obj,"id",200);val name=text(obj,"name",200);val command=text(obj,"command",32768)
            if(id==null || name==null || command==null) { invalid++;continue }
            if(conflict==ImportConflict.SKIP && id in snippets) { skipped++;continue }
            val target=if(conflict==ImportConflict.DUPLICATE) UUID.randomUUID().toString() else id
            val group=text(obj,"groupId",200)?.let { mapped[it] ?: it.takeIf { key -> key in groups } }
            dao.save(CommandSnippetEntity(target,name,command,group,System.currentTimeMillis()));applied++
        }
        return Result(applied,skipped,invalid)
    }
}
