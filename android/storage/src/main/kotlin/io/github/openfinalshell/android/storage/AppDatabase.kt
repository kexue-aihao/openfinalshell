package io.github.openfinalshell.android.storage

import android.content.Context
import androidx.room.Database
import androidx.room.migration.Migration
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.sqlite.db.SupportSQLiteDatabase

@Database(
    entities = [
        ProfileEntity::class,
        SecretEntity::class,
        PrivateKeyEntity::class,
        ForwardEntity::class,
        ConnectionGroupEntity::class,
        SavedProxyEntity::class,
        KnownHostEntity::class,
        DocumentEntity::class
    ],
    version = 3,
    exportSchema = true
)
abstract class AppDatabase : RoomDatabase() {
    abstract fun profiles(): ProfileDao
    abstract fun secrets(): SecretDao
    abstract fun privateKeys(): PrivateKeyDao
    abstract fun forwards(): ForwardDao
    abstract fun groups(): ConnectionGroupDao
    abstract fun proxies(): SavedProxyDao
    abstract fun knownHosts(): KnownHostDao
    abstract fun documents(): DocumentDao

    companion object {
        /**
         * Migrates databases created by the original four-table schema.
         *
         * Room validates the complete schema after a migration. Adding a NOT NULL column with
         * ALTER TABLE leaves a SQLite default in PRAGMA table_info, which differs from Room's
         * entity schema (the Kotlin property default is not a SQL default). Rebuilding the two
         * affected tables preserves the data and produces the exact schema Room expects.
         */
        val MIGRATION_1_2: Migration = object : Migration(1, 2) {
            override fun migrate(database: SupportSQLiteDatabase) {
                rebuildProfiles(database)
                rebuildPrivateKeys(database)
                createAdditionalTables(database)
            }
        }

        /** Repairs databases that passed through the previous version-2 migration. */
        val MIGRATION_2_3: Migration = object : Migration(2, 3) {
            override fun migrate(database: SupportSQLiteDatabase) {
                rebuildProfiles(database)
                rebuildPrivateKeys(database)
                createAdditionalTables(database)
            }
        }

        fun create(context: Context): AppDatabase =
            Room.databaseBuilder(context, AppDatabase::class.java, "openfinalshell.db")
                .addMigrations(MIGRATION_1_2)
                .addMigrations(MIGRATION_2_3)
                .build()

        private fun rebuildProfiles(database: SupportSQLiteDatabase) {
            if (!hasTable(database, "profiles")) return
            database.execSQL("DROP TABLE IF EXISTS `profiles_new`")
            database.execSQL(
                """CREATE TABLE `profiles_new` (
                    `id` TEXT NOT NULL,
                    `name` TEXT NOT NULL,
                    `host` TEXT NOT NULL,
                    `port` INTEGER NOT NULL,
                    `username` TEXT NOT NULL,
                    `authMethod` TEXT NOT NULL,
                    `passwordRef` TEXT,
                    `privateKeyId` TEXT,
                    `passphraseRef` TEXT,
                    `proxyJson` TEXT,
                    `profileJson` TEXT,
                    `protocol` TEXT NOT NULL,
                    `groupId` TEXT,
                    `color` TEXT,
                    `flag` TEXT,
                    `terminalJson` TEXT,
                    `optionsJson` TEXT,
                    `proxyMode` TEXT,
                    `proxyId` TEXT,
                    `jumpHostId` TEXT,
                    `note` TEXT,
                    `createdAt` INTEGER NOT NULL,
                    `updatedAt` INTEGER NOT NULL,
                    `lastUsedAt` INTEGER,
                    PRIMARY KEY(`id`)
                )"""
            )
            val columns = listOf(
                "id", "name", "host", "port", "username", "authMethod", "passwordRef", "privateKeyId",
                "passphraseRef", "proxyJson", "profileJson", "protocol", "groupId", "color", "flag",
                "terminalJson", "optionsJson", "proxyMode", "proxyId", "jumpHostId", "note", "createdAt",
                "updatedAt", "lastUsedAt"
            )
            val select = columns.joinToString(", ") { column ->
                when {
                    hasColumn(database, "profiles", column) && column == "protocol" ->
                        "COALESCE(`$column`, 'ssh')"
                    hasColumn(database, "profiles", column) && (column == "createdAt" || column == "updatedAt") ->
                        "COALESCE(`$column`, 0)"
                    hasColumn(database, "profiles", column) -> "`$column`"
                    column == "protocol" -> "'ssh'"
                    column == "createdAt" || column == "updatedAt" -> "0"
                    else -> "NULL"
                }
            }
            database.execSQL("INSERT INTO `profiles_new` (${columns.joinToString(", ") { "`$it`" }}) SELECT $select FROM `profiles`")
            database.execSQL("DROP TABLE `profiles`")
            database.execSQL("ALTER TABLE `profiles_new` RENAME TO `profiles`")
        }

        private fun rebuildPrivateKeys(database: SupportSQLiteDatabase) {
            if (!hasTable(database, "private_keys")) return
            database.execSQL("DROP TABLE IF EXISTS `private_keys_new`")
            database.execSQL(
                """CREATE TABLE `private_keys_new` (
                    `id` TEXT NOT NULL,
                    `name` TEXT NOT NULL,
                    `originalPath` TEXT,
                    `sha256` TEXT NOT NULL,
                    `passphraseRef` TEXT,
                    `materialRef` TEXT,
                    `createdAt` INTEGER NOT NULL,
                    `updatedAt` INTEGER NOT NULL,
                    PRIMARY KEY(`id`)
                )"""
            )
            val updatedAt = if (hasColumn(database, "private_keys", "updatedAt")) "COALESCE(`updatedAt`, 0)" else "0"
            database.execSQL(
                """INSERT INTO `private_keys_new`
                    (`id`, `name`, `originalPath`, `sha256`, `passphraseRef`, `materialRef`, `createdAt`, `updatedAt`)
                    SELECT `id`, `name`, `originalPath`, `sha256`, `passphraseRef`, `materialRef`, `createdAt`, $updatedAt
                    FROM `private_keys`"""
            )
            database.execSQL("DROP TABLE `private_keys`")
            database.execSQL("ALTER TABLE `private_keys_new` RENAME TO `private_keys`")
        }

        private fun createAdditionalTables(database: SupportSQLiteDatabase) {
            database.execSQL(
                """CREATE TABLE IF NOT EXISTS `connection_groups` (
                    `id` TEXT NOT NULL PRIMARY KEY,
                    `name` TEXT NOT NULL,
                    `parentId` TEXT,
                    `sortOrder` REAL NOT NULL
                )"""
            )
            database.execSQL(
                """CREATE TABLE IF NOT EXISTS `saved_proxies` (
                    `id` TEXT NOT NULL PRIMARY KEY,
                    `name` TEXT NOT NULL,
                    `type` TEXT NOT NULL,
                    `host` TEXT NOT NULL,
                    `port` INTEGER NOT NULL,
                    `username` TEXT,
                    `passwordRef` TEXT,
                    `createdAt` INTEGER NOT NULL,
                    `updatedAt` INTEGER NOT NULL
                )"""
            )
            database.execSQL(
                """CREATE TABLE IF NOT EXISTS `known_hosts` (
                    `key` TEXT NOT NULL PRIMARY KEY,
                    `keyType` TEXT NOT NULL,
                    `fingerprintSha256` TEXT NOT NULL,
                    `addedAt` INTEGER NOT NULL
                )"""
            )
            database.execSQL(
                """CREATE TABLE IF NOT EXISTS `documents` (
                    `name` TEXT NOT NULL PRIMARY KEY,
                    `json` TEXT NOT NULL
                )"""
            )
        }

        private fun hasTable(database: SupportSQLiteDatabase, table: String): Boolean {
            database.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1", arrayOf(table)).use {
                return it.moveToFirst()
            }
        }

        private fun hasColumn(database: SupportSQLiteDatabase, table: String, column: String): Boolean {
            database.query("PRAGMA table_info(`$table`)").use { cursor ->
                val nameIndex = cursor.getColumnIndex("name")
                if (nameIndex < 0) return false
                while (cursor.moveToNext()) {
                    if (cursor.getString(nameIndex) == column) return true
                }
            }
            return false
        }
    }
}
