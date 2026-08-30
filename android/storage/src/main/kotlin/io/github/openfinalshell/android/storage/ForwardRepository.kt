package io.github.openfinalshell.android.storage

import io.github.openfinalshell.android.core.model.ForwardRule

class ForwardRepository(private val dao: ForwardDao) {
    suspend fun list(): List<ForwardRule> = dao.list().map {
        ForwardRule(it.id, it.profileId, it.type, it.label, it.bindAddr, it.bindPort, it.dstHost, it.dstPort, it.autoStart)
    }

    suspend fun upsert(rule: ForwardRule) {
        dao.upsert(
            ForwardEntity(
                id = rule.id,
                profileId = rule.profileId,
                type = rule.type,
                label = rule.label,
                bindAddr = rule.bindAddr,
                bindPort = rule.bindPort,
                dstHost = rule.dstHost,
                dstPort = rule.dstPort,
                autoStart = rule.autoStart
            )
        )
    }
}
